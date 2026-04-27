// Service worker (ES module).
//
// Captions pipeline (unchanged at the storage layer): content.js writes rolling
// lines to `transcript:<platform>:<meetingId>:<sessionId>` and meta to
// `meta:<platform>:<meetingId>:<sessionId>`. This worker builds Markdown,
// serves messages from popup/history/content.
//
// Audio pipeline (new in 0.6.0): popup asks to begin, worker grabs a tab
// stream via chrome.tabCapture and delegates capture to an offscreen document.
// Offscreen writes raw Opus/WebM chunks to IndexedDB (src/lib/audio-db.js) and
// notifies this worker per chunk. This worker is the only caller of Whisper
// (src/lib/whisper.js), the only reader of the API key, and the only writer of
// `audio_transcript:...` / `audio_meta:...` storage keys.

import { transcribeBlob, WhisperError } from '../lib/whisper.js';
import { listBySession, deleteChunk, deleteBySession, markFailed, markPending } from '../lib/audio-db.js';
import { summarize, SummaryError, DEFAULT_SUMMARY_SETTINGS, ALL_SECTIONS } from '../lib/summarize.js';
import {
  getToken as driveGetToken,
  revokeToken as driveRevokeToken,
  getProfileEmail as driveGetProfileEmail,
  listFolders as driveListFolders,
  getFolderMeta as driveGetFolderMeta,
  uploadMarkdown as driveUploadMarkdown,
  DriveError,
} from '../lib/drive.js';

const PREFIX_TX = 'transcript:';
const PREFIX_META = 'meta:';
const PREFIX_PARTIAL = 'partial:';
const PREFIX_AUDIO_TX = 'audio_transcript:';
const PREFIX_AUDIO_META = 'audio_meta:';
const PREFIX_SUMMARY = 'summary:';
const PREFIX_DRIVE_UPLOAD = 'driveUploads:';

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';

function keysFor(platform, meetingId, sessionId) {
  const base = `${platform || 'unknown'}:${meetingId}`;
  const suffix = sessionId ? `${base}:${sessionId}` : base;
  return {
    tx: PREFIX_TX + suffix,
    meta: PREFIX_META + suffix,
    partial: PREFIX_PARTIAL + suffix,
  };
}

function audioKeysFor(platform, meetingId, sessionId) {
  const suffix = `${platform || 'unknown'}:${meetingId}:${sessionId}`;
  return {
    tx: PREFIX_AUDIO_TX + suffix,
    meta: PREFIX_AUDIO_META + suffix,
  };
}

function summaryKey(platform, meetingId, sessionId) {
  const suffix = sessionId ? `${platform || 'unknown'}:${meetingId}:${sessionId}` : `${platform || 'unknown'}:${meetingId}`;
  return PREFIX_SUMMARY + suffix;
}

function driveUploadKey(platform, meetingId, sessionId) {
  const suffix = sessionId ? `${platform || 'unknown'}:${meetingId}:${sessionId}` : `${platform || 'unknown'}:${meetingId}`;
  return PREFIX_DRIVE_UPLOAD + suffix;
}

function splitSuffix(rest) {
  const parts = rest.split(':');
  if (parts.length === 0) return { platform: 'unknown', meetingId: rest, sessionId: null };
  if (parts.length === 1) return { platform: 'unknown', meetingId: parts[0], sessionId: null };
  if (parts.length === 2) return { platform: parts[0], meetingId: parts[1], sessionId: null };
  return { platform: parts[0], meetingId: parts[1], sessionId: parts.slice(2).join(':') };
}

