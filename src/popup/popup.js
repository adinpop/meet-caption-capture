const statusEl = document.getElementById('status');
const meetingEl = document.getElementById('meeting-id');
const lineCountEl = document.getElementById('line-count');
const downloadBtn = document.getElementById('download');
const clearBtn = document.getElementById('clear');
const historyBtn = document.getElementById('history');
const messageEl = document.getElementById('message');

historyBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/history/history.html') });
});

function setMsg(text, kind) {
  messageEl.textContent = text || '';
  messageEl.className = kind || '';
}

function setStatus(label, cls) {
  statusEl.textContent = label;
  statusEl.className = 'status ' + cls;
}

const SUPPORTED_HOSTS = [
  'meet.google.com',
  'teams.microsoft.com',
  'teams.cloud.microsoft',
  'teams.live.com',
];

async function getActiveSupportedTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return null;
  try {
    const u = new URL(tab.url);
    if (SUPPORTED_HOSTS.includes(u.host)) return tab;
  } catch (e) {}
  return null;
}

async function queryContent(tabId, type) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type });
  } catch (e) {
    return null;
  }
}

function platformLabel(id) {
  if (id === 'meet') return 'Meet';
  if (id === 'teams') return 'Teams';
  return '';
}

async function refresh() {
  const tab = await getActiveSupportedTab();
  if (!tab) {
    setStatus('No meeting tab', 'status-idle');
    meetingEl.textContent = '—';
    lineCountEl.textContent = '0';
    return;
  }
  const state = await queryContent(tab.id, 'GET_STATE');
  if (!state) {
    setStatus('Waiting for captions', 'status-waiting');
    meetingEl.textContent = '—';
    lineCountEl.textContent = '0';
    setMsg('Turn on captions in the meeting. If you just installed or reloaded the extension, reload the tab once.', 'info');
    return;
  }
  const plat = platformLabel(state.platform);
  if (state.meetingId) {
    meetingEl.textContent = state.meetingId;
    if (state.recording) setStatus('Recording' + (plat ? ' on ' + plat : ''), 'status-recording');
    else setStatus('Waiting for captions', 'status-waiting');
    const res = await chrome.runtime.sendMessage({
      type: 'GET_TRANSCRIPT',
      platform: state.platform,
      meetingId: state.meetingId,
    });
    lineCountEl.textContent = String(res && res.lines ? res.lines.length : 0);
  } else {
    meetingEl.textContent = '—';
    setStatus('No active meeting', 'status-idle');
    lineCountEl.textContent = '0';
  }
}

downloadBtn.addEventListener('click', async () => {
  setMsg('');
  const tab = await getActiveSupportedTab();
  if (!tab) {
    setMsg('Open a Meet or Teams tab first.', 'error');
    return;
  }
  const state = await queryContent(tab.id, 'GET_STATE');
  if (!state || !state.meetingId) {
    setMsg('No active meeting.', 'error');
    return;
  }
  await queryContent(tab.id, 'FLUSH_NOW');
  const r = await chrome.runtime.sendMessage({
    type: 'FINALIZE_AND_DOWNLOAD',
    platform: state.platform,
    meetingId: state.meetingId,
  });
  if (r && r.ok) {
    setMsg(`Downloaded ${r.filename} (${r.lineCount} lines).`, 'ok');
  } else {
    setMsg('Download failed: ' + (r && r.error ? r.error : 'unknown'), 'error');
  }
  refresh();
});

clearBtn.addEventListener('click', async () => {
  setMsg('');
  const tab = await getActiveSupportedTab();
  if (!tab) return;
  const state = await queryContent(tab.id, 'GET_STATE');
  if (!state || !state.meetingId) return;
  if (!confirm(`Clear transcript for meeting ${state.meetingId}?`)) return;
  await chrome.runtime.sendMessage({
    type: 'CLEAR',
    platform: state.platform,
    meetingId: state.meetingId,
  });
  setMsg('Transcript cleared.', 'ok');
  refresh();
});

refresh();
setInterval(refresh, 1500);
