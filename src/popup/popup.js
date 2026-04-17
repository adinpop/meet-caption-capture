const statusEl = document.getElementById('status');
const meetingEl = document.getElementById('meeting-id');
const lineCountEl = document.getElementById('line-count');
const downloadBtn = document.getElementById('download');
const clearBtn = document.getElementById('clear');
const messageEl = document.getElementById('message');

function setMsg(text, kind) {
  messageEl.textContent = text || '';
  messageEl.className = kind || '';
}

function setStatus(label, cls) {
  statusEl.textContent = label;
  statusEl.className = 'status ' + cls;
}

async function getActiveMeetTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && tab.url.startsWith('https://meet.google.com/')) return tab;
  return null;
}

async function queryContent(tabId, type) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type });
  } catch (e) {
    return null;
  }
}

async function refresh() {
  const tab = await getActiveMeetTab();
  if (!tab) {
    setStatus('No Meet tab', 'status-idle');
    meetingEl.textContent = '—';
    lineCountEl.textContent = '0';
    return;
  }
  const state = await queryContent(tab.id, 'GET_STATE');
  if (!state) {
    setStatus('Content script not ready', 'status-idle');
    meetingEl.textContent = '—';
    lineCountEl.textContent = '0';
    return;
  }
  if (state.meetingId) {
    meetingEl.textContent = state.meetingId;
    if (state.recording) setStatus('Recording', 'status-recording');
    else setStatus('Waiting for captions', 'status-waiting');
    const res = await chrome.runtime.sendMessage({
      type: 'GET_TRANSCRIPT',
      meetingId: state.meetingId,
    });
    lineCountEl.textContent = String((res && res.lines ? res.lines.length : 0));
  } else {
    meetingEl.textContent = '—';
    setStatus('No active meeting', 'status-idle');
    lineCountEl.textContent = '0';
  }
}

downloadBtn.addEventListener('click', async () => {
  setMsg('');
  const tab = await getActiveMeetTab();
  if (!tab) {
    setMsg('Open a Google Meet tab first.', 'error');
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
  const tab = await getActiveMeetTab();
  if (!tab) return;
  const state = await queryContent(tab.id, 'GET_STATE');
  if (!state || !state.meetingId) return;
  if (!confirm(`Clear transcript for meeting ${state.meetingId}?`)) return;
  await chrome.runtime.sendMessage({ type: 'CLEAR', meetingId: state.meetingId });
  setMsg('Transcript cleared.', 'ok');
  refresh();
});

refresh();
setInterval(refresh, 1500);
