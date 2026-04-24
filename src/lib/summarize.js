// Chat completion wrapper for meeting summarization. Isolated so the provider
// can later swap. Only caller of the API key for summaries; never logs it.

const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

export const DEFAULT_MODEL = 'gpt-4o-mini';

export const DEFAULT_PROMPT = `You are analyzing a meeting transcript. Extract structured information.

Return a JSON object with exactly these keys:
- "summary": 3 to 5 sentence executive overview of the meeting.
- "topics": array of strings, each a topic that was discussed.
- "decisions": array of strings, each a clear decision made during the meeting.
- "actions": array of objects with keys "task" (string), "owner" (string or null), "due" (string or null). Only actionable commitments, not general discussion.
- "blind_spots": array of strings. Gaps or risks raised but not resolved, OR topics notably absent given the meeting's stated purpose.
- "opportunities": array of strings. Opportunities surfaced that could be explored further.

If a section has no content, return an empty array (or empty string for summary).
Return ONLY the JSON object. No prose, no markdown fencing.

Transcript:
{{transcript}}`;

export const DEFAULT_SUMMARY_SETTINGS = {
  enabled_sections: ['summary', 'topics', 'decisions', 'actions', 'blind_spots', 'opportunities'],
  model: DEFAULT_MODEL,
  prompt: DEFAULT_PROMPT,
  auto_run: false,
};

export const ALL_SECTIONS = ['summary', 'topics', 'decisions', 'actions', 'blind_spots', 'opportunities'];

export class SummaryError extends Error {
  constructor(message, { status, retryable } = {}) {
    super(message);
    this.name = 'SummaryError';
    this.status = status || 0;
    this.retryable = !!retryable;
  }
}

function buildUserMessage(prompt, transcript) {
  if (prompt.includes('{{transcript}}')) return prompt.replace('{{transcript}}', transcript);
  return `${prompt}\n\nTranscript:\n${transcript}`;
}

export async function summarize(apiKey, transcript, { prompt, model, signal } = {}) {
  if (!apiKey) throw new SummaryError('missing api key', { status: 0, retryable: false });
  if (!transcript || !transcript.trim()) throw new SummaryError('empty transcript', { status: 0, retryable: false });

  const chosenPrompt = (prompt && prompt.trim()) || DEFAULT_PROMPT;
  const chosenModel = model || DEFAULT_MODEL;
  const userMsg = buildUserMessage(chosenPrompt, transcript);

  const body = {
    model: chosenModel,
    messages: [
      { role: 'system', content: 'You are an expert meeting analyst. Respond with valid JSON only.' },
      { role: 'user', content: userMsg },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.2,
  };

  let res;
  try {
    res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    throw new SummaryError('network error reaching api.openai.com', { status: 0, retryable: true });
  }

  if (!res.ok) {
    const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    let detail = '';
    try {
      const text = await res.text();
      try {
        const parsed = JSON.parse(text);
        detail = (parsed && parsed.error && parsed.error.message) || '';
      } catch { detail = text.slice(0, 200); }
    } catch {}
    throw new SummaryError(`summary ${res.status} ${res.statusText}${detail ? ': ' + detail : ''}`, {
      status: res.status, retryable,
    });
  }

  const json = await res.json();
  const content = (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '{}';
  let parsed;
  try { parsed = JSON.parse(content); }
  catch (e) { throw new SummaryError('model returned non-JSON response', { status: 0, retryable: false }); }

  return normalize(parsed);
}

function normalize(obj) {
  const out = {
    summary: typeof obj.summary === 'string' ? obj.summary.trim() : '',
    topics: toStringArray(obj.topics),
    decisions: toStringArray(obj.decisions),
    actions: toActionArray(obj.actions),
    blind_spots: toStringArray(obj.blind_spots || obj.blindSpots || obj['blind spots']),
    opportunities: toStringArray(obj.opportunities),
  };
  return out;
}

function toStringArray(x) {
  if (!Array.isArray(x)) return [];
  return x.map((v) => (typeof v === 'string' ? v.trim() : String(v || '').trim())).filter(Boolean);
}

function toActionArray(x) {
  if (!Array.isArray(x)) return [];
  const out = [];
  for (const a of x) {
    if (!a) continue;
    if (typeof a === 'string') {
      const t = a.trim();
      if (t) out.push({ task: t, owner: null, due: null });
      continue;
    }
    const task = typeof a.task === 'string' ? a.task.trim() : '';
    if (!task) continue;
    const owner = a.owner && typeof a.owner === 'string' ? a.owner.trim() : null;
    const due = a.due && typeof a.due === 'string' ? a.due.trim() : null;
    out.push({ task, owner: owner || null, due: due || null });
  }
  return out;
}
