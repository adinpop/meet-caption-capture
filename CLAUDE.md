# RUBICON Meet Caption Capture

Chrome MV3 extension that captures live captions from Google Meet and Microsoft Teams web and saves them as a UTF-8 Markdown (`.md`) file per meeting, with YAML frontmatter (platform, meeting_id, title, date, start_time, end_time, duration, participants). Optional opt-in audio recording of the active meeting tab, transcribed via OpenAI Whisper, appended to the same `.md` under a separate section. Language-agnostic (follows whatever caption language the platform is set to).

## Project layout

```
manifest.json                         MV3 manifest, v0.7.1. SW is ES module.
build.sh                              Packages a Chrome Web Store zip to ../rubicon-meet-caption-capture-vX.Y.Z.zip
src/
  content/content.js                  MutationObserver + adapters; writes captions transcripts directly to chrome.storage.local
  background/service-worker.js        Message router, Markdown builder, captions + audio storage, Whisper pipeline
  popup/popup.html|js|css             Live status, Stop/Start capture, Record audio, Download, Clear, View history, Options link
  history/history.html|js|css         Full-page transcript browser (opens via chrome.tabs.create)
  options/options.html|js|css         OpenAI API key input, validates against /v1/models, stores in chrome.storage.local
  offscreen/offscreen.html|js         Owns MediaStream + MediaRecorder for audio capture; writes chunks to IndexedDB
  lib/audio-db.js                     IndexedDB wrapper for raw audio chunk blobs (captionCapture DB, audioChunks store)
  lib/whisper.js                      Thin wrapper around api.openai.com/v1/audio/transcriptions; only caller of the API key
  lib/summarize.js                    Thin wrapper around api.openai.com/v1/chat/completions for meeting summaries; JSON-mode output
icons/
  icon.svg                            Master logomark (excluded from zip)
  icon16.png, icon48.png, icon128.png
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
- **Audio recording (opt-in)**: requires an OpenAI API key saved from the options page. Click **Record audio** in the popup to begin capturing the active tab's audio via `chrome.tabCapture.getMediaStreamId` + offscreen `getUserMedia`. MediaRecorder chunks at 30 s, writes blobs to IndexedDB (`captionCapture.audioChunks`), and notifies the service worker per chunk. The service worker reads each blob, POSTs it to `api.openai.com/v1/audio/transcriptions` (`whisper-1`), appends a timestamped line to `audio_transcript:<platform>:<meetingId>:<sessionId>`, and deletes the blob. Sessions are shared with captions when both are active; audio can also run on its own (no captions required) as long as a sessionId is assigned.
  - Audio storage keys: `audio_transcript:<platform>:<meetingId>:<sessionId>` → array of `[HH:MM:SS] text` lines; `audio_meta:<platform>:<meetingId>:<sessionId>` → `{ state, startedAt, stoppedAt, chunkCount, failedChunks, lastTail, lastError, ... }`. `lastTail` (≤80 chars) is fed back to Whisper as `prompt` on the next chunk to bridge mid-sentence cuts.
  - Retry: one immediate retry on 5xx / 429, fail otherwise. Failed chunks stay in IndexedDB with `status: 'failed'` and can be retried via `RETRY_FAILED_CHUNKS`.
  - Download: `finalizeAndDownload` now emits `## Captions transcript` and/or `## Audio transcript (Whisper)` sections in the same `.md`, driven by whichever storage keys exist for the session.
- **API key handling**: stored only in `chrome.storage.local` (never `sync`). Only the service worker reads it. Offscreen doc and popup never see it. `host_permissions` is narrowed to `https://api.openai.com/*` so no other exfil endpoint is reachable.
- **Summarization (opt-in, after transcript exists)**: popup / history **Summarize** button calls `api.openai.com/v1/chat/completions` (default `gpt-4o-mini`, `response_format: json_object`) with the combined captions + Whisper transcript. The parsed JSON (keys: `summary`, `topics`, `decisions`, `actions`, `blind_spots`, `opportunities`) is stored at `summary:<platform>:<meetingId>:<sessionId>` and merged into the downloaded `.md` as sections above the transcripts. Original captions and Whisper transcripts are never modified. Summarization is the *only* write against these keys. User controls via the Options page: which sections to include, which model, the prompt template (must contain `{{transcript}}`), and an **auto-summarize on Stop capture / Download** toggle (off by default).

