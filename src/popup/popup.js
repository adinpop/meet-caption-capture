const statusEl = document.getElementById('status');
const meetingEl = document.getElementById('meeting-id');
const lineCountEl = document.getElementById('line-count');
const audioStatusEl = document.getElementById('audio-status');
const toggleBtn = document.getElementById('toggle-capture');
const toggleAudioBtn = document.getElementById('toggle-audio');
const openOptionsBtn = document.getElementById('open-options');
const downloadBtn = document.getElementById('download');
const clearBtn = document.getElementById('clear');
const summarizeBtn = document.getElementById('summarize');
const saveDriveBtn = document.getElementById('save-drive');
const driveStatusEl = document.getElementById('drive-status');
const historyBtn = document.getElementById('history');
const messageEl = document.getElementById('message');

let lastState = null;
let lastAudio = null;
let lastApiKeyPresent = null;
let lastSummary = null;
let summarizing = false;
let lastDrive = null;     // { settings, connected }
let lastDriveUpload = null; // { fileId, webViewLink, uploadedAt, ... } or null
let drivePushing = false;

historyBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/history/history.html') });
});

openOptionsBtn.addEventListener('click', () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html') });
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

function setToggleButton(mode) {
  if (mode === 'stop') {
    toggleBtn.textContent = 'Stop capture';
    toggleBtn.className = 'primary stop';
    toggleBtn.disabled = false;
  } else if (mode === 'start') {
    toggleBtn.textContent = 'Start capture';
    toggleBtn.className = 'primary';
    toggleBtn.disabled = false;
  } else {
    toggleBtn.textContent = 'Start capture';
    toggleBtn.className = 'primary';
    toggleBtn.disabled = true;
  }
}

let audioButtonMode = 'disabled';
let audioButtonReason = '';

function setAudioButton(mode, info) {
  audioButtonMode = mode;
  audioButtonReason = info || '';
  if (mode === 'stop') {
    toggleAudioBtn.textContent = 'Stop audio';
    toggleAudioBtn.className = 'primary stop';
    toggleAudioBtn.disabled = false;
    toggleAudioBtn.removeAttribute('title');
  } else if (mode === 'start') {
    toggleAudioBtn.textContent = 'Record audio';
    toggleAudioBtn.className = 'primary';
    toggleAudioBtn.disabled = false;
    toggleAudioBtn.removeAttribute('title');
  } else if (mode === 'needs-key') {
    toggleAudioBtn.textContent = 'Record audio';
    toggleAudioBtn.className = 'primary';
    toggleAudioBtn.disabled = true;
    toggleAudioBtn.title = info || 'Set your OpenAI API key in Options first';
  } else {
    toggleAudioBtn.textContent = 'Record audio';
    toggleAudioBtn.className = 'primary';
    toggleAudioBtn.disabled = true;
    toggleAudioBtn.title = info || '';
  }
}

function renderDriveStatus() {
  const drive = lastDrive;
  if (!drive || !drive.connected) {
    driveStatusEl.textContent = 'not connected (open Options)';
    driveStatusEl.removeAttribute('title');
    return;
  }
  if (!drive.settings || !drive.settings.folderId) {
    driveStatusEl.textContent = `${drive.settings && drive.settings.connectedEmail ? drive.settings.connectedEmail + ' · ' : ''}no folder`;
    driveStatusEl.removeAttribute('title');
    return;
  }
  const upload = lastDriveUpload;
  if (drivePushing) {
    driveStatusEl.textContent = `${drive.settings.folderName} · uploading…`;
    return;
  }
  if (upload && upload.fileId) {
    const when = upload.uploadedAt ? new Date(upload.uploadedAt).toLocaleTimeString() : '';
    driveStatusEl.textContent = `${drive.settings.folderName} · saved ${when}`;
    if (upload.webViewLink) driveStatusEl.title = upload.webViewLink;
  } else {
    driveStatusEl.textContent = `${drive.settings.folderName} · pending`;
    driveStatusEl.removeAttribute('title');
  }
}

function setSaveDriveButton() {
  if (drivePushing) {
    saveDriveBtn.textContent = 'Saving to Drive…';
    saveDriveBtn.disabled = true;
    saveDriveBtn.removeAttribute('title');
    return;
  }
  if (!lastDrive || !lastDrive.connected) {
    saveDriveBtn.textContent = 'Connect Drive';
    saveDriveBtn.disabled = false;
    saveDriveBtn.title = 'Opens Options to authorize and pick a folder';
    return;
  }
  if (!lastDrive.settings.folderId) {
    saveDriveBtn.textContent = 'Pick Drive folder';
    saveDriveBtn.disabled = false;
    saveDriveBtn.title = 'Opens Options to choose a folder';
    return;
  }
  if (lastDriveUpload && lastDriveUpload.fileId) {
    saveDriveBtn.textContent = 'Re-save to Drive';
    saveDriveBtn.disabled = false;
    saveDriveBtn.title = lastDriveUpload.webViewLink || '';
    return;
  }
  saveDriveBtn.textContent = 'Save to Drive';
  saveDriveBtn.disabled = false;
  saveDriveBtn.removeAttribute('title');
}

function renderAudioStatus(audio, hasKey) {
  if (!hasKey) {
    audioStatusEl.textContent = 'no key — click Options';
    audioStatusEl.removeAttribute('title');
    return;
  }
  if (!audio || !audio.meta) {
    audioStatusEl.textContent = 'off';
    audioStatusEl.removeAttribute('title');
    return;
  }
  const m = audio.meta;
  const bits = [];
  bits.push(m.state || 'idle');
  if (m.chunkCount) bits.push(`${m.chunkCount} chunk${m.chunkCount === 1 ? '' : 's'}`);
  if (audio.pending) bits.push(`${audio.pending} pending`);
  if (audio.failed) bits.push(`${audio.failed} failed`);
  audioStatusEl.textContent = bits.join(' · ');
  if (m.lastError) audioStatusEl.title = 'last error: ' + m.lastError;
  else audioStatusEl.removeAttribute('title');
}

async function getApiKeyPresent() {
  try {
    const got = await chrome.storage.local.get('apiKey');
    return !!(got && got.apiKey);
  } catch (e) {
    return false;
  }
}

async function refreshDriveContext({ platform, meetingId, sessionId }) {
  try {
    lastDrive = await chrome.runtime.sendMessage({ type: 'GET_DRIVE_STATE' });
  } catch (e) {
    lastDrive = null;
  }
  lastDriveUpload = null;
  if (platform && meetingId && sessionId) {
    try {
      const got = await chrome.storage.local.get(`driveUploads:${platform}:${meetingId}:${sessionId}`);
      const k = `driveUploads:${platform}:${meetingId}:${sessionId}`;
      lastDriveUpload = got[k] || null;
    } catch (e) {}
  }
  renderDriveStatus();
  setSaveDriveButton();
}

async function refresh() {
  const tab = await getActiveSupportedTab();
  const hasKey = await getApiKeyPresent();
  lastApiKeyPresent = hasKey;

  if (!tab) {
    setStatus('No meeting tab', 'status-idle');
    meetingEl.textContent = '—';
    lineCountEl.textContent = '0';
    audioStatusEl.textContent = hasKey ? 'off' : 'no key — click Options';
    setToggleButton('disabled');
    if (!hasKey) setAudioButton('needs-key');
    else setAudioButton('disabled', 'Open a Meet or Teams tab first');
    lastState = null;
    lastAudio = null;
    lastSummary = null;
    updateSummarizeButton(0, hasKey);
    await refreshDriveContext({});
    return;
  }
  const state = await queryContent(tab.id, 'GET_STATE');
  if (!state) {
    setStatus('Waiting for captions', 'status-waiting');
    meetingEl.textContent = '—';
    lineCountEl.textContent = '0';
    setToggleButton('disabled');

    // Even without the content script, an audio session may already be
    // recording (captions-off scenario). Inspect the tab URL and ask the SW.
    let urlPlatform = null, urlMeetingId = null;
    try {
      const u = new URL(tab.url);
      if (u.host === 'meet.google.com') {
        urlPlatform = 'meet';
        const m = u.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/|$)/);
        urlMeetingId = m ? m[1] : null;
      } else if (u.host.startsWith('teams.')) {
        urlPlatform = 'teams';
        const thread = u.searchParams.get('threadId') || u.searchParams.get('context');
        if (thread) urlMeetingId = thread.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
      }
    } catch (e) {}

    let audio = null;
    if (urlPlatform && urlMeetingId) {
      audio = await chrome.runtime.sendMessage({
        type: 'GET_AUDIO_STATE',
        platform: urlPlatform,
        meetingId: urlMeetingId,
      });
    }
    lastAudio = audio;
    renderAudioStatus(audio, hasKey);

    if (!hasKey) setAudioButton('needs-key');
    else if (audio && audio.meta && audio.meta.state === 'recording') setAudioButton('stop');
    else setAudioButton('start', 'Click to record audio even without captions');
    setMsg('Turn on captions in the meeting, or click Record audio to capture with Whisper only.', 'info');
    lastState = null;

    // Summarize can still apply to an audio-only session
    if (audio && audio.sessionId) {
      const summaryRes = await chrome.runtime.sendMessage({
        type: 'GET_SUMMARY',
        platform: (audio.meta && audio.meta.platform) || urlPlatform,
        meetingId: (audio.meta && audio.meta.meetingId) || urlMeetingId,
        sessionId: audio.sessionId,
      });
      lastSummary = (summaryRes && summaryRes.summary) || null;
    } else {
      lastSummary = null;
    }
    const audioCount = (audio && audio.meta && audio.meta.chunkCount) || 0;
    updateSummarizeButton(audioCount, hasKey);
    await refreshDriveContext({
      platform: (audio && audio.meta && audio.meta.platform) || urlPlatform,
      meetingId: (audio && audio.meta && audio.meta.meetingId) || urlMeetingId,
      sessionId: audio && audio.sessionId,
    });
    return;
  }
  lastState = state;
  const plat = platformLabel(state.platform);
  if (state.meetingId) {
    meetingEl.textContent = state.meetingId;
    if (state.paused) {
      setStatus('Paused' + (plat ? ' on ' + plat : ''), 'status-paused');
      setToggleButton('start');
    } else if (state.recording) {
      setStatus('Recording' + (plat ? ' on ' + plat : ''), 'status-recording');
      setToggleButton('stop');
    } else {
      setStatus('Waiting for captions', 'status-waiting');
      setToggleButton('stop');
    }
    const res = await chrome.runtime.sendMessage({
      type: 'GET_TRANSCRIPT',
      platform: state.platform,
      meetingId: state.meetingId,
      sessionId: state.sessionId,
    });
    const captionCount = res && res.lines ? res.lines.length : 0;
    lineCountEl.textContent = String(captionCount);

    const summaryRes = await chrome.runtime.sendMessage({
      type: 'GET_SUMMARY',
      platform: state.platform,
      meetingId: state.meetingId,
      sessionId: state.sessionId,
    });
    lastSummary = (summaryRes && summaryRes.summary) || null;
    updateSummarizeButton(captionCount, hasKey);
    await refreshDriveContext({
      platform: state.platform,
      meetingId: state.meetingId,
      sessionId: state.sessionId || (lastAudio && lastAudio.sessionId),
    });

    // Ask by (platform, meetingId) so the SW can find the active audio
    // session even when captions haven't minted one yet.
    const audio = await chrome.runtime.sendMessage({
      type: 'GET_AUDIO_STATE',
      platform: state.platform,
      meetingId: state.meetingId,
      sessionId: state.sessionId || null,
    });
    lastAudio = audio;
    renderAudioStatus(audio, hasKey);

    if (!hasKey) {
      setAudioButton('needs-key');
    } else if (audio && audio.meta && audio.meta.state === 'recording') {
      setAudioButton('stop');
    } else {
      setAudioButton('start');
    }
  } else {
    meetingEl.textContent = '—';
    setStatus('No active meeting', 'status-idle');
    lineCountEl.textContent = '0';
    audioStatusEl.textContent = hasKey ? 'off' : 'no key — click Options';
    setToggleButton('disabled');
    if (!hasKey) setAudioButton('needs-key');
    else setAudioButton('disabled', 'Join the meeting first');
    lastSummary = null;
    updateSummarizeButton(0, hasKey);
    await refreshDriveContext({});
  }
}

