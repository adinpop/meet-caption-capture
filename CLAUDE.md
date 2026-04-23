# RUBICON Meet Caption Capture

Chrome MV3 extension that captures live captions from Google Meet and Microsoft Teams web and saves them as a UTF-8 Markdown (`.md`) file per meeting, with YAML frontmatter (platform, meeting_id, title, date, start_time, end_time, duration, participants). Language-agnostic (follows whatever caption language the platform is set to).

## Project layout

```
manifest.json                         MV3 manifest, v0.5.0
build.sh                              Packages a Chrome Web Store zip to ../rubicon-meet-caption-capture-vX.Y.Z.zip
src/
  content/content.js                  MutationObserver + adapters; writes transcripts directly to chrome.storage.local
  background/service-worker.js        Download builder, CLEAR / CLEAR_ALL, LIST_MEETINGS, MARK_FINALIZED
  popup/popup.html|js|css             Live status chip, Download now, Clear, View history
  history/history.html|js|css         Full-page transcript browser (opens via chrome.tabs.create)
icons/
  icon.svg                            Master logomark (excluded from zip)
  icon16.png, icon48.png, icon128.png
PLAN.md, PLAN-v0.2.md                 Design notes (excluded from zip)
```

## Key behaviors

- Storage keys in `chrome.storage.local`:
  - `transcript:<platform>:<meetingId>:<sessionId>`  → array of finalized line strings
  - `meta:<platform>:<meetingId>:<sessionId>`        → `{ sessionId, firstSeenAt, lastUpdatedAt, lineCount, participants[], title, finalized, finalizedAt?, downloadedAt? }`
  - Platform is `meet` or `teams`; meetingId is parsed from the URL. `sessionId` is the ms epoch of the session start; sessions exist because Teams reuses the same threadId across days for recurring meetings (without a sessionId suffix, a second call in the same chat would append to the first one's file). `title` is scraped from the page DOM (meeting subject / document.title fallback) on first caption write and kept once set.
  - A new session starts when (a) no unfinalized session for this meetingId has activity within `SESSION_GAP_MS` (15 min), (b) the user clicks **Stop capture** then **Start capture**. On a captioning reload within 15 min, the live session is adopted so tab refreshes don't cut the transcript.
  - Old-format keys (`transcript:<platform>:<meetingId>`, no sessionId) from v0.4.x and earlier are still readable for download/clear via the history browser; new captures always write session-suffixed keys.
- Stored line format (in-memory and in storage): `[HH:MM:SS] Speaker Name: text`.
- Download format: Markdown (`.md`), UTF-8, no BOM. File starts with YAML frontmatter (`platform`, `meeting_id`, `title` if known, `date`, `start_time`, `end_time`, `duration`, `participants`), then `# <title>`, then each utterance as its own paragraph: `**[HH:MM:SS] Speaker:** text`.
- Filename: `<platform>_<YYYY-MM-DD>_<HHMM>_<participants>_<meetingId>.md`. Date / time come from `meta.firstSeenAt` so historical downloads match the meeting start. Participants are sanitized to ASCII camel case, hyphen joined, capped at 3 with `-and-N-more` suffix. Serbian diacritics (č, ć, š, ž, đ) transliterate to base letters for filename portability.
- Download flow: service worker renders Markdown, wraps it in a `data:text/markdown;charset=utf-8;base64,...` URL (MV3 service workers cannot create Blob URLs) and calls `chrome.downloads.download`.
- **Durability**: content script writes each active caption block directly to `chrome.storage.local`, rolling in place on its committed index (500 ms debounce per block). A crash or forced tab close leaves the last persisted state of every utterance on disk. No separate partial slot is needed; the last write of each block IS the partial.
- Message types:
  - to service worker: `GET_TRANSCRIPT`, `FINALIZE_AND_DOWNLOAD`, `CLEAR`, `CLEAR_ALL`, `LIST_MEETINGS`, `MARK_FINALIZED`. All accept an optional `sessionId` in addition to `platform` and `meetingId`.
  - to content script (from popup): `GET_STATE`, `FLUSH_NOW`, `STOP_CAPTURE`, `START_CAPTURE`. `GET_STATE` reply includes `sessionId` and `paused`.
- Auto-download fires on meeting end (pagehide, URL change off meeting path, leave-meeting DOM heuristic). Popup **Download now** and the **View history** page are manual safety nets.
- **Stop / Start capture** (popup): Stop flushes writes, finalizes+downloads the current session, and sets `paused=true` so no further captions are persisted. Start clears the paused flag; the next caption creates a fresh session. While paused, the session chip shows **Paused**.

## Host permissions

- `https://meet.google.com/*`
- `https://teams.microsoft.com/*`
- `https://teams.cloud.microsoft/*`
- `https://teams.live.com/*`

## Selector strategy

Semantic first (role, aria-label, stable `data-tid` on Teams), Google/Microsoft hashed classes only as fallbacks. Expect occasional selector churn.

## Versions

- **0.1.0**: Meet only, Serbian-focused copy.
- **0.2.0**: adds Microsoft Teams web. Platform-agnostic copy. Filename prefixed by platform. Teams selectors still being tuned against a live call.
- **0.3.0**: durability (direct rolling writes), history browser, real Teams selectors.
- **0.4.0**: Markdown output with YAML frontmatter (date, time, duration, participants, DOM-scraped meeting title). Filename extension `.md`.
- **0.5.0** (current): per-session storage keys so recurring meetings no longer append across days. 15-min gap auto-cuts a new session; popup **Stop capture** / **Start capture** buttons give manual control. History browser shows one row per session.

## Build and install

- `./build.sh` from the project root produces `../rubicon-meet-caption-capture-v<VERSION>.zip`. Version is read from `manifest.json`. The zip excludes `.git`, `PLAN*.md`, `icons/generate.html`, `icons/icon.svg`, `.DS_Store`, `build.sh`.
- For local dev: `chrome://extensions` → Developer mode → Load unpacked → pick this folder.

## Constraints and style

- Never use em dashes or hyphens as separators in prose. Hyphens only inside compound words.
- Keep brand name as `RUBICON` (uppercase).
- Dedup rolling caption updates before committing. Commit triggers: block removed, stale block superseded by newer same-speaker block (>3s), page unload flush.
- Transcripts persist across reloads; cleared only when the user clicks **Clear**.
