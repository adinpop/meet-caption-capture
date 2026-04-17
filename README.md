# Meet Caption Capture

Captures Google Meet live captions to a UTF-8 `.txt` file per meeting. Works with any caption language Meet supports (Serbian included).

## Install (unpacked, developer mode)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Pin the extension to your toolbar so the popup is reachable.

## Use

1. Join a Google Meet.
2. Click the **CC** button in Meet. Open its settings and set **Caption language** to Serbian (or whatever you need).
3. The extension starts capturing as soon as captions appear.
4. Open the popup:
   - **Status**: Recording / Waiting for captions / Idle
   - **Meeting**: the meeting ID
   - **Captured lines**: how many finalized caption lines are stored
   - **Download now**: write the current transcript to your Downloads folder
   - **Clear**: wipe the transcript for this meeting
5. When you leave the meeting, the extension tries to auto-download the transcript. If that misses, open the popup and click **Download now**.

## File format

UTF-8 with BOM, one line per finalized caption:

```
[14:03:12] Ana Petrović: Dobro jutro svima
[14:03:18] Marko Jović: Jesmo li spremni za početak?
```

Filename: `meet-<meetingId>-<YYYYMMDD-HHMM>.txt`

## Storage

Transcripts live in `chrome.storage.local`, keyed by meeting ID. They persist across tab reloads until you click **Clear**.

## Known limits

- Selector churn: Google rotates the captions DOM classes. The extension prefers semantic selectors (`role="region"` with a caption-ish `aria-label`), but occasional fixes are expected.
- Overlapping speakers: the extension records what Meet shows. If Meet merges or drops simultaneous speech, so will the transcript.
- Auto-end detection is best-effort. Browser crashes can skip the final flush. **Download now** is the safety net, and stored lines are safe on disk regardless.
- Meet's Serbian ASR is decent but imperfect; accents, names, and overlapping speech suffer.

## Files

```
manifest.json
src/
  content/content.js            # MutationObserver, dedup, finalize
  background/service-worker.js  # storage, download, message bus
  popup/popup.html|js|css       # UI
PLAN.md                         # design notes
```