function updateSummarizeButton(captionCount, hasKey) {
  const audioMeta = lastAudio && lastAudio.meta;
  const audioCount = audioMeta ? audioMeta.chunkCount || 0 : 0;
  const anyTranscript = (captionCount > 0) || (audioCount > 0) || (lastAudio && lastAudio.pending > 0);

  if (summarizing) {
    summarizeBtn.textContent = 'Summarizing…';
    summarizeBtn.disabled = true;
    summarizeBtn.title = '';
    return;
  }
  if (!hasKey) {
    summarizeBtn.textContent = 'Summarize';
    summarizeBtn.disabled = true;
    summarizeBtn.title = 'Save an OpenAI key in Options first';
    return;
  }
  if (!anyTranscript) {
    summarizeBtn.textContent = 'Summarize';
    summarizeBtn.disabled = true;
    summarizeBtn.title = 'No transcript yet';
    return;
  }
  if (lastSummary) {
    const when = lastSummary.generatedAt ? new Date(lastSummary.generatedAt).toLocaleTimeString() : '';
    summarizeBtn.textContent = 'Re-summarize';
    summarizeBtn.disabled = false;
    summarizeBtn.title = when ? `Last summary: ${when}` : '';
    return;
  }
  summarizeBtn.textContent = 'Summarize';
  summarizeBtn.disabled = false;
  summarizeBtn.title = '';
}

