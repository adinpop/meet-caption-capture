// Offscreen document. Owns the captured MediaStream and MediaRecorder for the
// active audio recording. The service worker creates this doc, messages us
// with a tab streamId, we open the stream, chunk to IndexedDB, and notify the
// service worker per chunk. The service worker is the only piece that talks to
// OpenAI, so the API key never enters this document.

import { putChunk } from '../lib/audio-db.js';

const log = (...a) => console.log('[MeetCap offscreen]', ...a);

const CHUNK_MS = 30_000;
const TARGET = 'offscreen';

const state = {
  stream: null,
  recorder: null,
  audioCtx: null,
  sessionId: null,
  platform: null,
  meetingId: null,
  chunkIndex: 0,
  startedAt: 0,
  closing: false,
};

function resetState() {
  state.stream = null;
  state.recorder = null;
  state.audioCtx = null;
  state.sessionId = null;
  state.platform = null;
  state.meetingId = null;
  state.chunkIndex = 0;
  state.startedAt = 0;
  state.closing = false;
}

async function startCapture({ streamId, sessionId, platform, meetingId }) {
  if (state.recorder) {
    throw new Error('already recording');
  }
  log('startCapture', { sessionId, platform, meetingId });

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  // Route the captured audio to the speakers so the user keeps hearing the
  // call. Without this, grabbing a tab stream mutes the tab for the user.
  const audioCtx = new AudioContext();
  const src = audioCtx.createMediaStreamSource(stream);
  src.connect(audioCtx.destination);

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

  recorder.ondataavailable = async (ev) => {
    if (!ev.data || ev.data.size === 0) return;
    const index = state.chunkIndex++;
    const offsetMs = Date.now() - state.startedAt;
    try {
      await putChunk({
        sessionId: state.sessionId,
        chunkIndex: index,
        platform: state.platform,
        meetingId: state.meetingId,
        blob: ev.data,
        offsetMs,
      });
    } catch (e) {
      log('putChunk failed', e);
      return;
    }
    try {
      await chrome.runtime.sendMessage({
        type: 'AUDIO_CHUNK',
        sessionId: state.sessionId,
        chunkIndex: index,
        platform: state.platform,
        meetingId: state.meetingId,
      });
    } catch (e) {
      // service worker may be warming up; chunk is safe in IndexedDB and
      // will be picked up when the SW drains.
      log('notify failed (chunk persisted)', e && e.message);
    }
  };

  recorder.onerror = (ev) => log('recorder error', ev && ev.error);
  recorder.onstop = () => {
    log('recorder stopped, total chunks', state.chunkIndex);
  };

  stream.getAudioTracks().forEach((t) => {
    t.onended = () => {
      log('tab audio track ended (tab closed/nav). flushing.');
      void stopCapture('track-ended');
    };
  });

  state.stream = stream;
  state.recorder = recorder;
  state.audioCtx = audioCtx;
  state.sessionId = sessionId;
  state.platform = platform;
  state.meetingId = meetingId;
  state.chunkIndex = 0;
  state.startedAt = Date.now();

  recorder.start(CHUNK_MS);
  return { ok: true, startedAt: state.startedAt };
}

async function stopCapture(reason) {
  if (!state.recorder || state.closing) return { ok: true, alreadyStopped: true };
  state.closing = true;
  log('stopCapture', reason || 'user');

  const finalFlush = new Promise((resolve) => {
    if (state.recorder.state === 'inactive') return resolve();
    const handler = () => {
      state.recorder.removeEventListener('stop', handler);
      resolve();
    };
    state.recorder.addEventListener('stop', handler);
    try {
      state.recorder.stop();
    } catch (e) {
      log('stop threw', e);
      resolve();
    }
  });

  await finalFlush;

  try { state.stream && state.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
  try { state.audioCtx && await state.audioCtx.close(); } catch (e) {}

  const chunkCount = state.chunkIndex;
  const sessionId = state.sessionId;
  const platform = state.platform;
  const meetingId = state.meetingId;
  resetState();

  try {
    await chrome.runtime.sendMessage({
      type: 'AUDIO_STOPPED',
      sessionId,
      platform,
      meetingId,
      chunkCount,
      reason: reason || 'user',
    });
  } catch (e) {}

  return { ok: true, chunkCount };
}

function pickMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.target !== TARGET) return;
  if (msg.type === 'START_CAPTURE') {
    startCapture(msg.payload)
      .then((r) => reply(r))
      .catch((e) => reply({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }
  if (msg.type === 'STOP_CAPTURE') {
    stopCapture('user')
      .then((r) => reply(r))
      .catch((e) => reply({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }
  if (msg.type === 'PING') {
    reply({ ok: true, recording: !!state.recorder, sessionId: state.sessionId, chunkCount: state.chunkIndex });
    return true;
  }
});

log('offscreen ready');