// -------------------- message router --------------------

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || !msg.type) return;
  // offscreen-destined messages are handled inside the offscreen doc; ignore here
  if (msg.target === 'offscreen') return;

  const handle = (fn) => {
    fn().then((r) => reply(r)).catch((e) => reply({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  };

  switch (msg.type) {
    case 'GET_TRANSCRIPT':
      return handle(() => getTranscript(msg.platform, msg.meetingId, msg.sessionId).then((lines) => ({ lines })));
    case 'FINALIZE_AND_DOWNLOAD':
      return handle(() => finalizeAndDownload(msg.platform, msg.meetingId, msg.sessionId));
    case 'CLEAR':
      return handle(() => clearTranscript(msg.platform, msg.meetingId, msg.sessionId).then(() => ({ ok: true })));
    case 'CLEAR_ALL':
      return handle(() => clearAll().then((r) => ({ ok: true, ...r })));
    case 'LIST_MEETINGS':
      return handle(() => listMeetings().then((items) => ({ items })));
    case 'MARK_FINALIZED':
      return handle(() => markFinalized(msg.platform, msg.meetingId, msg.sessionId).then(() => ({ ok: true })));

    case 'BEGIN_AUDIO':
      return handle(() => beginAudio(msg));
    case 'END_AUDIO':
      return handle(() => endAudio(msg));
    case 'GET_AUDIO_STATE':
      return handle(() => getAudioState(msg));
    case 'RETRY_FAILED_CHUNKS':
      return handle(() => retryFailedChunks(msg));

    case 'AUDIO_CHUNK':
      return handle(() => onAudioChunk(msg));
    case 'AUDIO_STOPPED':
      return handle(() => onAudioStopped(msg));

    case 'SUMMARIZE_SESSION':
      return handle(() => summarizeSession(msg));
    case 'GET_SUMMARY':
      return handle(() => getSummary(msg));
    case 'DELETE_SUMMARY':
      return handle(() => deleteSummary(msg));

    case 'CONNECT_DRIVE':
      return handle(() => connectDrive(msg));
    case 'DISCONNECT_DRIVE':
      return handle(() => disconnectDrive());
    case 'GET_DRIVE_STATE':
      return handle(() => getDriveState(msg));
    case 'LIST_DRIVE_FOLDERS':
      return handle(() => listDriveFolders(msg));
    case 'SET_DRIVE_FOLDER':
      return handle(() => setDriveFolder(msg));
    case 'SET_DRIVE_AUTOSAVE':
      return handle(() => setDriveAutosave(msg));
    case 'SAVE_TO_DRIVE':
      return handle(() => saveToDrive(msg));
  }
});

// -------------------- captions storage --------------------

async function getTranscript(platform, meetingId, sessionId) {
  if (!meetingId) return [];
  const { tx } = keysFor(platform, meetingId, sessionId);
  const got = await chrome.storage.local.get(tx);
  return got[tx] || [];
}

async function clearTranscript(platform, meetingId, sessionId) {
  if (!meetingId) return;
  const { tx, meta, partial } = keysFor(platform, meetingId, sessionId);
  const { tx: atx, meta: ameta } = audioKeysFor(platform, meetingId, sessionId);
  const sKey = summaryKey(platform, meetingId, sessionId);
  const dKey = driveUploadKey(platform, meetingId, sessionId);
  await chrome.storage.local.remove([tx, meta, partial, atx, ameta, sKey, dKey]);
  if (sessionId) {
    try { await deleteBySession(sessionId); } catch (e) {}
  }
}

async function clearAll() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(
    (k) => k.startsWith(PREFIX_TX) ||
           k.startsWith(PREFIX_META) ||
           k.startsWith(PREFIX_PARTIAL) ||
           k.startsWith(PREFIX_AUDIO_TX) ||
           k.startsWith(PREFIX_AUDIO_META) ||
           k.startsWith(PREFIX_SUMMARY) ||
           k.startsWith(PREFIX_DRIVE_UPLOAD)
  );
  if (keys.length) await chrome.storage.local.remove(keys);
  // Wipe any orphan IDB chunks too. Best-effort.
  try {
    const sessions = new Set();
    for (const k of keys) {
      if (!k.startsWith(PREFIX_AUDIO_META) && !k.startsWith(PREFIX_META)) continue;
      const { sessionId } = splitSuffix(k.slice(k.indexOf(':') + 1));
      if (sessionId) sessions.add(sessionId);
    }
    for (const sid of sessions) await deleteBySession(sid);
  } catch (e) {}
  return { removed: keys.length };
}

async function markFinalized(platform, meetingId, sessionId) {
  if (!meetingId) return;
  const { meta } = keysFor(platform, meetingId, sessionId);
  const got = await chrome.storage.local.get(meta);
  const record = got[meta];
  if (!record) return;
  record.finalized = true;
  record.finalizedAt = Date.now();
  await chrome.storage.local.set({ [meta]: record });
}

async function listMeetings() {
  const all = await chrome.storage.local.get(null);
  const byKey = new Map(); // `${platform}:${meetingId}:${sessionId||''}` → row
  const touch = (platform, meetingId, sessionId, fields) => {
    const k = `${platform}:${meetingId}:${sessionId || ''}`;
    const existing = byKey.get(k) || {
      platform, meetingId, sessionId,
      lineCount: 0, audioLineCount: 0,
      meta: null, audioMeta: null,
      hasSummary: false, summaryGeneratedAt: null,
    };
    Object.assign(existing, fields);
    byKey.set(k, existing);
  };
  for (const key of Object.keys(all)) {
    if (key.startsWith(PREFIX_TX)) {
      const { platform, meetingId, sessionId } = splitSuffix(key.slice(PREFIX_TX.length));
      const metaKey = PREFIX_META + key.slice(PREFIX_TX.length);
      touch(platform, meetingId, sessionId, {
        lineCount: Array.isArray(all[key]) ? all[key].length : 0,
        meta: all[metaKey] || null,
      });
    } else if (key.startsWith(PREFIX_AUDIO_TX)) {
      const { platform, meetingId, sessionId } = splitSuffix(key.slice(PREFIX_AUDIO_TX.length));
      const aMetaKey = PREFIX_AUDIO_META + key.slice(PREFIX_AUDIO_TX.length);
      touch(platform, meetingId, sessionId, {
        audioLineCount: Array.isArray(all[key]) ? all[key].length : 0,
        audioMeta: all[aMetaKey] || null,
      });
    } else if (key.startsWith(PREFIX_SUMMARY)) {
      const { platform, meetingId, sessionId } = splitSuffix(key.slice(PREFIX_SUMMARY.length));
      const rec = all[key] || {};
      touch(platform, meetingId, sessionId, {
        hasSummary: true,
        summaryGeneratedAt: rec.generatedAt || null,
      });
    } else if (key.startsWith(PREFIX_DRIVE_UPLOAD)) {
      const { platform, meetingId, sessionId } = splitSuffix(key.slice(PREFIX_DRIVE_UPLOAD.length));
      const rec = all[key] || {};
      touch(platform, meetingId, sessionId, {
        driveUpload: rec || null,
      });
    }
  }
  return Array.from(byKey.values());
}

