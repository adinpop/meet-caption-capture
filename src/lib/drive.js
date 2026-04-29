// Google Drive REST wrapper. Used only by the service worker.
//
// Auth: chrome.identity.getAuthToken caches the user's OAuth token. We refresh
// by clearing the cached token on 401 and asking again. The token is held in
// memory only (Chrome's identity layer caches; we never persist it).
//
// Scopes (declared in manifest.json):
//   - drive.file              -> create / read / update files this app made
//   - drive.metadata.readonly -> list folders for the picker (no content)

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const PAGE_SIZE = 100;

export class DriveError extends Error {
  constructor(message, { status, retryable, code } = {}) {
    super(message);
    this.name = 'DriveError';
    this.status = status || 0;
    this.code = code || null;
    this.retryable = !!retryable;
  }
}

// -------------------- token --------------------

export function getToken({ interactive = false } = {}) {
  return new Promise((resolve, reject) => {
    try {
      chrome.identity.getAuthToken({ interactive }, (token) => {
        const err = chrome.runtime.lastError;
        if (err || !token) {
          reject(new DriveError(err && err.message ? err.message : 'no token returned', { status: 401 }));
          return;
        }
        resolve(token);
      });
    } catch (e) {
      reject(new DriveError(String(e && e.message ? e.message : e)));
    }
  });
}

function removeCachedToken(token) {
  return new Promise((resolve) => {
    try {
      chrome.identity.removeCachedAuthToken({ token }, () => resolve());
    } catch (e) {
      resolve();
    }
  });
}

export async function revokeToken() {
  let token;
  try { token = await getToken({ interactive: false }); } catch (e) { return { ok: true, alreadyRevoked: true }; }
  try {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' });
  } catch (e) {}
  await removeCachedToken(token);
  return { ok: true };
}

export function getProfileEmail() {
  return new Promise((resolve) => {
    try {
      chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (info) => {
        resolve((info && info.email) || '');
      });
    } catch (e) {
      resolve('');
    }
  });
}

// -------------------- request core (with one auto-retry on 401) --------------------

async function authedFetch(url, init = {}, { interactive = false } = {}) {
  let token = await getToken({ interactive });
  let res = await fetch(url, withAuth(init, token));
  if (res.status === 401) {
    await removeCachedToken(token);
    token = await getToken({ interactive });
    res = await fetch(url, withAuth(init, token));
  }
  return res;
}

function withAuth(init, token) {
  const headers = Object.assign({}, init.headers || {}, { Authorization: `Bearer ${token}` });
  return Object.assign({}, init, { headers });
}

async function readJsonError(res) {
  try {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      return (parsed && parsed.error && parsed.error.message) || text.slice(0, 200);
    } catch {
      return text.slice(0, 200);
    }
  } catch {
    return '';
  }
}

// -------------------- folder operations --------------------

export async function getFolderMeta(folderId, { interactive = false } = {}) {
  if (!folderId) throw new DriveError('no folderId');
  const url = `${DRIVE_API}/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType,parents`;
  const res = await authedFetch(url, { method: 'GET' }, { interactive });
  if (!res.ok) {
    const detail = await readJsonError(res);
    throw new DriveError(`folder lookup failed (${res.status}): ${detail}`, { status: res.status });
  }
  const json = await res.json();
  if (json.mimeType !== FOLDER_MIME) {
    throw new DriveError('id refers to a file, not a folder', { status: 400 });
  }
  return { id: json.id, name: json.name, parents: json.parents || [] };
}

export async function listFolders(parentId, { interactive = false, pageToken } = {}) {
  const parent = parentId || 'root';
  const q = `'${parent}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`;
  const params = new URLSearchParams({
    q,
    fields: 'files(id,name,parents,modifiedTime),nextPageToken',
    orderBy: 'name',
    pageSize: String(PAGE_SIZE),
  });
  if (pageToken) params.set('pageToken', pageToken);
  const url = `${DRIVE_API}/files?${params.toString()}`;
  const res = await authedFetch(url, { method: 'GET' }, { interactive });
  if (!res.ok) {
    const detail = await readJsonError(res);
    throw new DriveError(`folder list failed (${res.status}): ${detail}`, { status: res.status });
  }
  const json = await res.json();
  return { folders: json.files || [], nextPageToken: json.nextPageToken || null };
}

// -------------------- file upload / update --------------------

function multipartBody(metadata, body, boundary, contentType) {
  const head =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${contentType}; charset=UTF-8\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  return head + body + tail;
}

export async function uploadMarkdown({ folderId, filename, body, fileId }, { interactive = false, contentType = 'text/markdown' } = {}) {
  if (!body || !body.length) throw new DriveError('empty body');

  if (fileId) {
    // Update existing file content. PATCH the upload endpoint.
    const url = `${DRIVE_UPLOAD}/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,webViewLink`;
    const res = await authedFetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': `${contentType}; charset=UTF-8` },
      body,
    }, { interactive });
    if (!res.ok) {
      const detail = await readJsonError(res);
      const retryable = res.status >= 500 && res.status < 600;
      throw new DriveError(`drive update failed (${res.status}): ${detail}`, { status: res.status, retryable });
    }
    const json = await res.json();
    return { fileId: json.id, name: json.name, webViewLink: json.webViewLink, updated: true };
  }

  if (!folderId) throw new DriveError('no folderId for new upload');
  if (!filename) throw new DriveError('no filename');

  // Multipart create.
  const boundary = `mcc-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const metadata = { name: filename, parents: [folderId], mimeType: contentType };
  const url = `${DRIVE_UPLOAD}?uploadType=multipart&fields=id,name,webViewLink`;
  const res = await authedFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: multipartBody(metadata, body, boundary, contentType),
  }, { interactive });
  if (!res.ok) {
    const detail = await readJsonError(res);
    const retryable = res.status >= 500 && res.status < 600;
    throw new DriveError(`drive upload failed (${res.status}): ${detail}`, { status: res.status, retryable });
  }
  const json = await res.json();
  return { fileId: json.id, name: json.name, webViewLink: json.webViewLink, updated: false };
}
