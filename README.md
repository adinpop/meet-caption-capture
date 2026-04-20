# RUBICON Meet Caption Capture

Captures live captions from Google Meet and Microsoft Teams web and saves them as a UTF-8 `.txt` file per meeting. Works with any caption language the platform supports (English, Serbian, and others).

## Install (unpacked, developer mode)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Pin the extension to your toolbar so the popup is reachable.

## Use

1. Join a meeting on **Google Meet** or **Microsoft Teams web**.
2. Turn on captions:
   - Meet: click the **CC** button, open its settings, pick a caption language.
   - Teams: click **More actions** (the ...), then **Turn on live captions**. Optionally set a spoken language.
3. The extension starts capturing as soon as captions appear.
4. Open the popup:
   - **Status**: Recording on Meet or Teams, Waiting for captions, or Idle.
   - **Meeting**: the meeting ID detected from the URL.
   - **Captured lines**: how many finalized caption lines are stored.
   - **Download now**: writes the current transcript to your Downloads folder.
   - **Clear**: wipes the transcript for this meeting.
5. When you leave the meeting, the extension tries to auto-download the transcript. If that misses (browser crash, forced tab close), open the popup and click **Download now**.

## File format

UTF-8 with BOM, one line per finalized caption:

```
[14:03:12] Ana Petrović: Dobro jutro svima
[14:03:18] Marko Jović: Jesmo li spremni za početak?
```

Filename: `<platform>_<YYYY-MM-DD>_<HHMM>_<participants>_<meetingId>.txt`. Example:

```
meet_2026-04-17_1403_AnaPetrovic-MarkoJovic-Adin_abc-defg-hij.txt
```

Participants are the unique speaker names seen during the meeting, sanitized to ASCII camel case, joined with hyphens, capped at 3 (with `-and-N-more` suffix when there are more speakers). Serbian Latin diacritics (č, ć, š, ž, đ) transliterate to their base letter so the filename stays portable across macOS, Windows, and Linux.

## Storage

Transcripts live in `chrome.storage.local`, keyed by platform and meeting ID. They persist across tab reloads until you click **Clear**.

## Known limits

- Selector churn: Google and Microsoft rotate their caption DOM classes. The extension prefers semantic selectors (role, aria-label, stable data-tid values), but occasional fixes are expected when either vendor reshuffles things.
- Overlapping speakers: the extension records what the platform shows. If captions merge or drop simultaneous speech, so does the transcript.
- Auto-end detection is best-effort. The **Download now** button is the safety net, and stored lines are safe on disk regardless.
- Caption quality depends on the platform's speech recognition. Accents, names, and overlapping speech suffer on both.

## Files

```
manifest.json
src/
  content/content.js            MutationObserver, dedup, adapters (Meet, Teams)
  background/service-worker.js  storage, download, message bus
  popup/popup.html|js|css       UI
icons/
  icon.svg                      master logomark icon
  icon16.png, icon48.png, icon128.png
PLAN.md, PLAN-v0.2.md           design notes
```

## Versions

- **0.1.0**: Meet only, Serbian-focused copy.
- **0.2.0**: adds Microsoft Teams web (teams.microsoft.com, teams.cloud.microsoft, teams.live.com), platform-agnostic copy, filename prefixed by platform. Teams selectors still being tuned against a real call.
- **0.3.0**: durability rewrite (rolling in-place writes direct to `chrome.storage.local`, per-meeting `meta` record, flush on `pagehide` / `beforeunload` / `visibilitychange`); new full-page history browser (`src/history/`) with per-meeting download and delete plus Clear all; real Teams caption selectors (`.fui-ChatMessageCompact`, `[data-tid="author"]`, `[data-tid="closed-caption-text"]`); content script runs in all frames so Teams sub-frames are covered.
