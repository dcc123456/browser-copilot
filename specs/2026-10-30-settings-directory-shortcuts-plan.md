# Settings · directory shortcuts and installation info · plan

Date: 2026-10-30
Status: implementing

## Requirement (dcc)

1. The download-folder section needs a quick "open the folder" entry so the user
   does not have to navigate to it by hand.
2. Settings needs to show the installation directory and offer a quick way to
   open it.

## Platform findings (verified in a real unpacked build)

- A folder chosen with `showDirectoryPicker` is a `FileSystemDirectoryHandle`;
  Chrome exposes **no absolute path and no "reveal in Finder/Explorer"** for it.
  An extension page therefore cannot open it like a native app would.
- What is available and verified:
  - `showDirectoryPicker({ startIn: handle })` opens the native folder dialog
    already anchored at that folder (one click, no tree navigation).
  - `chrome.downloads.showDefaultFolder()` opens the browser's default Downloads
    folder in Finder/Explorer.
  - `chrome.management.getSelf()` answers without an extra permission
    (`installType: development` on an unpacked build).
  - `chrome.tabs.create({ url: 'chrome://extensions/?id=<id>' })` opens the
    extension's card; unpacked installs show the source path there with a
    "Show in folder" action. The extension cannot read that path itself.
- dcc's ruling: download section gets **both** entries (locate + system
  Downloads); installation shows **info + the extensions-page entry** (not a
  remembered handle).

## Decisions

- Download card: 「定位到该目录」 (anchored picker, result ignored — it is a
  finder action, not a reconfiguration) and 「打开系统下载文件夹」
  (`showDefaultFolder`). The configured handle is kept in state so the picker is
  called synchronously inside the click (awaiting first would lose the user
  gesture).
- Installation card (above the update card): version, install type
  (development / store / other via `getInstallType`), extension id, and the
  `chrome-extension://` URL, plus 「打开扩展程序页」. The button is hidden when the
  origin is not `chrome-extension://` (Firefox builds), so no dead `chrome://`
  link is offered.
- All copy is bilingual (`en` + `zh-CN`); values use semantic Tailwind tokens.

## Files

- `src/lib/i18n.ts` — new download/install strings, both languages.
- `src/sidepanel/SettingsTab.tsx` — locate/system-download actions, installation
  card.

## Verification

Typecheck, full tests, lint/format on changed files, build, and the Playwright
probe (`tmp/settings-dirs-probe.mjs`): configure an OPFS handle, assert the
locate picker receives `startIn` = that folder, assert `showDefaultFolder` is
called, assert the install card values and that the extensions-page button opens
the right card. Result: 9/9 assertions.
