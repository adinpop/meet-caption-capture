const hasKeyEl = document.getElementById('has-key');
const noKeyEl = document.getElementById('no-key');
const keyDisplayEl = document.getElementById('key-display');
const keyInputEl = document.getElementById('key-input');
const saveBtn = document.getElementById('save');
const removeBtn = document.getElementById('remove');
const statusEl = document.getElementById('status');

function setStatus(text, kind) {
  statusEl.textContent = text || '';
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function mask(key) {
  if (!key) return '—';
  const last4 = key.slice(-4);
  return `sk-...${last4}`;
}

async function render() {
  const got = await chrome.storage.local.get('apiKey');
  const key = got && got.apiKey;
  if (key) {
    hasKeyEl.hidden = false;
    noKeyEl.hidden = true;
    keyDisplayEl.textContent = mask(key);
  } else {
    hasKeyEl.hidden = true;
    noKeyEl.hidden = false;
    keyInputEl.value = '';
  }
}

async function validateKey(key) {
  const res = await fetch('https://api.openai.com/v1/models', {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` },
  });
  if (res.status === 200) return { ok: true };
  if (res.status === 401) return { ok: false, reason: 'Invalid key (401 unauthorized).' };
  if (res.status === 429) return { ok: false, reason: 'Rate-limited (429). Try again shortly.' };
  return { ok: false, reason: `Unexpected status ${res.status} ${res.statusText}.` };
}

saveBtn.addEventListener('click', async () => {
  const key = (keyInputEl.value || '').trim();
  if (!key) {
    setStatus('Paste a key first.', 'error');
    return;
  }
  if (!/^sk-[A-Za-z0-9_\-]{20,}$/.test(key)) {
    setStatus('That does not look like an OpenAI key. Expected to start with "sk-" followed by 20+ characters.', 'error');
    return;
  }
  saveBtn.disabled = true;
  setStatus('Validating key with OpenAI...', 'info');
  try {
    const result = await validateKey(key);
    if (!result.ok) {
      setStatus(result.reason, 'error');
      saveBtn.disabled = false;
      return;
    }
    await chrome.storage.local.set({ apiKey: key });
    setStatus('Key saved.', 'ok');
    keyInputEl.value = '';
    await render();
  } catch (e) {
    setStatus('Network error reaching api.openai.com. Check your connection.', 'error');
  } finally {
    saveBtn.disabled = false;
  }
});

removeBtn.addEventListener('click', async () => {
  if (!confirm('Remove the OpenAI API key from this device?')) return;
  await chrome.storage.local.remove('apiKey');
  setStatus('Key removed.', 'ok');
  await render();
});

render();