// -------------------- download --------------------

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function dateParts(d) {
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return { date: `${Y}-${M}-${D}`, time: `${h}${m}` };
}

function timeOfDay(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDuration(firstMs, lastMs) {
  if (!firstMs || !lastMs || lastMs <= firstMs) return '';
  const secs = Math.round((lastMs - firstMs) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const restSec = secs % 60;
  if (mins < 60) return `${mins}m ${restSec}s`;
  const hours = Math.floor(mins / 60);
  const restMin = mins % 60;
  return `${hours}h ${restMin}m`;
}

function yamlString(s) {
  return '"' + String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function renderSummarySections(summary) {
  if (!summary) return [];
  const enabled = Array.isArray(summary.enabled_sections) && summary.enabled_sections.length
    ? summary.enabled_sections
    : ALL_SECTIONS;
  const want = new Set(enabled);
  const out = [];
  const pushHeader = (h) => { out.push(h); out.push(''); };

  if (want.has('summary') && summary.summary) {
    pushHeader('## Summary');
    out.push(summary.summary.trim());
    out.push('');
  }
  if (want.has('topics') && Array.isArray(summary.topics) && summary.topics.length) {
    pushHeader('## Topics discussed');
    for (const t of summary.topics) out.push(`- ${t}`);
    out.push('');
  }
  if (want.has('decisions') && Array.isArray(summary.decisions) && summary.decisions.length) {
    pushHeader('## Decisions');
    for (const d of summary.decisions) out.push(`- ${d}`);
    out.push('');
  }
  if (want.has('actions') && Array.isArray(summary.actions) && summary.actions.length) {
    pushHeader('## Action items');
    for (const a of summary.actions) {
      const parts = [];
      if (a.owner) parts.push(`owner: ${a.owner}`);
      if (a.due) parts.push(`due: ${a.due}`);
      const meta = parts.length ? ` (${parts.join(', ')})` : '';
      out.push(`- [ ] ${a.task}${meta}`);
    }
    out.push('');
  }
  if (want.has('blind_spots') && Array.isArray(summary.blind_spots) && summary.blind_spots.length) {
    pushHeader('## Blind spots');
    for (const b of summary.blind_spots) out.push(`- ${b}`);
    out.push('');
  }
  if (want.has('opportunities') && Array.isArray(summary.opportunities) && summary.opportunities.length) {
    pushHeader('## Opportunities');
    for (const o of summary.opportunities) out.push(`- ${o}`);
    out.push('');
  }
  if (out.length) {
    const stamp = summary.generatedAt ? new Date(summary.generatedAt).toISOString() : '';
    if (stamp) {
      out.push(`*Summary generated ${stamp} by ${summary.model || 'OpenAI'}.*`);
      out.push('');
    }
  }
  return out;
}

function buildMarkdown(platform, meetingId, record, lines, audioLines, audioMeta, summary) {
  const start = record && record.firstSeenAt ? new Date(record.firstSeenAt)
              : audioMeta && audioMeta.startedAt ? new Date(audioMeta.startedAt)
              : new Date();
  const endMs = record && record.lastUpdatedAt ? record.lastUpdatedAt
              : audioMeta && (audioMeta.stoppedAt || audioMeta.lastUpdatedAt) ? (audioMeta.stoppedAt || audioMeta.lastUpdatedAt)
              : null;
  const end = endMs ? new Date(endMs) : null;
  const { date } = dateParts(start);
  const startTime = timeOfDay(start);
  const endTime = end ? timeOfDay(end) : '';
  const duration = record
    ? formatDuration(record.firstSeenAt, record.lastUpdatedAt)
    : audioMeta
      ? formatDuration(audioMeta.startedAt, audioMeta.stoppedAt || audioMeta.lastUpdatedAt)
      : '';
  const title = (record && record.title) || '';
  const rawNames =
    record && Array.isArray(record.participants) && record.participants.length > 0
      ? record.participants
      : extractParticipants(lines || []);
  const sourceNames = rawNames.filter((n) => n && !ICON_LIGATURE_RE.test(n));

  const out = [];
  out.push('---');
  out.push(`platform: ${platform || 'unknown'}`);
  out.push(`meeting_id: ${yamlString(meetingId)}`);
  if (title) out.push(`title: ${yamlString(title)}`);
  out.push(`date: ${date}`);
  out.push(`start_time: ${yamlString(startTime)}`);
  if (endTime) out.push(`end_time: ${yamlString(endTime)}`);
  if (duration) out.push(`duration: ${yamlString(duration)}`);
  if (sourceNames.length === 0) {
    out.push('participants: []');
  } else {
    out.push('participants:');
    for (const p of sourceNames) out.push(`  - ${yamlString(p)}`);
  }
  const sources = [];
  if (lines && lines.length > 0) sources.push('captions');
  if (audioLines && audioLines.length > 0) sources.push('whisper');
  if (summary) sources.push('summary');
  if (sources.length) out.push(`sources: [${sources.join(', ')}]`);
  out.push('---');
  out.push('');
  out.push(`# ${title || 'Meeting transcript'}`);
  out.push('');

  const summarySections = renderSummarySections(summary);
  if (summarySections.length) out.push(...summarySections);

  const LINE_RE = /^\[(\d{2}:\d{2}:\d{2})\]\s+([^:]+):\s*([\s\S]*)$/;

  if (lines && lines.length > 0) {
    out.push('## Captions transcript');
    out.push('');
    for (const line of lines) {
      const m = line.match(LINE_RE);
      if (m) out.push(`**[${m[1]}] ${m[2]}:** ${m[3]}`);
      else out.push(line);
      out.push('');
    }
  }

  if (audioLines && audioLines.length > 0) {
    out.push('## Audio transcript (Whisper)');
    out.push('');
    for (const line of audioLines) {
      const m = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s+([\s\S]*)$/);
      if (m) out.push(`**[${m[1]}]** ${m[2]}`);
      else out.push(line);
      out.push('');
    }
    if (audioMeta && audioMeta.failedChunks) {
      out.push(`> Note: ${audioMeta.failedChunks} audio chunk(s) failed to transcribe.`);
      out.push('');
    }
  }

  return out.join('\n');
}

const TRANSLIT = {
  'đ': 'd', 'Đ': 'D', 'ć': 'c', 'Ć': 'C', 'č': 'c', 'Č': 'C',
  'š': 's', 'Š': 'S', 'ž': 'z', 'Ž': 'Z',
};

function camelSanitize(name) {
  if (!name) return '';
  const translit = name.replace(/[đĐćĆčČšŠžŽ]/g, (c) => TRANSLIT[c] || c);
  const stripped = translit.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const words = stripped.split(/\s+/).filter(Boolean);
  const camel = words
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ''))
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  return camel.slice(0, 30);
}

