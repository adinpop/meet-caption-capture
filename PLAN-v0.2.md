# v0.2 Plan. Teams support and language-agnostic framing

## Context

The v0.1 extension captures Google Meet captions only, with copy that names Serbian explicitly. v0.2 generalizes the extension so it also works on Microsoft Teams web, and reframes the UI and docs so any caption language reads as a first-class case.

Scope:
1. Add Microsoft Teams web as a supported platform (teams.microsoft.com, teams.cloud.microsoft, teams.live.com).
2. Refactor the content script into a small platform-adapter interface, so platform-specific code lives in one place per platform.
3. Generalize popup and README copy so they stop implying Serbian-or-Meet-only.
4. Include the platform in transcript filenames and storage keys, so a person who uses both platforms does not get collisions.
5. Bump version to 0.2.0 and resubmit to the Chrome Web Store (domain-private).

Out of scope for this version:
- Full Teams selector fidelity. That needs a real captions DOM sample from a live Teams call, which is collected separately.
- Multi-language UI localization. English UI strings stay.
- Desktop Teams app. This is a web-only extension.

## Language support, decision

The extension is language-agnostic by design. It reads whatever text Meet or Teams render in the captions DOM. English, Serbian, or any other supported caption language work with no code change. The work here is copy only:

- README: replace Serbian-specific phrasing with "any caption language supported by Meet or Teams".
- Popup hint: say "Turn on captions. The extension follows whatever language you pick."

## Architecture, adapter pattern

Instead of splitting into many files (which adds manifest complexity for vanilla JS), the adapters live as plain objects at the top of a single content script.

Interface per adapter:

```
{
  id: "meet" | "teams",
  filenamePrefix: "meet" | "teams",
  matches(location),
  getMeetingId(location),
  isMeetingUrl(location),
  findCaptionsRoot(document),
  isCaptionBlock(el),
  extractBlockContent(el)     // returns { speaker, text } or null
}
```

The orchestrator in the same file picks the adapter by host at init and routes all DOM reads through it. Everything else (MutationObserver, dedup, idle-commit, lifecycle hooks, message bus) stays generic.

## Storage and filenames

Storage key changes from `transcript:<meetingId>` to `transcript:<platform>:<meetingId>` to avoid cross-platform collisions when the same ID format happens to collide. Old v0.1 entries remain in storage but are not auto-migrated. Users can clear them manually via the popup once each meeting wraps up.

Filename changes from `meet-<meetingId>-<stamp>.txt` to `<platform>-<meetingId>-<stamp>.txt`, e.g., `teams-19meetingfoo-20260417-1420.txt`.

## Manifest changes

Add Teams hosts to `host_permissions` and `content_scripts.matches`. Bump version to `0.2.0`.

Be aware: when an existing installation auto-updates to a version that adds new host permissions, Chrome disables the extension until the user re-grants permissions. Send a heads-up Slack note to Rubicon when the update rolls out.

## Popup changes

1. Status label shows platform: "Recording on Meet" or "Recording on Teams".
2. Meeting ID label stays, but the value comes from the adapter and can be a longer Teams-style ID.
3. Hint text generalizes.

## Verification matrix

| Host | Language | Expect |
|---|---|---|
| meet.google.com | Serbian | Captures exactly as v0.1 |
| meet.google.com | English | Captures lines, filename `meet-...` |
| teams.microsoft.com | English | Captures lines, filename `teams-...` |
| teams.cloud.microsoft | English | Same, different host |
| teams.live.com | English | Same, or gracefully shows "no captions" if this SKU is not in use at Rubicon |

## Release steps

1. Implement adapter refactor and Teams stub (this plan).
2. Collect real Teams captions HTML from a live call.
3. Harden the Teams selectors based on the real DOM.
4. Run the verification matrix.
5. Bump `manifest.json` to 0.2.0, zip, upload to the existing Web Store item, submit for review.
6. After approval, announce in Rubicon Slack and include the "you may see a permission prompt" note.

## Rough effort

- Adapter refactor: 45 min
- Teams adapter stub and manifest wiring: 20 min
- Popup and filename changes: 20 min
- Copy edits: 10 min
- Real Teams adapter tuning (after DOM sample): 1.5 to 2.5 h
- Test matrix: 30 min
- Resubmit: 10 min plus review wait
