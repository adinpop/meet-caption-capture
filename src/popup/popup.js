const statusEl = document.getElementById('status');
const meetingEl = document.getElementById('meeting-id');
const lineCountEl = document.getElementById('line-count');
const audioStatusEl = document.getElementById('audio-status');
const toggleBtn = document.getElementById('toggle-capture');
const toggleAudioBtn = document.getElementById('toggle-audio');
const openOptionsBtn = document.getElementById('open-options');
const downloadBtn = document.getElementById('download');
const clearBtn = document.getElementById('clear');
const historyBtn = document.getElementById('history');
const messageEl = document.getElementById('message');

let lastState = null;
let lastAudio = null;
let lastApiKeyPresent = null;

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

function setAudioButton(mode, info) {
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
  } else {
    toggleAudioBtn.textContent = 'Record audio';
    toggleAudioBtn.className = 'primary';
    toggleAudioBtn.disabled = true;
    toggleAudioBtn.title = info || 'Requires an OpenAI API key (Options)';
  }
}

function renderAudioStatus(audio, hasKey) {
  if (!hasKey) {
    audioStatusEl.textContent = 'no key (open Options)';
    return;
  }
  if (!audio || !audio.meta) {
    audioStatusEl.textContent = 'off';
    return;
  }
  const m = audio.meta;
  const bits = [];
  bits.push(m.state || 'idle');
  if (m.chunkCount) bits.push(`${m.chunkCount} chunk${m.chunkCount === 1 ? '' : 's'}`);
  if (audio.pending) bits.push(`${audio.pending} pending`);
  if (audio.failed) bits.push(`${audio.failed} failed`);
  audioStatusEl.textContent = bits.join(' · ');
}

async function getApiKeyPresent() {
  try {
    const got = await chrome.storage.local.get('apiKey');
    return !!(got && got.apiKey);
  } catch (e) {
    return false;
  }
}

async function refresh() {
  const tab = await getActiveSupportedTab();
  const hasKey = await getApiKeyPresent();
  lastApiKeyPresent = hasKey;

  if (!tab) {
    setStatus('No meeting tab', 'status-idle');
    meetingEl.textContent = '—';
    lineCountEl.textContent = '0';
    audioStatusEl.textContent = hasKey ? 'off' : 'no key (open Options)';
    setToggleButton('disabled');
    setAudioButton('disabled', 'Open a Meet or Teams tab first');
    lastState = null;
    lastAudio = null;
    return;
  }
  const state = await queryContent(tab.id, 'GET_STATE');
  if (!state) {
    setStatus('Waiting for captions', 'status-waiting');
    meetingEl.textContent = '—';
    lineCountEl.textContent = '0';
    audioStatusEl.textContent = hasKey ? 'off' : 'no key (open Options)';
    setToggleButton('disabled');
    if (hasKey) {
      setAudioButton('start', 'Click to record audio even without captions');
    } else {
      setAudioButton('disabled', 'Save an OpenAI key in Options first');
    }
    setMsg('Turn on captions in the meeting, or just click Record audio to capture with Whisper only.', 'info');
    lastState = null;
    lastAudio = null;
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
    lineCountEl.textContent = String(res && res.lines ? res.lines.length : 0);

    const audio = await chrome.runtime.sendMessage({
      type: 'GET_AUDIO_STATE',
      platform: state.platform,
      meetingId: state.meetingId,
      sessionId: state.sessionId,
    });
    lastAudio = audio;
    renderAudioStatus(audio, hasKey);

    if (!hasKey) {
      setAudioButton('disabled', 'Save an OpenAI key in Options first');
    } else if (audio && audio.meta && audio.meta.state === 'recording') {
      setAudioButton('stop');
    } else {
      setAudioButton('start');
    }
  } else {
    meetingEl.textContent = '—';
    setStatus('No active meeting', 'status-idle');
    lineCountEl.textContent = '0';
    audioStatusEl.textContent = hasKey ? 'off' : 'no key (open Options)';
    setToggleButton('disabled');
    setAudioButton('disabled', 'No active meeting');
  }
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
    const r = await chrome.runtime.sendMessage({
      type: 'END_AUDIO',
      platform,
      meetingId,
      sessionId: (audio && audio.meta && audio.meta.sessionId) || sessionId,
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