toggleAudioBtn.addEventListener('click', async () => {
  setMsg('');
  const tab = await getActiveSupportedTab();
  if (!tab) {
    setMsg('Open a Meet or Teams tab first.', 'error');
    return;
  }
  const state = await queryContent(tab.id, 'GET_STATE');

  const audio = lastAudio;
  const isRecording = !!(audio && audio.meta && audio.meta.state === 'recording');

  let platform = state && state.platform;
  let meetingId = state && state.meetingId;
  let sessionId = state && state.sessionId;

  // Fallback inference from the tab URL when the content script hasn't
  // attached yet (captions off, or page just loaded).
  if (!platform || !meetingId) {
    try {
      const u = new URL(tab.url);
      if (u.host === 'meet.google.com') {
        platform = 'meet';
        const m = u.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/|$)/);
        meetingId = m ? m[1] : meetingId;
      } else if (u.host.startsWith('teams.')) {
        platform = 'teams';
        const thread = u.searchParams.get('threadId') || u.searchParams.get('context');
        if (thread) meetingId = thread.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
      }
    } catch (e) {}
  }

  if (!meetingId) {
    setMsg('Cannot detect a meeting on this tab. Join the meeting first.', 'error');
    return;
  }

  toggleAudioBtn.disabled = true;
  if (isRecording) {
    const audioSessionId =
      (audio && audio.meta && audio.meta.sessionId) ||
      (audio && audio.sessionId) ||
      sessionId;
    const r = await chrome.runtime.sendMessage({
      type: 'END_AUDIO',
      platform,
      meetingId,
      sessionId: audioSessionId,
    });
    if (r && r.ok) setMsg('Audio recording stopped. Remaining chunks will transcribe in the background.', 'ok');
    else setMsg('Could not stop audio: ' + (r && r.error ? r.error : 'unknown'), 'error');
  } else {
    const r = await chrome.runtime.sendMessage({
      type: 'BEGIN_AUDIO',
      tabId: tab.id,
      platform,
      meetingId,
      sessionId,
    });
    if (r && r.ok) setMsg('Audio recording started.', 'ok');
    else setMsg('Could not start audio: ' + (r && r.error ? r.error : 'unknown'), 'error');
  }
  refresh();
});