const ICON_LIGATURE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

function extractParticipants(lines) {
  const seen = new Set();
  const ordered = [];
  for (const line of lines) {
    const m = line.match(/^\[\d{2}:\d{2}:\d{2}\]\s+([^:]+):/);
    if (!m) continue;
    const raw = m[1].trim();
    if (!raw || seen.has(raw)) continue;
    if (ICON_LIGATURE_RE.test(raw)) continue;
    seen.add(raw);
    ordered.push(raw);
  }
  return ordered;
}

function formatParticipants(participants, max = 3) {
  const cleaned = participants.map(camelSanitize).filter(Boolean);
  if (cleaned.length === 0) return 'unknown';
  if (cleaned.length <= max) return cleaned.join('-');
  return cleaned.slice(0, max).join('-') + `-and-${cleaned.length - max}-more`;
}

async function buildSessionArtifact(platform, meetingId, sessionId) {
  const { tx, meta } = keysFor(platform, meetingId, sessionId);
  const { tx: atx, meta: ameta } = audioKeysFor(platform, meetingId, sessionId);
  const sKey = summaryKey(platform, meetingId, sessionId);
  const got = await chrome.storage.local.get([tx, meta, atx, ameta, sKey]);
  const lines = got[tx] || [];
  const audioLines = got[atx] || [];
  const record = got[meta];
  const audioMeta = got[ameta];
  const summary = got[sKey] || null;
  if (lines.length === 0 && audioLines.length === 0) {
    return { ok: false, error: 'empty transcript' };
  }
  const body = buildMarkdown(platform, meetingId, record, lines, audioLines, audioMeta, summary) + '\n';
  const prefix = platform || 'meet';
  const start = (record && record.firstSeenAt) || (audioMeta && audioMeta.startedAt) || Date.now();
  const { date, time } = dateParts(new Date(start));
  const rawNames = record && Array.isArray(record.participants) && record.participants.length > 0
    ? record.participants
    : extractParticipants(lines);
  const sourceNames = rawNames.filter((n) => n && !ICON_LIGATURE_RE.test(n));
  const parts = formatParticipants(sourceNames);
  const filename = `${prefix}_${date}_${time}_${parts}_${meetingId}.md`;
  return {
    ok: true, body, filename, lineCount: lines.length, audioLineCount: audioLines.length,
    record, audioMeta, summary,
  };
}

