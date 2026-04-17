# Google Meet Caption Capture — Chrome Extension

## Context

User wants to capture Google Meet live captions (configured for Serbian via Meet's own caption settings) and save them to a single `.txt` file per meeting. Approach: a Chrome Manifest V3 extension with a content script that observes the captions DOM, dedupes rolling updates, persists to `chrome.storage.local`, and auto-downloads a UTF-8 `.txt` file when the meeting ends.

Confirmed with user:
- Line format: `[HH:MM:SS] Speaker Name: text`
- Save trigger: automatic on meeting end (with a manual "Download now" fallback in the popup for resilience)
- Persistence: `chrome.storage.local`, keyed by meeting ID, kept until user clicks Clear

## File structure

```
meet-caption-capture/
├── manifest.json
├── src/
│   ├── content/
│   │   ├── content.js              # entry: bootstraps observer, lifecycle
│   │   ├── captions.js             # caption DOM observer + dedup logic
│   │   └── meeting-lifecycle.js    # meeting start/end detection
│   ├── background/
│   │   └── service-worker.js       # storage, download, message bus
│   └── popup/
│       ├── popup.html
│       ├── popup.js
│       └── popup.css
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

## manifest.json (key fields)

- `manifest_version: 3`
- `permissions: ["storage", "downloads"]`
- `host_permissions: ["https://meet.google.com/*"]`
- `content_scripts`: match `https://meet.google.com/*`, `run_at: document_idle`, files: `src/content/*.js`
- `background.service_worker: src/background/service-worker.js`
- `action.default_popup: src/popup/popup.html`

## Caption scraping (`src/content/captions.js`)

### Selector strategy (resilient to Meet's class churn)

Prefer semantic selectors over Google's hashed class names:

1. Root: `div[role="region"]` whose `aria-label` matches `/captions?/i` (and its translations). Fallback: `div[jsname="dsyhDe"]` (currently valid).
2. Speaker block: direct repeating children of the region.
3. Speaker name: first descendant text node inside a short-content element at the top of each block.
4. Caption text: the largest-text descendant element whose `textContent` grows over time.

Keep a small list of known class-name fallbacks (`.nMcdL`, `.zs7s8d`, `.ygicle`) as hints, but never hard-depend on them.

### Dedup algorithm

```
captionMap: Map<HTMLElement, { speaker, text, firstSeen, lastUpdate, committed }>
```

- `MutationObserver` watches the captions region with `{ childList: true, subtree: true, characterData: true }`.
- For each relevant mutation, find the enclosing speaker block; update `text` + `lastUpdate`.
- Commit (append a line to the transcript) when any of:
  - The block is removed from the DOM.
  - `now - lastUpdate > 3000ms` AND a newer block exists for same speaker.
  - `pagehide` / `beforeunload` (flush all uncommitted).
- Timestamp at commit time = wall clock when finalized.
- Send committed lines to the service worker via `chrome.runtime.sendMessage({ type: 'COMMIT_LINE', meetingId, line })`.

### Line format

```
[HH:MM:SS] Ana Petrović: Dobro jutro svima
```

UTF-8 throughout (critical for č, ć, š, ž, đ and Cyrillic). Prepend UTF-8 BOM (`\uFEFF`) to the final file so Windows Notepad renders it correctly.

## Meeting lifecycle (`src/content/meeting-lifecycle.js`)

- **Meeting ID**: parse from pathname, e.g. `/abc-defg-hij` → `abc-defg-hij`. Use this as the storage key.
- **Meeting start**: pathname matches `^/[a-z]{3}-[a-z]{4}-[a-z]{3}$` and captions region appears.
- **Meeting end**, any of:
  - `pagehide` or `beforeunload` on the Meet tab.
  - History navigation away from the meeting pathname (URL change).
  - "You left the meeting" / "Return to home screen" DOM heuristic.
- On meeting end: flush any pending caption blocks, then `chrome.runtime.sendMessage({ type: 'FINALIZE_AND_DOWNLOAD', meetingId })`.

## Service worker (`src/background/service-worker.js`)

Responsibilities:
- `COMMIT_LINE`: append to `chrome.storage.local['transcript:' + meetingId]` (stored as an array of lines).
- `FINALIZE_AND_DOWNLOAD`: read stored lines, join with `\n`, prepend BOM. MV3 service workers lack `URL.createObjectURL`, so build a `data:text/plain;charset=utf-8;base64,<base64>` URL, then `chrome.downloads.download({ url, filename: 'meet-<meetingId>-<YYYYMMDD-HHMM>.txt', saveAs: false })`.
- `CLEAR`: remove the storage key.
- `GET_STATE` (for popup): return caption count, meeting ID, recording status.

## Popup (`src/popup/`)

- **Status chip**: Recording / Idle (derived from whether the active Meet tab has the content script reporting).
- **Meeting ID** (read-only).
- **Caption count** (live).
- **Download now** button → sends `FINALIZE_AND_DOWNLOAD` without waiting for meeting end (manual safety net).
- **Clear** button → sends `CLEAR` after a confirm.
- **Hint text**: "Enable Serbian captions: in Meet, click CC → settings → Captions language → Serbian."

## Icons

Generate three PNG sizes (16/48/128) with a simple "CC" glyph. Placeholder icons are fine for v1; user can replace later.

## Verification

1. Open `chrome://extensions`, enable Developer mode, click "Load unpacked", select the project folder.
2. Join any Google Meet, click CC, set Caption language to Serbian.
3. Have someone speak Serbian (or paste Serbian text into TTS for solo testing).
4. Open the extension popup: verify status = Recording, caption count increments, meeting ID displayed.
5. Click "Download now" → confirm `meet-<id>-<timestamp>.txt` lands in Downloads with correct UTF-8 content and diacritics intact (open in VS Code or a UTF-8-aware editor, not Notepad's default).
6. Leave the meeting (click hang-up). Confirm the auto-download fires once more (or the extension marks the session finalized).
7. Reload the Meet tab mid-meeting: confirm previously committed lines are still in `chrome.storage.local` (DevTools → Application → Storage → Extension).
8. Click Clear in the popup: confirm storage is wiped for that meeting ID.
9. Edge case: open two Meet tabs simultaneously; verify each meeting ID gets its own transcript.

## Known risks / caveats

- **Selector churn**: Google rotates the captions DOM classes every few months. The semantic-first selector strategy reduces breakage but does not eliminate it; expect to update fallbacks occasionally.
- **Auto-end detection is best-effort**: browser crash or forced tab close can skip the final flush. The manual Download button is the safety net; stored lines are safe in `chrome.storage.local` in any case.
- **Overlapping speakers**: the extension records exactly what Meet's caption pane shows. If Meet merges or drops overlapping speech, so will the transcript.
- **Language switching mid-meeting**: no marker is inserted; transcript will contain mixed-language text. Acceptable for v1.
- **Meet's caption quality for Serbian**: decent but imperfect on accents, names, and overlapping speech. Outside the extension's control.
- **MV3 service worker limitations**: no `URL.createObjectURL`. Using `data:` URL with base64-encoded UTF-8 text sidesteps this without needing an offscreen document.
