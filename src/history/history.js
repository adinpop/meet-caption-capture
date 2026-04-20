const rowsEl = document.getElementById('rows');
const tableEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const summaryEl = document.getElementById('summary');
const storageEl = document.getElementById('storage');
const refreshBtn = document.getElementById('refresh');
const clearAllBtn = document.getElementById('clear-all');

function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'error' ? ' error' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 200);
  }, 2400);
}

function platformLabel(id) {
  if (id === 'meet') return 'Meet';
  if (id === 'teams') return 'Teams';
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Unknown';
}

function platformClass(id) {
  if (id === 'meet') return 'platform-meet';
  if (id === 'teams') return 'platform-teams';
  return 'platform-unknown';
}

function fmtDateTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${date} ${time}`;
}

function fmtDuration(firstMs, lastMs) {
  if (!firstMs || !lastMs || lastMs <= firstMs) return '—';
  const secs = Math.round((lastMs - firstMs) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const restSec = secs % 60;
  if (mins < 60) return `${mins}m ${restSec}s`;
  const hours = Math.floor(mins / 60);
  const restMin = mins % 60;
  return `${hours}h ${restMin}m`;
}

function fmtBytes(bytes) {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function participantsCell(meta) {
  const list = (meta && meta.participants) || [];
  if (list.length === 0) return '<span class="more">—</span>';
  const show = list.slice(0, 3).join(', ');
  const extra = list.length > 3 ? `<span class="more">+${list.length - 3} more</span>` : '';
  return `${escapeHtml(show)}${extra}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function render() {
  const res = await chrome.runtime.sendMessage({ type: 'LIST_MEETINGS' });
  const items = (res && res.items) || [];
  items.sort((a, b) => {
    const aT = (a.meta && (a.meta.lastUpdatedAt || a.meta.firstSeenAt)) || 0;
    const bT = (b.meta && (b.meta.lastUpdatedAt || b.meta.firstSeenAt)) || 0;
    return bT - aT;
  });

  rowsEl.innerHTML = '';
  for (const item of items) {
    const meta = item.meta || {};
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="platform-badge ${platformClass(item.platform)}">${platformLabel(item.platform)}</span></td>
      <td>${fmtDateTime(meta.firstSeenAt)}${meta.finalized ? '<span class="finalized">ended</span>' : ''}</td>
      <td>${fmtDuration(meta.firstSeenAt, meta.lastUpdatedAt)}</td>
      <td class="participants">${participantsCell(meta)}</td>
      <td class="num">${item.lineCount || (meta.lineCount || 0)}</td>
      <td><span class="meeting-id">${escapeHtml(item.meetingId)}</span></td>
      <td class="actions-col">
        <span class="cell-actions">
          <button class="download primary">Download</button>
          <button class="clear danger">Delete</button>
        </span>
      </td>
    `;
    tr.querySelector('.download').addEventListener('click', async (ev) => {
      ev.currentTarget.disabled = true;
      const r = await chrome.runtime.sendMessage({
        type: 'FINALIZE_AND_DOWNLOAD',
        platform: item.platform,
        meetingId: item.meetingId,
      });
      ev.currentTarget.disabled = false;
      if (r && r.ok) {
        toast(`Downloaded ${r.filename}`);
      } else {
        toast('Download failed: ' + (r && r.error ? r.error : 'unknown'), 'error');
      }
    });
    tr.querySelector('.clear').addEventListener('click', async () => {
      if (!confirm(`Delete transcript for ${item.meetingId}?`)) return;
      await chrome.runtime.sendMessage({
        type: 'CLEAR',
        platform: item.platform,
        meetingId: item.meetingId,
      });
      toast('Transcript deleted.');
      render();
    });
    rowsEl.appendChild(tr);
  }

  const hasItems = items.length > 0;
  tableEl.hidden = !hasItems;
  emptyEl.hidden = hasItems;
  summaryEl.textContent = `${items.length} meeting${items.length === 1 ? '' : 's'}`;

  try {
    const bytes = await chrome.storage.local.getBytesInUse(null);
    storageEl.textContent = `Storage in use: ${fmtBytes(bytes)}`;
  } catch (e) {
    storageEl.textContent = '';
  }
}

refreshBtn.addEventListener('click', () => render());
clearAllBtn.addEventListener('click', async () => {
  if (!confirm('Delete every stored transcript? This cannot be undone.')) return;
  const r = await chrome.runtime.sendMessage({ type: 'CLEAR_ALL' });
  if (r && r.ok) {
    toast(`Deleted ${r.removed} key${r.removed === 1 ? '' : 's'}.`);
  } else {
    toast('Clear failed.', 'error');
  }
  render();
});

render();
setInterval(render, 4000);