async function finalizeAndDownload(platform, meetingId, sessionId) {
  if (!meetingId) return { ok: false, error: 'no meetingId' };
  const artifact = await buildSessionArtifact(platform, meetingId, sessionId);
  if (!artifact.ok) return artifact;

  const b64 = utf8ToBase64(artifact.body);
  const url = `data:text/markdown;charset=utf-8;base64,${b64}`;
  try {
    const id = await chrome.downloads.download({ url, filename: artifact.filename, saveAs: false });
    if (artifact.record) {
      const { meta } = keysFor(platform, meetingId, sessionId);
      artifact.record.downloadedAt = Date.now();
      await chrome.storage.local.set({ [meta]: artifact.record });
    }
    maybeAutoSummarize(platform, meetingId, sessionId);
    maybeAutoSaveToDrive(platform, meetingId, sessionId);
    return {
      ok: true,
      filename: artifact.filename,
      lineCount: artifact.lineCount,
      audioLineCount: artifact.audioLineCount,
      downloadId: id,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function maybeAutoSummarize(platform, meetingId, sessionId) {
  (async () => {
    try {
      const settings = await getSummarySettings();
      if (!settings.auto_run) return;
      const sKey = summaryKey(platform, meetingId, sessionId);
      const got = await chrome.storage.local.get(sKey);
      if (got && got[sKey]) return; // already summarized
      await summarizeSession({ platform, meetingId, sessionId });
    } catch (e) {}
  })();
}

// -------------------- google drive --------------------

async function getDriveSettings() {
  const got = await chrome.storage.local.get('driveSettings');
  return got && got.driveSettings ? got.driveSettings : { folderId: null, folderName: '', autoSave: true, connectedEmail: '' };
}

async function setDriveSettings(patch) {
  const cur = await getDriveSettings();
  const next = Object.assign({}, cur, patch);
  await chrome.storage.local.set({ driveSettings: next });
  return next;
}

async function connectDrive() {
  try {
    const token = await driveGetToken({ interactive: true });
    if (!token) return { ok: false, error: 'auth canceled' };
    let email = '';
    try { email = await driveGetProfileEmail(); } catch (e) {}
    const next = await setDriveSettings({ connectedEmail: email || '(connected)' });
    return { ok: true, settings: next };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'auth failed' };
  }
}

async function disconnectDrive() {
  try { await driveRevokeToken(); } catch (e) {}
  await setDriveSettings({ connectedEmail: '', folderId: null, folderName: '' });
  return { ok: true };
}

async function getDriveState() {
  const settings = await getDriveSettings();
  // Connected = we can get a token without prompting. Don't gate on
  // connectedEmail, which is sometimes empty on Chrome profiles where
  // getProfileUserInfo returns no email.
  let connected = false;
  try {
    const token = await driveGetToken({ interactive: false });
    if (token) connected = true;
  } catch (e) {
    connected = false;
  }
  // If we're connected but have no email recorded, opportunistically refresh.
  if (connected && !settings.connectedEmail) {
    try {
      const email = await driveGetProfileEmail();
      if (email) {
        await setDriveSettings({ connectedEmail: email });
        settings.connectedEmail = email;
      }
    } catch (e) {}
  }
  return { ok: true, settings, connected };
}

async function listDriveFolders({ parentId, pageToken }) {
  try {
    const result = await driveListFolders(parentId || null, { pageToken });
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'list failed', status: e && e.status };
  }
}

async function setDriveFolder({ folderId }) {
  if (!folderId) {
    await setDriveSettings({ folderId: null, folderName: '' });
    return { ok: true, settings: await getDriveSettings() };
  }
  try {
    const meta = await driveGetFolderMeta(folderId);
    const next = await setDriveSettings({ folderId: meta.id, folderName: meta.name });
    return { ok: true, settings: next };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'folder check failed' };
  }
}

async function setDriveAutosave({ enabled }) {
  const next = await setDriveSettings({ autoSave: !!enabled });
  return { ok: true, settings: next };
}

async function getDriveUpload(platform, meetingId, sessionId) {
  const k = driveUploadKey(platform, meetingId, sessionId);
  const got = await chrome.storage.local.get(k);
  return got[k] || null;
}

async function setDriveUpload(platform, meetingId, sessionId, value) {
  const k = driveUploadKey(platform, meetingId, sessionId);
  await chrome.storage.local.set({ [k]: value });
}

