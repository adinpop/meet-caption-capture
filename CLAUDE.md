# RUBICON Meet Caption Capture

Chrome MV3 extension that captures live captions from Google Meet and Microsoft Teams web and saves them as a UTF-8 `.txt` file per meeting. Language-agnostic (follows whatever caption language the platform is set to).

## Project layout

```
manifest.json                         MV3 manifest, v0.3.0
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
  - `transcript:<platform>:<meetingId>`  → array of finalized line strings
  - `meta:<platform>:<meetingId>`        → `{ firstSeenAt, lastUpdatedAt, lineCount, participants[], finalized, finalizedAt?, downloadedAt? }`
  - Platform is `meet` or `teams`; meetingId is parsed from the URL.
- Line format: `[HH:MM:SS] Speaker Name: text`. UTF-8 with BOM on download.
- Filename: `<platform>_<YYYY-MM-DD>_<HHMM>_<participants>_<meetingId>.txt`. Date / time come from `meta.firstSeenAt` so historical downloads match the meeting start. Participants are sanitized to ASCII camel case, hyphen joined, capped at 3 with `-and-N-more` suffix. Serbian diacritics (č, ć, š, ž, đ) transliterate to base letters for filename portability.
- Download flow: service worker builds a `data:text/plain;charset=utf-8;base64,...` URL (MV3 service workers cannot create Blob URLs) and calls `chrome.downloads.download`.
- **Durability**: content script writes each active caption block directly to `chrome.storage.local`, rolling in place on its committed index (500 ms debounce per block). A crash or forced tab close leaves the last persisted state of every utterance on disk. No separate partial slot is needed; the last write of each block IS the partial.
- Message types:
  - to service worker: `GET_TRANSCRIPT`, `FINALIZE_AND_DOWNLOAD`, `CLEAR`, `CLEAR_ALL`, `LIST_MEETINGS`, `MARK_FINALIZED`.
  - to content script (from popup): `GET_STATE`, `FLUSH_NOW`.
- Auto-download fires on meeting end (pagehide, URL change off meeting path, leave-meeting DOM heuristic). Popup **Download now** and the **View history** page are manual safety nets.

## Host permissions

- `https://meet.google.com/*`
- `https://teams.microsoft.com/*`
- `https://teams.cloud.microsoft/*`
- `https://teams.live.com/*`

## Selector strategy

Semantic first (role, aria-label, stable `data-tid` on Teams), Google/Microsoft hashed classes only as fallbacks. Expect occasional selector churn.

## Versions

- **0.1.0**: Meet only, Serbian-focused copy.
- **0.2.0** (current): adds Microsoft Teams web. Platform-agnostic copy. Filename prefixed by platform. Teams selectors still being tuned against a live call.

## Build and install

- `./build.sh` from the project root produces `../rubicon-meet-caption-capture-v<VERSION>.zip`. Version is read from `manifest.json`. The zip excludes `.git`, `PLAN*.md`, `icons/generate.html`, `icons/icon.svg`, `.DS_Store`, `build.sh`.
- For local dev: `chrome://extensions` → Developer mode → Load unpacked → pick this folder.

## Constraints and style

- Never use em dashes or hyphens as separators in prose. Hyphens only inside compound words.
- Keep brand name as `RUBICON` (uppercase).
- Dedup rolling caption updates before committing. Commit triggers: block removed, stale block superseded by newer same-speaker block (>3s), page unload flush.
- Transcripts persist across reloads; cleared only when the user clicks **Clear**.
