// Thin wrapper around OpenAI's audio transcription endpoint. Isolated so the
// provider can later swap (Deepgram, AssemblyAI, self-hosted whisper.cpp).
//
// Security: this is the only place that reads the API key. Callers pass the
// key in; they never see it echoed back. Never log the key, never log the
// Authorization header, never stringify the request config.

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MODEL = 'whisper-1';

export class WhisperError extends Error {
  constructor(message, { status, retryable } = {}) {
    super(message);
    this.name = 'WhisperError';
    this.status = status || 0;
    this.retryable = !!retryable;
  }
}

export async function transcribeBlob(apiKey, blob, { prompt = '', language, signal } = {}) {
  if (!apiKey) throw new WhisperError('missing api key', { status: 0, retryable: false });
  if (!blob || !blob.size) throw new WhisperError('empty audio blob', { status: 0, retryable: false });

  const form = new FormData();
  // OpenAI infers format from file extension. MediaRecorder produces webm/opus.
  form.append('file', blob, 'audio.webm');
  form.append('model', MODEL);
  form.append('response_format', 'json');
  if (prompt) form.append('prompt', prompt.slice(0, 224));
  if (language) form.append('language', language);

  let res;
  try {
    res = await fetch(WHISPER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal,
    });
  } catch (e) {
    throw new WhisperError('network error reaching api.openai.com', { status: 0, retryable: true });
  }

  if (!res.ok) {
    const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    let detail = '';
    try {
      const body = await res.text();
      // extract error.message if present; never include headers
      try {
        const parsed = JSON.parse(body);
        detail = (parsed && parsed.error && parsed.error.message) || '';
      } catch {
        detail = body.slice(0, 200);
      }
    } catch {}
    throw new WhisperError(`whisper ${res.status} ${res.statusText}${detail ? ': ' + detail : ''}`, {
      status: res.status,
      retryable,
    });
  }

  const json = await res.json();
  const text = (json && typeof json.text === 'string') ? json.text.trim() : '';
  return { text };
}