async function saveToDrive({ platform, meetingId, sessionId }) {
  if (!meetingId || !sessionId) return { ok: false, error: 'no session' };
  const settings = await getDriveSettings();
  if (!settings.folderId) {
    return { ok: false, error: 'no Drive folder selected. open Options to pick one.' };
  }
  const artifact = await buildSessionArtifact(platform, meetingId, sessionId);
  if (!artifact.ok) return artifact;

  const existing = await getDriveUpload(platform, meetingId, sessionId);
  let result;
  let attempts = (existing && existing.attempts) || 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    attempts++;
    try {
      result = await driveUploadMarkdown({
        folderId: settings.folderId,
        filename: artifact.filename,
        body: artifact.body,
        fileId: existing && existing.fileId ? existing.fileId : null,
      });
      break;
    } catch (e) {
      const retryable = e instanceof DriveError && e.retryable;
      if (retryable && attempt === 0) {
        await sleep(750);
        continue;
      }
      // Persist failure for visibility
      await setDriveUpload(platform, meetingId, sessionId, Object.assign({}, existing || {}, {
        platform, meetingId, sessionId,
        lastError: (e && e.message) || 'drive upload failed',
        lastAttemptAt: Date.now(),
        attempts,
      }));
      return { ok: false, error: (e && e.message) || 'drive upload failed' };
    }
  }

  await setDriveUpload(platform, meetingId, sessionId, {
    platform, meetingId, sessionId,
    fileId: result.fileId,
    fileName: result.name,
    webViewLink: result.webViewLink,
    folderId: settings.folderId,
    uploadedAt: Date.now(),
    lastAttemptAt: Date.now(),
    attempts,
    byteSize: artifact.body.length,
    lastError: null,
  });
  return { ok: true, fileId: result.fileId, webViewLink: result.webViewLink, updated: !!result.updated };
}

function maybeAutoSaveToDrive(platform, meetingId, sessionId) {
  (async () => {
    try {
      const settings = await getDriveSettings();
      if (!settings || !settings.autoSave || !settings.folderId) return;
      // Verify silent token first; if not connected, do nothing.
      try { await driveGetToken({ interactive: false }); }
      catch (e) { return; }
      await saveToDrive({ platform, meetingId, sessionId });
    } catch (e) {}
  })();
}

// -------------------- audio pipeline --------------------

async function ensureOffscreen() {
  if (chrome.offscreen && typeof chrome.offscreen.hasDocument === 'function') {
    const exists = await chrome.offscreen.hasDocument();
    if (exists) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA'],
      justification: 'Capture active meeting tab audio for Whisper transcription',
    });
    return;
  }
  throw new Error('offscreen API unavailable');
}

async function closeOffscreen() {
  try {
    const exists = await chrome.offscreen.hasDocument();
    if (exists) await chrome.offscreen.closeDocument();
  } catch (e) {}
}

// Stop any active capture in the offscreen doc, close the doc, and give the
// browser a moment to release the underlying tabCapture stream before the
// next getMediaStreamId call.
async function cleanupOffscreen() {
  let hadDoc = false;
  try { hadDoc = await chrome.offscreen.hasDocument(); } catch (e) {}
  if (!hadDoc) return;
  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP_CAPTURE' });
  } catch (e) {}
  await closeOffscreen();
  // Brief delay; empirically Chrome needs a tick before it will hand out a
  // fresh streamId for the same tab.
  await new Promise((r) => setTimeout(r, 250));
}

async function getAudioMeta(platform, meetingId, sessionId) {
  const { meta } = audioKeysFor(platform, meetingId, sessionId);
  const got = await chrome.storage.local.get(meta);
  return got[meta] || null;
}

async function setAudioMeta(platform, meetingId, sessionId, value) {
  const { meta } = audioKeysFor(platform, meetingId, sessionId);
  await chrome.storage.local.set({ [meta]: value });
}

async function beginAudio({ tabId, platform, meetingId, sessionId }) {
  if (!tabId) return { ok: false, error: 'no tabId' };
  if (!meetingId) return { ok: false, error: 'no meetingId detected on this tab' };
  if (!sessionId) sessionId = String(Date.now());

  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) return { ok: false, error: 'no api key. open the extension options and save an OpenAI key.' };

  const existing = await getAudioMeta(platform, meetingId, sessionId);
  if (existing && existing.state === 'recording') {
    return { ok: false, error: 'already recording this session' };
  }

  // Tear down any leftover offscreen session. Chrome only allows one active
  // tabCapture stream per tab, so a stale stream held by a prior attempt
  // would make getMediaStreamId fail with "Cannot capture a tab with an
  // active stream."
  await cleanupOffscreen();

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (e) {
    return { ok: false, error: 'tab capture denied: ' + (e && e.message ? e.message : String(e)) };
  }
  if (!streamId) return { ok: false, error: 'no stream id from tab capture' };

  await ensureOffscreen();

  // Small delay so the offscreen doc is fully ready to receive messages.
  await new Promise((r) => setTimeout(r, 100));

  let res;
  try {
    res = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'START_CAPTURE',
      payload: { streamId, sessionId, platform, meetingId },
    });
  } catch (e) {
    await closeOffscreen();
    return { ok: false, error: 'offscreen not ready: ' + (e && e.message ? e.message : String(e)) };
  }

  if (!res || !res.ok) {
    await closeOffscreen();
    return { ok: false, error: (res && res.error) || 'offscreen refused' };
  }

  await setAudioMeta(platform, meetingId, sessionId, {
    platform, meetingId, sessionId,
    state: 'recording',
    startedAt: res.startedAt || Date.now(),
    stoppedAt: null,
    chunkCount: 0,
    failedChunks: 0,
    lastTail: '',
    lastError: null,
  });
  return { ok: true, sessionId };
}