toggleBtn.addEventListener('click', async () => {
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
  toggleBtn.disabled = true;
  if (state.paused) {
    const r = await queryContent(tab.id, 'START_CAPTURE');
    if (r && r.ok) setMsg('Capture resumed. New session starts on next caption.', 'ok');
    else setMsg('Could not resume capture.', 'error');
  } else {
    const r = await queryContent(tab.id, 'STOP_CAPTURE');
    if (r && r.ok) {
      const dl = r.downloaded;
      if (dl && dl.ok) setMsg(`Stopped. Downloaded ${dl.filename} (${dl.lineCount} lines).`, 'ok');
      else if (dl && dl.error === 'empty transcript') setMsg('Stopped. No captions to download.', 'info');
      else setMsg('Stopped.', 'ok');
    } else {
      setMsg('Could not stop capture.', 'error');
    }
  }
  refresh();
});

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
    sessionId: state.sessionId,
  });
  if (r && r.ok) {
    setMsg(`Downloaded ${r.filename} (${r.lineCount} lines).`, 'ok');
  } else {
    setMsg('Download failed: ' + (r && r.error ? r.error : 'unknown'), 'error');
  }
  refresh();
});

saveDriveBtn.addEventListener('click', async () => {
  setMsg('');
  // If not connected or no folder, route to Options.
  if (!lastDrive || !lastDrive.connected || !lastDrive.settings || !lastDrive.settings.folderId) {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html') });
    return;
  }
  const tab = await getActiveSupportedTab();
  if (!tab) {
    setMsg('Open a Meet or Teams tab first.', 'error');
    return;
  }
  const state = await queryContent(tab.id, 'GET_STATE');
  let platform = state && state.platform;
  let meetingId = state && state.meetingId;
  let sessionId = state && state.sessionId;
  if (!sessionId && lastAudio && lastAudio.sessionId) {
    sessionId = lastAudio.sessionId;
    if (!meetingId && lastAudio.meta) meetingId = lastAudio.meta.meetingId;
    if (!platform && lastAudio.meta) platform = lastAudio.meta.platform;
  }
  if (!meetingId || !sessionId) {
    setMsg('No session to save yet. Capture some captions or audio first.', 'error');
    return;
  }
  drivePushing = true;
  setSaveDriveButton();
  renderDriveStatus();
  const r = await chrome.runtime.sendMessage({ type: 'SAVE_TO_DRIVE', platform, meetingId, sessionId });
  drivePushing = false;
  if (r && r.ok) {
    setMsg(r.updated ? 'Drive file updated.' : 'Saved to Drive.', 'ok');
  } else {
    setMsg('Drive save failed: ' + (r && r.error ? r.error : 'unknown'), 'error');
  }
  refresh();
});

