(() => {
  const DEBUG = true;
  const log = (...a) => DEBUG && console.log('[MeetCap]', ...a);

  const MEETING_ID_RE = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/|$)/;
  const SCAN_INTERVAL_MS = 1000;
  const URL_WATCH_MS = 1000;
  const IDLE_COMMIT_MS = 3000;

  const state = {
    meetingId: null,
    observer: null,
    captionsRoot: null,
    blocks: new Map(),
    scanTimer: null,
    urlTimer: null,
    lastPath: location.pathname,
  };

  function getMeetingId() {
    const m = location.pathname.match(MEETING_ID_RE);
    return m ? m[1] : null;
  }

  function findCaptionsRoot() {
    const regions = document.querySelectorAll('div[role="region"]');
    for (const r of regions) {
      const label = (r.getAttribute('aria-label') || '').toLowerCase();
      if (
        label.includes('caption') ||
        label.includes('napis') ||
        label.includes('titl') ||
        label.includes('sottotitol') ||
        label.includes('untertitel')
      ) {
        return r;
      }
    }
    return document.querySelector('div[jsname="dsyhDe"]') || null;
  }

  function isCaptionBlock(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.offsetParent === null && el.getClientRects().length === 0) return false;
    if (el.querySelector('button[aria-label], [role="button"]')) return false;
    const cls = el.className || '';
    if (typeof cls === 'string' && /IMKgW|GvZY2/.test(cls)) return false;
    const txt = (el.textContent || '').trim();
    return txt.length >= 1;
  }

  function directChildOfRoot(node) {
    if (!state.captionsRoot) return null;
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el && el.parentElement && el.parentElement !== state.captionsRoot) {
      el = el.parentElement;
    }
    if (el && el.parentElement === state.captionsRoot) return el;
    return null;
  }

  function extractBlockContent(block) {
    let speaker = null;
    let caption = null;

    const nameEl =
      block.querySelector('.NWpY1d') ||
      block.querySelector('[class*="NWpY"]') ||
      block.querySelector('.jxFHg span') ||
      block.querySelector('[class*="jxFHg"] span');
    if (nameEl) speaker = (nameEl.textContent || '').trim();

    const capEl =
      block.querySelector('.ygicle') ||
      block.querySelector('[class*="ygicle"]') ||
      block.querySelector('.VbkSUe') ||
      block.querySelector('[class*="VbkSUe"]');
    if (capEl) caption = (capEl.textContent || '').trim();

    if (!caption) {
      const items = [];
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode())) {
        const t = node.textContent.trim();
        if (t) items.push(t);
      }
      if (items.length === 0) return null;
      caption = items.reduce((a, b) => (b.length > a.length ? b : a));
      if (!speaker) {
        speaker =
          items.filter((t) => t !== caption && t.length < 60).sort((a, b) => a.length - b.length)[0] || null;
      }
    }

    if (!caption) return null;
    return { speaker: speaker || 'Unknown', text: caption };
  }

  function commitBlock(blockEl, opts) {
    const finalize = opts && opts.finalize;
    const entry = state.blocks.get(blockEl);
    if (!entry) return;
    const full = (entry.text || '').trim();
    const already = (entry.lastCommittedText || '').trim();
    let delta = full;
    if (already) {
      if (full === already) delta = '';
      else if (full.startsWith(already)) delta = full.slice(already.length).trim();
      else if (already.startsWith(full)) delta = '';
    }
    if (!delta) {
      entry.committed = true;
      if (finalize) state.blocks.delete(blockEl);
      return;
    }
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const line = `[${hh}:${mm}:${ss}] ${entry.speaker}: ${delta}`;
    log('commit', line);
    try {
      chrome.runtime
        .sendMessage({ type: 'COMMIT_LINE', meetingId: state.meetingId, line })
        .catch(() => {});
    } catch (e) {
      // service worker may be asleep
    }
    entry.lastCommittedText = full;
    entry.committed = true;
    if (finalize) state.blocks.delete(blockEl);
  }

  function updateBlockFromMutation(block) {
    if (!isCaptionBlock(block)) return;
    const content = extractBlockContent(block);
    if (!content) return;
    let entry = state.blocks.get(block);
    if (!entry) {
      entry = {
        speaker: content.speaker,
        text: content.text,
        firstSeen: Date.now(),
        lastUpdate: Date.now(),
        committed: false,
        lastCommittedText: '',
      };
      state.blocks.set(block, entry);
      log('new block', content);
      return;
    }
    if (content.speaker && content.speaker !== 'Unknown') entry.speaker = content.speaker;
    if (content.text !== entry.text) {
      entry.text = content.text;
      entry.lastUpdate = Date.now();
      entry.committed = false;
    }
  }

  function handleRemovals(removedNodes) {
    for (const removed of removedNodes) {
      if (removed.nodeType !== 1) continue;
      if (state.blocks.has(removed)) {
        commitBlock(removed, { finalize: true });
      }
      for (const bEl of Array.from(state.blocks.keys())) {
        if (removed.contains && removed.contains(bEl)) commitBlock(bEl, { finalize: true });
      }
    }
  }

  function onMutations(mutations) {
    for (const m of mutations) {
      if (m.removedNodes && m.removedNodes.length) handleRemovals(m.removedNodes);
      const block = directChildOfRoot(m.target);
      if (block) updateBlockFromMutation(block);
    }
  }

  function attachObserver() {
    if (state.observer || !state.captionsRoot) return;
    state.observer = new MutationObserver(onMutations);
    state.observer.observe(state.captionsRoot, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    for (const el of state.captionsRoot.children) {
      updateBlockFromMutation(el);
    }
    log('observer attached, initial blocks:', state.blocks.size);
  }

  function detachObserver() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
  }

  function flushAll() {
    for (const blockEl of Array.from(state.blocks.keys())) {
      commitBlock(blockEl, { finalize: true });
    }
  }

  function finalize(reason) {
    log('finalize', reason);
    flushAll();
    if (state.meetingId) {
      try {
        chrome.runtime
          .sendMessage({ type: 'FINALIZE_AND_DOWNLOAD', meetingId: state.meetingId })
          .catch(() => {});
      } catch (e) {}
    }
  }

  function scanIdle() {
    const now = Date.now();
    for (const [blockEl, entry] of Array.from(state.blocks)) {
      if (!document.body.contains(blockEl)) {
        commitBlock(blockEl, { finalize: true });
        continue;
      }
      if (entry.committed) continue;
      if (now - entry.lastUpdate > IDLE_COMMIT_MS) {
        commitBlock(blockEl);
      }
    }
  }

  function tick() {
    if (!state.captionsRoot || !document.body.contains(state.captionsRoot)) {
      detachObserver();
      const root = findCaptionsRoot();
      if (root && root !== state.captionsRoot) {
        state.captionsRoot = root;
        state.blocks = new Map();
        attachObserver();
      }
    }
    scanIdle();
  }

  function watchUrl() {
    if (location.pathname === state.lastPath) return;
    const wasMeeting = MEETING_ID_RE.test(state.lastPath);
    const isMeeting = MEETING_ID_RE.test(location.pathname);
    state.lastPath = location.pathname;
    if (wasMeeting && !isMeeting) {
      finalize('nav-away');
    }
    state.meetingId = getMeetingId();
  }

  function init() {
    state.meetingId = getMeetingId();
    state.scanTimer = setInterval(tick, SCAN_INTERVAL_MS);
    state.urlTimer = setInterval(watchUrl, URL_WATCH_MS);
    window.addEventListener('pagehide', () => finalize('pagehide'));
    window.addEventListener('beforeunload', () => finalize('beforeunload'));
    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'GET_STATE') {
        reply({
          meetingId: state.meetingId,
          recording: !!state.observer,
          blockCount: state.blocks.size,
        });
        return true;
      }
      if (msg.type === 'FLUSH_NOW') {
        flushAll();
        reply({ ok: true });
        return true;
      }
    });
    log('init', { meetingId: state.meetingId });
  }

  init();
})();