async function endAudio({ platform, meetingId, sessionId }) {
  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP_CAPTURE' });
  } catch (e) {}
  const meta = await getAudioMeta(platform, meetingId, sessionId);
  if (meta) {
    meta.state = 'transcribing';
    meta.stoppedAt = Date.now();
    await setAudioMeta(platform, meetingId, sessionId, meta);
  }
  return { ok: true };
}

async function onAudioStopped({ platform, meetingId, sessionId, chunkCount, reason }) {
  await drain(platform, meetingId, sessionId);
  const meta = await getAudioMeta(platform, meetingId, sessionId);
  if (meta) {
    meta.state = 'idle';
    meta.stoppedAt = meta.stoppedAt || Date.now();
    meta.lastUpdatedAt = Date.now();
    if (reason && reason !== 'user') meta.lastError = meta.lastError || `stopped: ${reason}`;
    await setAudioMeta(platform, meetingId, sessionId, meta);
  }
  await closeOffscreen();
  return { ok: true };
}

async function onAudioChunk({ platform, meetingId, sessionId, chunkIndex }) {
  // Best-effort trigger the drain. The drain reads from IDB, so even if the
  // message bus hiccups, the chunk will be picked up next time.
  drain(platform, meetingId, sessionId).catch(() => {});
  return { ok: true };
}

const drainPromises = new Map(); // sessionId → Promise

async function drain(platform, meetingId, sessionId) {
  if (!sessionId) return;
  const existing = drainPromises.get(sessionId);
  if (existing) return existing;
  const p = (async () => {
    try {
      await processPendingChunks(platform, meetingId, sessionId);
    } finally {
      drainPromises.delete(sessionId);
    }
  })();
  drainPromises.set(sessionId, p);
  return p;
}

async function processPendingChunks(platform, meetingId, sessionId) {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  const rows = await listBySession(sessionId);
  const pending = rows.filter((r) => r.status === 'pending').sort((a, b) => a.chunkIndex - b.chunkIndex);
  if (pending.length === 0) return;

  if (!apiKey) {
    // Keep chunks as pending so retry is possible once the user saves a key.
    const m = await getAudioMeta(platform, meetingId, sessionId);
    if (m) {
      m.lastError = 'no api key configured';
      m.lastUpdatedAt = Date.now();
      await setAudioMeta(platform, meetingId, sessionId, m);
    }
    return;
  }

  for (const row of pending) {
    const meta = await getAudioMeta(row.platform, row.meetingId, row.sessionId);
    const prompt = (meta && meta.lastTail) || '';
    let result = null;
    let failedErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await transcribeBlob(apiKey, row.blob, { prompt });
        break;
      } catch (e) {
        failedErr = e;
        if (e instanceof WhisperError && e.retryable && attempt === 0) {
          await sleep(750);
          continue;
        }
        break;
      }
    }
    if (!result) {
      await markFailed(row.id, (failedErr && failedErr.message) || 'transcription failed');
      const m = await getAudioMeta(row.platform, row.meetingId, row.sessionId);
      if (m) {
        m.failedChunks = (m.failedChunks || 0) + 1;
        m.lastError = (failedErr && failedErr.message) || 'transcription failed';
        m.lastUpdatedAt = Date.now();
        await setAudioMeta(row.platform, row.meetingId, row.sessionId, m);
      }
      continue;
    }

    const text = (result.text || '').trim();
    if (!text) {
      await deleteChunk(row.id);
      continue;
    }

    const start = (meta && meta.startedAt) || Date.now();
    const d = new Date(start + (row.offsetMs || 0));
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const line = `[${hh}:${mm}:${ss}] ${text}`;

    const { tx, meta: metaKey } = audioKeysFor(row.platform, row.meetingId, row.sessionId);
    const got = await chrome.storage.local.get([tx, metaKey]);
    const lines = Array.isArray(got[tx]) ? got[tx].slice() : [];
    lines.push(line);
    const m = got[metaKey] || {
      platform: row.platform, meetingId: row.meetingId, sessionId: row.sessionId,
      state: 'transcribing', startedAt: start, stoppedAt: null,
      chunkCount: 0, failedChunks: 0, lastTail: '', lastError: null,
    };
    m.chunkCount = (m.chunkCount || 0) + 1;
    m.lastTail = text.slice(-80);
    m.lastUpdatedAt = Date.now();
    await chrome.storage.local.set({ [tx]: lines, [metaKey]: m });
    await deleteChunk(row.id);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getAudioState({ platform, meetingId, sessionId }) {
  // If the caller doesn't know the sessionId (common when audio started
  // without captions), look up the most recent recording session for this
  // meeting.
  if (!sessionId && platform && meetingId) {
    const prefix = PREFIX_AUDIO_META + `${platform}:${meetingId}:`;
    const all = await chrome.storage.local.get(null);
    let best = null;
    for (const key of Object.keys(all)) {
      if (!key.startsWith(prefix)) continue;
      const rec = all[key];
      if (!rec) continue;
      const score = rec.state === 'recording' ? 2 : rec.state === 'transcribing' ? 1 : 0;
      const ts = rec.lastUpdatedAt || rec.stoppedAt || rec.startedAt || 0;
      if (!best || score > best.score || (score === best.score && ts > best.ts)) {
        best = { rec, score, ts, sessionId: key.slice(prefix.length) };
      }
    }
    if (best) sessionId = best.sessionId;
  }
  if (!sessionId) return { ok: true, meta: null, pending: 0, failed: 0 };
  const meta = await getAudioMeta(platform, meetingId, sessionId);
  const rows = await listBySession(sessionId);
  const pending = rows.filter((r) => r.status === 'pending').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  return { ok: true, meta, pending, failed, sessionId };
}