summarizeBtn.addEventListener('click', async () => {
  if (summarizing) return;
  setMsg('');
  const tab = await getActiveSupportedTab();
  if (!tab) {
    setMsg('Open a Meet or Teams tab first.', 'error');
    return;
  }
  const state = await queryContent(tab.id, 'GET_STATE');
  let platform = state && state.platform;
  let meetingId = state && state.meetingId;
  let sessionId = state && state.sessionId;
  if (!meetingId) {
    // Fall back to audio session if captions never fired
    if (lastAudio && lastAudio.sessionId) {
      sessionId = lastAudio.sessionId;
      meetingId = (lastAudio.meta && lastAudio.meta.meetingId) || meetingId;
      platform = (lastAudio.meta && lastAudio.meta.platform) || platform;
    }
  }
  if (!meetingId || !sessionId) {
    setMsg('No session to summarize yet. Capture some captions or audio first.', 'error');
    return;
  }
  summarizing = true;
  updateSummarizeButton(parseInt(lineCountEl.textContent, 10) || 0, lastApiKeyPresent);
  const r = await chrome.runtime.sendMessage({
    type: 'SUMMARIZE_SESSION',
    platform,
    meetingId,
    sessionId,
  });
  summarizing = false;
  if (r && r.ok) {
    lastSummary = r.summary;
    setMsg('Summary generated. Open Download now to export the updated .md.', 'ok');
  } else {
    setMsg('Summary failed: ' + (r && r.error ? r.error : 'unknown'), 'error');
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
    sessionId: state.sessionId,
  });
  setMsg('Transcript cleared.', 'ok');
  refresh();
});

refresh();
setInterval(refresh, 1500);
