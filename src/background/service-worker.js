const PREFIX_TX = 'transcript:';
const PREFIX_META = 'meta:';
const PREFIX_PARTIAL = 'partial:';

function keysFor(platform, meetingId) {
  const suffix = `${platform || 'unknown'}:${meetingId}`;
  return {
    tx: PREFIX_TX + suffix,
    meta: PREFIX_META + suffix,
    partial: PREFIX_PARTIAL + suffix,
  };
}

function splitSuffix(rest) {
  const colonIdx = rest.indexOf(':');
  if (colonIdx < 0) return { platform: 'unknown', meetingId: rest };
  return { platform: rest.slice(0, colonIdx), meetingId: rest.slice(colonIdx + 1) };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'GET_TRANSCRIPT') {
    getTranscript(msg.platform, msg.meetingId).then((lines) => reply({ lines }));
    return true;
  }
  if (msg.type === 'FINALIZE_AND_DOWNLOAD') {
    finalizeAndDownload(msg.platform, msg.meetingId)
      .then((r) => reply(r))
      .catch((e) => reply({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'CLEAR') {
    clearTranscript(msg.platform, msg.meetingId)
      .then(() => reply({ ok: true }))
      .catch((e) => reply({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'CLEAR_ALL') {
    clearAll()
      .then((r) => reply({ ok: true, ...r }))
      .catch((e) => reply({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'LIST_MEETINGS') {
    listMeetings().then((items) => reply({ items }));
    return true;
  }
  if (msg.type === 'MARK_FINALIZED') {
    markFinalized(msg.platform, msg.meetingId)
      .then(() => reply({ ok: true }))
      .catch((e) => reply({ ok: false, error: String(e) }));
    return true;
  }
});

async function getTranscript(platform, meetingId) {
  if (!meetingId) return [];
  const { tx } = keysFor(platform, meetingId);
  const got = await chrome.storage.local.get(tx);
  return got[tx] || [];
}

async function clearTranscript(platform, meetingId) {
  if (!meetingId) return;
  const { tx, meta, partial } = keysFor(platform, meetingId);
  await chrome.storage.local.remove([tx, meta, partial]);
}

async function clearAll() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(
    (k) => k.startsWith(PREFIX_TX) || k.startsWith(PREFIX_META) || k.startsWith(PREFIX_PARTIAL)
  );
  if (keys.length) await chrome.storage.local.remove(keys);
  return { removed: keys.length };
}

async function markFinalized(platform, meetingId) {
  if (!meetingId) return;
  const { meta } = keysFor(platform, meetingId);
  const got = await chrome.storage.local.get(meta);
  const record = got[meta];
  if (!record) return;
  record.finalized = true;
  record.finalizedAt = Date.now();
  await chrome.storage.local.set({ [meta]: record });
}

async function listMeetings() {
  const all = await chrome.storage.local.get(null);
  const out = [];
  for (const key of Object.keys(all)) {
    if (!key.startsWith(PREFIX_TX)) continue;
    const { platform, meetingId } = splitSuffix(key.slice(PREFIX_TX.length));
    const metaKey = PREFIX_META + `${platform}:${meetingId}`;
    out.push({
      platform,
      meetingId,
      lineCount: Array.isArray(all[key]) ? all[key].length : 0,
      meta: all[metaKey] || null,
    });
  }
  return out;
}

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

const TRANSLIT = {
  'đ': 'd', 'Đ': 'D', 'ć': 'c', 'Ć': 'C', 'č': 'c', 'Č': 'C',
  'š': 's', 'Š': 'S', 'ž': 'z', 'Ž': 'Z',
};

function camelSanitize(name) {
  if (!name) return '';
  const translit = name.replace(/[đĐćĆčČšŠžŽ]/g, (c) => TRANSLIT[c] || c);
  const stripped = translit.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const words = stripped.split(/\s+/).filter(Boolean);
  const camel = words
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ''))
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  return camel.slice(0, 30);
}

function extractParticipants(lines) {
  const seen = new Set();
  const ordered = [];
  for (const line of lines) {
    const m = line.match(/^\[\d{2}:\d{2}:\d{2}\]\s+([^:]+):/);
    if (!m) continue;
    const raw = m[1].trim();
    if (!raw || seen.has(raw)) continue;
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

async function finalizeAndDownload(platform, meetingId) {
  if (!meetingId) return { ok: false, error: 'no meetingId' };
  const { tx, meta } = keysFor(platform, meetingId);
  const got = await chrome.storage.local.get([tx, meta]);
  const lines = got[tx] || [];
  if (lines.length === 0) return { ok: false, error: 'empty transcript' };
  const record = got[meta];
  const body = '\uFEFF' + lines.join('\n') + '\n';
  const b64 = utf8ToBase64(body);
  const url = `data:text/plain;charset=utf-8;base64,${b64}`;
  const prefix = platform || 'meet';
  const start = record && record.firstSeenAt ? new Date(record.firstSeenAt) : new Date();
  const { date, time } = dateParts(start);
  const sourceNames =
    record && Array.isArray(record.participants) && record.participants.length > 0
      ? record.participants
      : extractParticipants(lines);
  const parts = formatParticipants(sourceNames);
  const filename = `${prefix}_${date}_${time}_${parts}_${meetingId}.txt`;
  try {
    const id = await chrome.downloads.download({ url, filename, saveAs: false });
    if (record) {
      record.downloadedAt = Date.now();
      await chrome.storage.local.set({ [meta]: record });
    }
    return { ok: true, filename, lineCount: lines.length, downloadId: id };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}