async function retryFailedChunks({ sessionId }) {
  if (!sessionId) return { ok: false, error: 'no sessionId' };
  const rows = await listBySession(sessionId);
  const failed = rows.filter((r) => r.status === 'failed');
  // reset status so drain picks them up
  for (const r of failed) {
    try { await markPending(r.id); } catch (e) {}
  }
  if (failed.length > 0) {
    const first = failed[0];
    drain(first.platform, first.meetingId, sessionId).catch(() => {});
  }
  return { ok: true, retried: failed.length };
}

// -------------------- summarization --------------------

function buildTranscriptForSummary(captionLines, audioLines) {
  const out = [];
  if (captionLines && captionLines.length) {
    out.push('=== Captions transcript (with speaker labels) ===');
    out.push(...captionLines);
  }
  if (audioLines && audioLines.length) {
    if (out.length) out.push('');
    out.push('=== Audio transcript (Whisper; no speaker labels) ===');
    out.push(...audioLines);
  }
  return out.join('\n');
}

async function getSummarySettings() {
  const got = await chrome.storage.local.get('summarySettings');
  const stored = got && got.summarySettings ? got.summarySettings : {};
  return {
    enabled_sections: Array.isArray(stored.enabled_sections) ? stored.enabled_sections : DEFAULT_SUMMARY_SETTINGS.enabled_sections,
    model: stored.model || DEFAULT_SUMMARY_SETTINGS.model,
    prompt: stored.prompt || DEFAULT_SUMMARY_SETTINGS.prompt,
    auto_run: !!stored.auto_run,
  };
}

async function summarizeSession({ platform, meetingId, sessionId }) {
  if (!meetingId) return { ok: false, error: 'no meetingId' };
  const { tx, meta } = keysFor(platform, meetingId, sessionId);
  const { tx: atx } = audioKeysFor(platform, meetingId, sessionId);
  const got = await chrome.storage.local.get([tx, meta, atx]);
  const captionLines = got[tx] || [];
  const audioLines = got[atx] || [];
  if (captionLines.length === 0 && audioLines.length === 0) {
    return { ok: false, error: 'no transcript to summarize yet' };
  }

  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) return { ok: false, error: 'no api key. open Options and save an OpenAI key.' };

  const settings = await getSummarySettings();
  const transcript = buildTranscriptForSummary(captionLines, audioLines);

  let result;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await summarize(apiKey, transcript, { prompt: settings.prompt, model: settings.model });
        break;
      } catch (e) {
        if (e instanceof SummaryError && e.retryable && attempt === 0) {
          await sleep(750);
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'summary failed' };
  }

  const record = {
    platform, meetingId, sessionId,
    generatedAt: Date.now(),
    model: settings.model,
    enabled_sections: settings.enabled_sections,
    summary: result.summary,
    topics: result.topics,
    decisions: result.decisions,
    actions: result.actions,
    blind_spots: result.blind_spots,
    opportunities: result.opportunities,
    sourceMeta: {
      captionLineCount: captionLines.length,
      audioLineCount: audioLines.length,
      title: (got[meta] && got[meta].title) || '',
    },
  };
  await chrome.storage.local.set({ [summaryKey(platform, meetingId, sessionId)]: record });
  return { ok: true, summary: record };
}

async function getSummary({ platform, meetingId, sessionId }) {
  const key = summaryKey(platform, meetingId, sessionId);
  const got = await chrome.storage.local.get(key);
  return { ok: true, summary: got[key] || null };
}

async function deleteSummary({ platform, meetingId, sessionId }) {
  const key = summaryKey(platform, meetingId, sessionId);
  await chrome.storage.local.remove(key);
  return { ok: true };
}

// On SW wake, attempt to drain any sessions that have pending chunks left
// behind (e.g., the SW was killed mid-drain).
async function bootstrapPendingDrains() {
  try {
    const all = await chrome.storage.local.get(null);
    const metaKeys = Object.keys(all).filter((k) => k.startsWith(PREFIX_AUDIO_META));
    for (const k of metaKeys) {
      const meta = all[k];
      if (!meta || !meta.sessionId) continue;
      const rows = await listBySession(meta.sessionId);
      if (rows.some((r) => r.status === 'pending')) {
        drain(meta.platform, meta.meetingId, meta.sessionId).catch(() => {});
      }
    }
  } catch (e) {}
}

bootstrapPendingDrains();
