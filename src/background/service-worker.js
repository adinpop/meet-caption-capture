const LINE_PREFIX = 'transcript:';

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'COMMIT_LINE') {
    commitLine(msg.meetingId, msg.line)
      .then(() => reply({ ok: true }))
      .catch((e) => reply({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'GET_TRANSCRIPT') {
    getTranscript(msg.meetingId).then((lines) => reply({ lines }));
    return true;
  }
  if (msg.type === 'FINALIZE_AND_DOWNLOAD') {
    finalizeAndDownload(msg.meetingId)
      .then((r) => reply(r))
      .catch((e) => reply({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'CLEAR') {
    clearTranscript(msg.meetingId)
      .then(() => reply({ ok: true }))
      .catch((e) => reply({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'LIST_MEETINGS') {
    listMeetings().then((ids) => reply({ ids }));
    return true;
  }
});

async function commitLine(meetingId, line) {
  if (!meetingId || !line) return;
  const key = LINE_PREFIX + meetingId;
  const got = await chrome.storage.local.get(key);
  const existing = got[key] || [];
  if (existing.length > 0 && existing[existing.length - 1] === line) return;
  existing.push(line);
  await chrome.storage.local.set({ [key]: existing });
}

async function getTranscript(meetingId) {
  if (!meetingId) return [];
  const key = LINE_PREFIX + meetingId;
  const got = await chrome.storage.local.get(key);
  return got[key] || [];
}

async function clearTranscript(meetingId) {
  if (!meetingId) return;
  const key = LINE_PREFIX + meetingId;
  await chrome.storage.local.remove(key);
}

async function listMeetings() {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all)
    .filter((k) => k.startsWith(LINE_PREFIX))
    .map((k) => k.slice(LINE_PREFIX.length));
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

function timestampStamp(d) {
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${Y}${M}${D}-${h}${m}`;
}

async function finalizeAndDownload(meetingId) {
  if (!meetingId) return { ok: false, error: 'no meetingId' };
  const lines = await getTranscript(meetingId);
  if (lines.length === 0) return { ok: false, error: 'empty transcript' };
  const body = '\uFEFF' + lines.join('\n') + '\n';
  const b64 = utf8ToBase64(body);
  const url = `data:text/plain;charset=utf-8;base64,${b64}`;
  const filename = `meet-${meetingId}-${timestampStamp(new Date())}.txt`;
  try {
    const id = await chrome.downloads.download({ url, filename, saveAs: false });
    return { ok: true, filename, lineCount: lines.length, downloadId: id };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}
