const hasKeyEl = document.getElementById('has-key');
const noKeyEl = document.getElementById('no-key');
const keyDisplayEl = document.getElementById('key-display');
const keyInputEl = document.getElementById('key-input');
const saveBtn = document.getElementById('save');
const removeBtn = document.getElementById('remove');
const statusEl = document.getElementById('status');

function setStatus(text, kind) {
  statusEl.textContent = text || '';
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function mask(key) {
  if (!key) return '—';
  const last4 = key.slice(-4);
  return `sk-...${last4}`;
}

async function render() {
  const got = await chrome.storage.local.get('apiKey');
  const key = got && got.apiKey;
  if (key) {
    hasKeyEl.hidden = false;
    noKeyEl.hidden = true;
    keyDisplayEl.textContent = mask(key);
  } else {
    hasKeyEl.hidden = true;
    noKeyEl.hidden = false;
    keyInputEl.value = '';
  }
}

async function validateKey(key) {
  const res = await fetch('https://api.openai.com/v1/models', {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` },
  });
  if (res.status === 200) return { ok: true };
  if (res.status === 401) return { ok: false, reason: 'Invalid key (401 unauthorized).' };
  if (res.status === 429) return { ok: false, reason: 'Rate-limited (429). Try again shortly.' };
  return { ok: false, reason: `Unexpected status ${res.status} ${res.statusText}.` };
}

saveBtn.addEventListener('click', async () => {
  const key = (keyInputEl.value || '').trim();
  if (!key) {
    setStatus('Paste a key first.', 'error');
    return;
  }
  if (!/^sk-[A-Za-z0-9_\-]{20,}$/.test(key)) {
    setStatus('That does not look like an OpenAI key. Expected to start with "sk-" followed by 20+ characters.', 'error');
    return;
  }
  saveBtn.disabled = true;
  setStatus('Validating key with OpenAI...', 'info');
  try {
    const result = await validateKey(key);
    if (!result.ok) {
      setStatus(result.reason, 'error');
      saveBtn.disabled = false;
      return;
    }
    await chrome.storage.local.set({ apiKey: key });
    setStatus('Key saved.', 'ok');
    keyInputEl.value = '';
    await render();
  } catch (e) {
    setStatus('Network error reaching api.openai.com. Check your connection.', 'error');
  } finally {
    saveBtn.disabled = false;
  }
});

removeBtn.addEventListener('click', async () => {
  if (!confirm('Remove the OpenAI API key from this device?')) return;
  await chrome.storage.local.remove('apiKey');
  setStatus('Key removed.', 'ok');
  await render();
});

render();

// -------------------- google drive --------------------

const driveDisconnectedEl = document.getElementById('drive-disconnected');
const driveConnectedEl = document.getElementById('drive-connected');
const driveEmailEl = document.getElementById('drive-email');
const driveFolderEl = document.getElementById('drive-folder');
const connectDriveBtn = document.getElementById('connect-drive');
const disconnectDriveBtn = document.getElementById('disconnect-drive');
const pickFolderBtn = document.getElementById('pick-folder');
const pickerEl = document.getElementById('drive-picker');
const pickerCrumbsEl = document.getElementById('picker-crumbs');
const pickerListEl = document.getElementById('picker-list');
const pickerCancelBtn = document.getElementById('picker-cancel');
const pickerSelectBtn = document.getElementById('picker-select');
const driveAutosaveEl = document.getElementById('drive-autosave');
const driveStatusEl = document.getElementById('drive-status');

let pickerStack = []; // array of {id, name}
let pickerLoading = false;

function setDriveStatus(text, kind) {
  driveStatusEl.textContent = text || '';
  driveStatusEl.className = 'status' + (kind ? ' ' + kind : '');
}

async function renderDriveSettings() {
  const r = await chrome.runtime.sendMessage({ type: 'GET_DRIVE_STATE' });
  const settings = (r && r.settings) || { folderId: null, folderName: '', autoSave: true, connectedEmail: '' };
  const connected = !!(r && r.connected);

  if (!connected) {
    driveDisconnectedEl.hidden = false;
    driveConnectedEl.hidden = true;
    return;
  }
  driveDisconnectedEl.hidden = true;
  driveConnectedEl.hidden = false;
  driveEmailEl.textContent = settings.connectedEmail || '(unknown account)';
  if (settings.folderId) {
    driveFolderEl.textContent = settings.folderName || settings.folderId;
  } else {
    driveFolderEl.textContent = '— No folder selected —';
  }
  driveAutosaveEl.checked = settings.autoSave !== false;
}

connectDriveBtn.addEventListener('click', async () => {
  setDriveStatus('Authorizing with Google...', 'info');
  const r = await chrome.runtime.sendMessage({ type: 'CONNECT_DRIVE' });
  if (r && r.ok) {
    setDriveStatus('Connected. Pick a folder to save transcripts to.', 'ok');
    await renderDriveSettings();
    // Auto-open the picker so the user has one continuous flow.
    if (!(r.settings && r.settings.folderId)) openPicker();
  } else {
    setDriveStatus('Could not connect: ' + (r && r.error ? r.error : 'unknown'), 'error');
    await renderDriveSettings();
  }
});

disconnectDriveBtn.addEventListener('click', async () => {
  if (!confirm('Disconnect Google Drive? Existing uploads in Drive are kept; auto-save will stop.')) return;
  await chrome.runtime.sendMessage({ type: 'DISCONNECT_DRIVE' });
  setDriveStatus('Disconnected.', 'ok');
  await renderDriveSettings();
});

driveAutosaveEl.addEventListener('change', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'SET_DRIVE_AUTOSAVE', enabled: driveAutosaveEl.checked });
  if (r && r.ok) setDriveStatus(driveAutosaveEl.checked ? 'Auto-save on.' : 'Auto-save off.', 'ok');
});

// -------- folder picker --------

function renderCrumbs() {
  pickerCrumbsEl.innerHTML = '';
  const all = [{ id: null, name: 'My Drive' }, ...pickerStack];
  all.forEach((node, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '/';
      pickerCrumbsEl.appendChild(sep);
    }
    if (i === all.length - 1) {
      const span = document.createElement('strong');
      span.textContent = node.name;
      pickerCrumbsEl.appendChild(span);
    } else {
      const a = document.createElement('a');
      a.textContent = node.name;
      a.addEventListener('click', () => {
        pickerStack = pickerStack.slice(0, i);
        loadCurrent();
      });
      pickerCrumbsEl.appendChild(a);
    }
  });
}

async function loadCurrent() {
  if (pickerLoading) return;
  pickerLoading = true;
  renderCrumbs();
  pickerListEl.innerHTML = '<li class="empty">Loading…</li>';
  const parentId = pickerStack.length ? pickerStack[pickerStack.length - 1].id : null;
  const r = await chrome.runtime.sendMessage({ type: 'LIST_DRIVE_FOLDERS', parentId });
  pickerLoading = false;
  if (!r || !r.ok) {
    pickerListEl.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Could not list folders: ' + ((r && r.error) || 'unknown');
    pickerListEl.appendChild(li);
    return;
  }
  pickerListEl.innerHTML = '';
  if (!r.folders || r.folders.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No subfolders. Click "Select this folder" to use the current folder.';
    pickerListEl.appendChild(li);
    return;
  }
  for (const f of r.folders) {
    const li = document.createElement('li');
    li.textContent = f.name;
    li.addEventListener('click', () => {
      pickerStack.push({ id: f.id, name: f.name });
      loadCurrent();
    });
    pickerListEl.appendChild(li);
  }
}

function openPicker() {
  pickerStack = [];
  pickerEl.hidden = false;
  loadCurrent();
  try { pickerEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
}

pickFolderBtn.addEventListener('click', openPicker);

pickerCancelBtn.addEventListener('click', () => {
  pickerEl.hidden = true;
  pickerStack = [];
});

pickerSelectBtn.addEventListener('click', async () => {
  const cur = pickerStack.length ? pickerStack[pickerStack.length - 1] : null;
  if (!cur) {
    setDriveStatus('Pick a folder first (or navigate into the one you want).', 'error');
    return;
  }
  const r = await chrome.runtime.sendMessage({ type: 'SET_DRIVE_FOLDER', folderId: cur.id });
  if (r && r.ok) {
    setDriveStatus(`Folder set: ${cur.name}.`, 'ok');
    pickerEl.hidden = true;
    pickerStack = [];
    await renderDriveSettings();
  } else {
    setDriveStatus('Could not set folder: ' + (r && r.error ? r.error : 'unknown'), 'error');
  }
});

renderDriveSettings();
