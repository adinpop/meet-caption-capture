(() => {
  const DEBUG = true;
  const log = (...a) => DEBUG && console.log('[MeetCap]', ...a);

  // ------- Adapters -------

  const MeetAdapter = {
    id: 'meet',
    filenamePrefix: 'meet',
    matches: (loc) => loc.host === 'meet.google.com',
    getMeetingId: (loc) => {
      const m = loc.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/|$)/);
      return m ? m[1] : null;
    },
    isMeetingUrl: (loc) => /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:\/|$)/.test(loc.pathname),
    getMeetingTitle: () => {
      const explicit =
        document.querySelector('[data-meeting-title]') ||
        document.querySelector('[data-call-title]') ||
        document.querySelector('[data-self-name]');
      if (explicit) {
        const attr = explicit.getAttribute('data-meeting-title') || explicit.getAttribute('data-call-title') || '';
        const t = (attr || explicit.textContent || '').trim();
        if (t && !/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(t)) return t;
      }
      let dt = (document.title || '').trim();
      dt = dt.replace(/^Meet\s*[:|]\s*/i, '').trim();
      if (!dt || /^meet$/i.test(dt)) return '';
      if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(dt)) return '';
      return dt;
    },
    findCaptionsRoot: () => {
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
    },
    enumerateBlocks: (root) => Array.from(root.children),
    findBlockFromNode: (node, root) => {
      let el = node.nodeType === 1 ? node : node.parentElement;
      while (el && el.parentElement && el.parentElement !== root) {
        el = el.parentElement;
      }
      return el && el.parentElement === root ? el : null;
    },
    extractBlockContent: (block) => {
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
        const items = collectTextNodes(block);
        if (items.length === 0) return null;
        caption = items.reduce((a, b) => (b.length > a.length ? b : a));
        if (!speaker) {
          speaker =
            items.filter((t) => t !== caption && t.length < 60).sort((a, b) => a.length - b.length)[0] || null;
        }
      }
      if (!caption) return null;
      return { speaker: speaker || 'Unknown', text: caption };
    },
  };

  const TEAMS_BLOCK_SELECTOR = '.fui-ChatMessageCompact';
  const TEAMS_AUTHOR_SELECTOR = '[data-tid="author"]';
  const TEAMS_TEXT_SELECTOR = '[data-tid="closed-caption-text"]';

  const TeamsAdapter = {
    id: 'teams',
    filenamePrefix: 'teams',
    matches: (loc) =>
      loc.host === 'teams.microsoft.com' ||
      loc.host === 'teams.cloud.microsoft' ||
      loc.host === 'teams.live.com',
    getMeetingId: (loc) => {
      try {
        const u = new URL(loc.href);
        const thread = u.searchParams.get('threadId') || u.searchParams.get('context');
        if (thread) return thread.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
      } catch (e) {}
      const hashMatch = loc.hash && loc.hash.match(/19[:%][^/?&]+/);
      if (hashMatch) return hashMatch[0].replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
      const seg = (loc.pathname || '').split('/').find((s) => s.length >= 6);
      return seg ? seg.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40) : 'teams-session';
    },
    isMeetingUrl: (loc) => {
      const haystack = (loc.pathname || '') + (loc.search || '') + (loc.hash || '');
      return /meet(up)?\b|meetup-join|\/v2\//i.test(haystack) || !!document.querySelector(TEAMS_TEXT_SELECTOR);
    },
    getMeetingTitle: () => {
      const selectors = [
        '[data-tid="calv2-call-title"]',
        '[data-tid="call-title"]',
        '[data-tid="calling-meeting-name"]',
        '[data-tid="meeting-title"]',
        '[data-tid="call-status-container"] [data-tid="meeting-subject"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          const t = (el.textContent || '').trim();
          if (t) return t;
        }
      }
      let dt = (document.title || '').trim();
      dt = dt.replace(/\s*\|\s*Microsoft Teams\s*$/i, '').trim();
      dt = dt.replace(/^Microsoft Teams\s*[:|]\s*/i, '').trim();
      if (!dt || /^microsoft teams$/i.test(dt)) return '';
      return dt;
    },
    findCaptionsRoot: () => {
      const sample = document.querySelector(TEAMS_TEXT_SELECTOR);
      if (!sample) return null;
      let el = sample;
      for (let hops = 0; hops < 20 && el && el.parentElement; hops++) {
        const parent = el.parentElement;
        if (
          parent.querySelector('[data-testid="virtual-list-loader"]') ||
          parent.querySelector('[data-testid="vl-placeholders"]')
        ) {
          return parent;
        }
        el = parent;
      }
      el = sample;
      for (let i = 0; i < 6 && el.parentElement; i++) el = el.parentElement;
      return el;
    },
    enumerateBlocks: (root) => Array.from(root.querySelectorAll(TEAMS_BLOCK_SELECTOR)),
    findBlockFromNode: (node, root) => {
      const el = node.nodeType === 1 ? node : node.parentElement;
      if (!el || (root && !root.contains(el))) return null;
      return el.closest(TEAMS_BLOCK_SELECTOR);
    },
    extractBlockContent: (block) => {
      const nameEl = block.querySelector(TEAMS_AUTHOR_SELECTOR);
      const textEl = block.querySelector(TEAMS_TEXT_SELECTOR);
      const speaker = nameEl ? (nameEl.textContent || '').trim() : '';
      const caption = textEl ? (textEl.textContent || '').trim() : '';
      if (!caption) return null;
      return { speaker: speaker || 'Unknown', text: caption };
    },
  };

  function collectTextNodes(block) {
    const items = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim();
      if (t) items.push(t);
    }
    return items;
  }

  // ------- Pick adapter -------

  const ADAPTERS = [MeetAdapter, TeamsAdapter];
  const adapter = ADAPTERS.find((a) => a.matches(location));
  if (!adapter) {
    log('no adapter for host', location.host);
    return;
  }
  log('adapter', adapter.id, 'frame', window === window.top ? 'top' : 'sub', location.href);

  // ------- State -------

  const SCAN_INTERVAL_MS = 1000;
  const URL_WATCH_MS = 1000;
  const IDLE_COMMIT_MS = 3000;
  const COMMIT_DEBOUNCE_MS = 500;
  const MAX_PARTICIPANTS_IN_META = 50;
  const SESSION_GAP_MS = 15 * 60 * 1000;

  const state = {
    meetingId: null,
    sessionId: null,
    paused: false,
    observer: null,
    captionsRoot: null,
    blocks: new Map(),
    scanTimer: null,
    urlTimer: null,
    lastPath: location.pathname,
  };

  // ------- Storage writes (serialized) -------

  let writeQueue = Promise.resolve();
  function enqueueWrite(fn) {
    const next = writeQueue.then(fn, fn);
    writeQueue = next.catch(() => {});
    return next;
  }

  function buildLine(entry) {
    const d = new Date(entry.firstSeen);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const speaker = (entry.speaker || '').trim() || 'Unknown';
    return `[${hh}:${mm}:${ss}] ${speaker}: ${entry.text}`;
  }

  async function ensureSession() {
    if (state.paused) return null;
    if (!state.meetingId) return null;
    const platform = adapter.id;
    const now = Date.now();

    if (state.sessionId) {
      const metaKey = `meta:${platform}:${state.meetingId}:${state.sessionId}`;
      const got = await chrome.storage.local.get(metaKey);
      const rec = got[metaKey];
      const last = rec ? (rec.lastUpdatedAt || rec.firstSeenAt || 0) : 0;
      if (last && now - last > SESSION_GAP_MS) {
        try {
          if (rec && !rec.finalized) {
            rec.finalized = true;
            rec.finalizedAt = now;
            await chrome.storage.local.set({ [metaKey]: rec });
          }
        } catch (e) {}
        for (const ent of state.blocks.values()) {
          ent.committedIndex = null;
          ent.committedLine = '';
          ent.committedSessionId = null;
        }
        state.sessionId = null;
      }
    }

    if (state.sessionId) return state.sessionId;

    const prefix = `meta:${platform}:${state.meetingId}:`;
    const all = await chrome.storage.local.get(null);
    let best = null;
    for (const key of Object.keys(all)) {
      if (!key.startsWith(prefix)) continue;
      const rec = all[key];
      if (!rec || rec.finalized) continue;
      const last = rec.lastUpdatedAt || rec.firstSeenAt || 0;
      if (now - last > SESSION_GAP_MS) continue;
      if (!best || last > best.last) {
        best = { sessionId: key.slice(prefix.length), last };
      }
    }
    state.sessionId = best ? best.sessionId : String(now);
    log('session', state.sessionId, best ? 'adopted' : 'new');
    return state.sessionId;
  }

  async function persistEntry(entry) {
    if (!state.meetingId) return;
    const text = (entry.text || '').trim();
    if (!text) return;
    const platform = adapter.id;
    await enqueueWrite(async () => {
      const sessionId = await ensureSession();
      if (!sessionId) return;
      const txKey = `transcript:${platform}:${state.meetingId}:${sessionId}`;
      const metaKey = `meta:${platform}:${state.meetingId}:${sessionId}`;
      if (entry.committedSessionId && entry.committedSessionId !== sessionId) {
        entry.committedIndex = null;
        entry.committedLine = '';
      }
      entry.committedSessionId = sessionId;
      const got = await chrome.storage.local.get([txKey, metaKey]);
      const lines = Array.isArray(got[txKey]) ? got[txKey].slice() : [];
      const meta = got[metaKey] || {
        platform,
        meetingId: state.meetingId,
        sessionId,
        firstSeenAt: entry.firstSeen,
        lastUpdatedAt: entry.firstSeen,
        lineCount: 0,
        participants: [],
        title: '',
        finalized: false,
      };
      if (!meta.title && typeof adapter.getMeetingTitle === 'function') {
        try {
          const t = (adapter.getMeetingTitle() || '').trim();
          if (t) meta.title = t;
        } catch (e) {}
      }
      const line = buildLine(entry);

      if (entry.committedIndex == null) {
        if (lines.length > 0 && lines[lines.length - 1] === line) {
          entry.committedIndex = lines.length - 1;
          entry.committedLine = line;
        } else {
          entry.committedIndex = lines.length;
          entry.committedLine = line;
          lines.push(line);
        }
      } else if (entry.committedIndex < lines.length) {
        if (lines[entry.committedIndex] === line) return;
        lines[entry.committedIndex] = line;
        entry.committedLine = line;
      } else {
        if (lines.length > 0 && lines[lines.length - 1] === line) {
          entry.committedIndex = lines.length - 1;
        } else {
          entry.committedIndex = lines.length;
          lines.push(line);
        }
        entry.committedLine = line;
      }

      meta.lastUpdatedAt = Date.now();
      meta.lineCount = lines.length;
      const speaker = (entry.speaker || '').trim();
      if (
        speaker &&
        speaker !== 'Unknown' &&
        !meta.participants.includes(speaker) &&
        meta.participants.length < MAX_PARTICIPANTS_IN_META
      ) {
        meta.participants.push(speaker);
      }
      await chrome.storage.local.set({ [txKey]: lines, [metaKey]: meta });
    });
  }

  function scheduleEntryWrite(entry) {
    if (entry.pendingTimer) return;
    entry.pendingTimer = setTimeout(() => {
      entry.pendingTimer = null;
      persistEntry(entry).catch((e) => log('persist failed', e));
    }, COMMIT_DEBOUNCE_MS);
  }

  function flushEntry(entry) {
    if (entry.pendingTimer) {
      clearTimeout(entry.pendingTimer);
      entry.pendingTimer = null;
    }
    return persistEntry(entry).catch(() => {});
  }

  function flushAll() {
    const entries = Array.from(state.blocks.values());
    for (const entry of entries) {
      if (entry.pendingTimer) {
        clearTimeout(entry.pendingTimer);
        entry.pendingTimer = null;
      }
    }
    return Promise.all(entries.map((entry) => persistEntry(entry).catch(() => {})));
  }

  // ------- Block processing -------

  function updateBlockFromMutation(block) {
    if (!block) return;
    const content = adapter.extractBlockContent(block);
    if (!content) return;
    let entry = state.blocks.get(block);
    if (!entry) {
      entry = {
        speaker: content.speaker,
        text: content.text,
        firstSeen: Date.now(),
        lastUpdate: Date.now(),
        committedIndex: null,
        committedLine: '',
        pendingTimer: null,
      };
      state.blocks.set(block, entry);
      log('new block', content);
      scheduleEntryWrite(entry);
      return;
    }
    let changed = false;
    if (content.speaker && content.speaker !== 'Unknown' && content.speaker !== entry.speaker) {
      entry.speaker = content.speaker;
      changed = true;
    }
    if (content.text !== entry.text) {
      entry.text = content.text;
      entry.lastUpdate = Date.now();
      changed = true;
    }
    if (changed) scheduleEntryWrite(entry);
  }

  function handleRemovals(removedNodes) {
    for (const removed of removedNodes) {
      if (removed.nodeType !== 1) continue;
      const entry = state.blocks.get(removed);
      if (entry) {
        flushEntry(entry);
        state.blocks.delete(removed);
      }
      for (const [bEl, ent] of Array.from(state.blocks)) {
        if (removed.contains && removed.contains(bEl)) {
          flushEntry(ent);
          state.blocks.delete(bEl);
        }
      }
    }
  }

  function onMutations(mutations) {
    for (const m of mutations) {
      if (m.removedNodes && m.removedNodes.length) handleRemovals(m.removedNodes);
      const block = adapter.findBlockFromNode(m.target, state.captionsRoot);
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
    const initial = adapter.enumerateBlocks(state.captionsRoot);
    for (const el of initial) updateBlockFromMutation(el);
    log('observer attached, initial blocks:', state.blocks.size);
  }

  function detachObserver() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
  }

  async function finalize(reason) {
    log('finalize', reason);
    await flushAll();
    const sid = state.sessionId;
    if (state.meetingId && sid) {
      try {
        await chrome.runtime.sendMessage({
          type: 'MARK_FINALIZED',
          platform: adapter.id,
          meetingId: state.meetingId,
          sessionId: sid,
        });
      } catch (e) {}
      try {
        await chrome.runtime.sendMessage({
          type: 'FINALIZE_AND_DOWNLOAD',
          platform: adapter.id,
          meetingId: state.meetingId,
          sessionId: sid,
        });
      } catch (e) {}
    }
  }

  function scanIdle() {
    const now = Date.now();
    for (const [blockEl, entry] of Array.from(state.blocks)) {
      if (!document.body.contains(blockEl)) {
        flushEntry(entry);
        state.blocks.delete(blockEl);
        continue;
      }
      if (!entry.pendingTimer && now - entry.lastUpdate > IDLE_COMMIT_MS) {
        const line = buildLine(entry);
        if (line !== entry.committedLine) {
          persistEntry(entry).catch(() => {});
        }
      }
    }
  }

  function tick() {
    if (!state.captionsRoot || !document.body.contains(state.captionsRoot)) {
      detachObserver();
      const root = adapter.findCaptionsRoot();
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
    const wasMeeting = adapter.isMeetingUrl({
      pathname: state.lastPath,
      search: location.search,
      hash: location.hash,
      host: location.host,
      href: location.href,
    });
    const isMeeting = adapter.isMeetingUrl(location);
    state.lastPath = location.pathname;
    if (wasMeeting && !isMeeting) finalize('nav-away');
    state.meetingId = adapter.getMeetingId(location);
  }

  function init() {
    state.meetingId = adapter.getMeetingId(location);
    state.scanTimer = setInterval(tick, SCAN_INTERVAL_MS);
    state.urlTimer = setInterval(watchUrl, URL_WATCH_MS);
    window.addEventListener('pagehide', () => {
      flushAll();
      finalize('pagehide');
    });
    window.addEventListener('beforeunload', () => {
      flushAll();
    });
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushAll();
    });
    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'GET_STATE') {
        // With all_frames:true, many frames listen. Only the frame that has
        // detected a captions root or meeting id answers; others stay silent
        // so the authoritative frame wins the sendMessage race.
        if (!state.captionsRoot && !state.meetingId) return;
        reply({
          platform: adapter.id,
          meetingId: state.meetingId,
          sessionId: state.sessionId,
          paused: state.paused,
          recording: !!state.observer && !state.paused,
          blockCount: state.blocks.size,
        });
        return true;
      }
      if (msg.type === 'FLUSH_NOW') {
        if (!state.captionsRoot && !state.meetingId) return;
        flushAll().then(() => reply({ ok: true })).catch(() => reply({ ok: false }));
        return true;
      }
      if (msg.type === 'STOP_CAPTURE') {
        if (!state.captionsRoot && !state.meetingId) return;
        (async () => {
          await flushAll();
          const sid = state.sessionId;
          let downloaded = null;
          if (state.meetingId && sid) {
            try {
              await chrome.runtime.sendMessage({
                type: 'MARK_FINALIZED',
                platform: adapter.id,
                meetingId: state.meetingId,
                sessionId: sid,
              });
            } catch (e) {}
            try {
              downloaded = await chrome.runtime.sendMessage({
                type: 'FINALIZE_AND_DOWNLOAD',
                platform: adapter.id,
                meetingId: state.meetingId,
                sessionId: sid,
              });
            } catch (e) {}
          }
          state.paused = true;
          state.sessionId = null;
          for (const ent of state.blocks.values()) {
            ent.committedIndex = null;
            ent.committedLine = '';
            ent.committedSessionId = null;
          }
          reply({ ok: true, downloaded });
        })();
        return true;
      }
      if (msg.type === 'START_CAPTURE') {
        if (!state.captionsRoot && !state.meetingId) return;
        state.paused = false;
        reply({ ok: true });
        return true;
      }
    });
    log('init', { platform: adapter.id, meetingId: state.meetingId });
  }

  init();
})();