## Host permissions

- `https://meet.google.com/*`
- `https://teams.microsoft.com/*`
- `https://teams.cloud.microsoft/*`
- `https://teams.live.com/*`
- `https://api.openai.com/*` (Whisper transcription; only used when a user-provided API key is saved)

## API permissions

`storage`, `downloads`, `offscreen`, `tabCapture`, `activeTab`. The audio pipeline requires all five; captions alone only needs `storage` + `downloads`.

## Selector strategy

Semantic first (role, aria-label, stable `data-tid` on Teams), Google/Microsoft hashed classes only as fallbacks. Expect occasional selector churn.

## Versions

- **0.1.0**: Meet only, Serbian-focused copy.
- **0.2.0**: adds Microsoft Teams web. Platform-agnostic copy. Filename prefixed by platform. Teams selectors still being tuned against a live call.
- **0.3.0**: durability (direct rolling writes), history browser, real Teams selectors.
- **0.4.0**: Markdown output with YAML frontmatter (date, time, duration, participants, DOM-scraped meeting title). Filename extension `.md`.
- **0.5.0**: per-session storage keys so recurring meetings no longer append across days. 15-min gap auto-cuts a new session; popup **Stop capture** / **Start capture** buttons give manual control. History browser shows one row per session.
- **0.6.0**: opt-in audio capture of the active meeting tab + Whisper transcription. Offscreen document owns the MediaStream, MediaRecorder slices at 30 s into IndexedDB, service worker ships chunks to `api.openai.com/v1/audio/transcriptions`. Combined Markdown export with `## Captions transcript` and `## Audio transcript (Whisper)` sections. Options page for API key. Service worker now an ES module.
- **0.6.1**: Record audio UX fixes. Button no longer stays disabled when captions haven't fired a session yet (falls back to minting a session on BEGIN_AUDIO and infers meetingId from the tab URL). When no API key is saved, the button flips to "Set API key to record" and opens Options on click instead of silently disabling. Recycles the offscreen doc (stop + close + brief delay) before each capture start so a leftover stream cannot cause `Cannot capture a tab with an active stream`.
- **0.6.2**: audio chunks are now standalone WebM files. Earlier versions used `MediaRecorder.start(30000)` which emits header-less segments after the first chunk, so every chunk past the first failed Whisper decode. The offscreen doc now restarts the MediaRecorder per 30 s window, producing a complete standalone file each time. Popup also shows Whisper's last error on hover of the Audio status line.
- **0.7.0**: opt-in meeting summaries. **Summarize** button in the popup and per history row calls chat/completions, stores structured `{summary, topics, decisions, actions, blind_spots, opportunities}` at `summary:...`, and merges matching sections into the `.md` at download time. Transcripts are never modified. Options page gains section pickers, model dropdown, editable prompt, and auto-summarize toggle. History shows a `[SUMMARY]` badge when present.
- **0.7.1** (current): filter Material Icons ligatures so glyph identifiers like `arrow_downward` stop getting captured as participants or speakers. The captions DOM walker skips text nodes inside `material-icons` / `google-symbols` elements and rejects snake_case ligature names. `extractParticipants` and `buildMarkdown` also filter at render time, so historic sessions with garbage already saved render cleanly on download.

## Build and install

- `./build.sh` from the project root produces `../rubicon-meet-caption-capture-v<VERSION>.zip`. Version is read from `manifest.json`. The zip excludes `.git`, `PLAN*.md`, `icons/generate.html`, `icons/icon.svg`, `.DS_Store`, `build.sh`.
- For local dev: `chrome://extensions` → Developer mode → Load unpacked → pick this folder.

## Constraints and style

- Never use em dashes or hyphens as separators in prose. Hyphens only inside compound words.
- Keep brand name as `RUBICON` (uppercase).
- Dedup rolling caption updates before committing. Commit triggers: block removed, stale block superseded by newer same-speaker block (>3s), page unload flush.
- Transcripts persist across reloads; cleared only when the user clicks **Clear**.
