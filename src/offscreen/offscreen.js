// Offscreen document. Owns the captured MediaStream and MediaRecorder for the
// active audio recording. The service worker creates this doc, messages us
// with a tab streamId, we open the stream, chunk to IndexedDB, and notify the
// service worker per chunk. The service worker is the only piece that talks
// to OpenAI, so the API key never enters this document.
//
// Chunking strategy: a fresh MediaRecorder is started for each 30 s window.
// When the timer fires we stop the recorder, which flushes a complete,
// standalone WebM blob (with its own header). Only that lets Whisper decode
// each chunk independently. Using MediaRecorder.start(timeslice) does NOT
// work here because subsequent timeslices are header-less and fail to decode.

import { putChunk } from '../lib/audio-db.js';

const log = (...a) => console.log('[MeetCap offscreen]', ...a);

const CHUNK_MS = 30_000;
const TARGET = 'offscreen';

const state = {
  stream: null,
  audioCtx: null,
  recorder: null,
  chunkTimer: null,
  sessionId: null,
  platform: null,
  meetingId: null,
  chunkIndex: 0,
  startedAt: 0,
  closing: false,
  stopResolvers: [],
};

function resetState() {
  state.stream = null;
  state.audioCtx = null;
  state.recorder = null;
  state.chunkTimer = null;
  state.sessionId = null;
  state.platform = null;
  state.meetingId = null;
  state.chunkIndex = 0;
  state.startedAt = 0;
  state.closing = false;
  state.stopResolvers = [];
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

async function handleChunkBlob(blob) {
  if (!blob || !blob.size) return;
  const index = state.chunkIndex++;
  const offsetMs = Date.now() - state.startedAt;
  try {
    await putChunk({
      sessionId: state.sessionId,
      chunkIndex: index,
      platform: state.platform,
      meetingId: state.meetingId,
      blob,
      offsetMs,
    });
  } catch (e) {
    log('putChunk failed', e && e.message);
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
    log('notify failed (chunk persisted)', e && e.message);
  }
}

function startNextRecorder() {
  if (state.closing || !state.stream) return;
  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(state.stream, mimeType ? { mimeType } : undefined);
  state.recorder = recorder;

  let finalBlob = null;
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) finalBlob = ev.data;
  };
  recorder.onerror = (ev) => log('recorder error', ev && ev.error);
  recorder.onstop = async () => {
    if (state.chunkTimer) {
      clearTimeout(state.chunkTimer);
      state.chunkTimer = null;
    }
    await handleChunkBlob(finalBlob);
    if (state.closing) {
      state.recorder = null;
      const resolvers = state.stopResolvers.splice(0);
      for (const r of resolvers) r();
      return;
    }
    startNextRecorder();
  };

  try {
    recorder.start();
  } catch (e) {
    log('recorder.start threw', e && e.message);
    return;
  }

  state.chunkTimer = setTimeout(() => {
    try {
      if (state.recorder && state.recorder.state === 'recording') state.recorder.stop();
    } catch (e) {}
  }, CHUNK_MS);
}

async function startCapture({ streamId, sessionId, platform, meetingId }) {
  if (state.recorder || state.stream) {
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

  // Route the captured audio to speakers so the user still hears the call.
  const audioCtx = new AudioContext();
  const src = audioCtx.createMediaStreamSource(stream);
  src.connect(audioCtx.destination);

  stream.getAudioTracks().forEach((t) => {
    t.onended = () => {
      log('tab audio track ended (tab closed/nav). flushing.');
      void stopCapture('track-ended');
    };
  });

  state.stream = stream;
  state.audioCtx = audioCtx;
  state.sessionId = sessionId;
  state.platform = platform;
  state.meetingId = meetingId;
  state.chunkIndex = 0;
  state.startedAt = Date.now();
  state.closing = false;

  startNextRecorder();
  return { ok: true, startedAt: state.startedAt };
}

async function stopCapture(reason) {
  if (!state.stream && !state.recorder) return { ok: true, alreadyStopped: true };
  if (state.closing) {
    // Another stop is in flight. Wait for it.
    await new Promise((r) => state.stopResolvers.push(r));
    return { ok: true };
  }
  state.closing = true;
  log('stopCapture', reason || 'user');

  if (state.chunkTimer) {
    clearTimeout(state.chunkTimer);
    state.chunkTimer = null;
  }

  if (state.recorder && state.recorder.state !== 'inactive') {
    await new Promise((resolve) => {
      state.stopResolvers.push(resolve);
      try { state.recorder.stop(); }
      catch (e) { log('stop threw', e); resolve(); }
    });
  }

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
