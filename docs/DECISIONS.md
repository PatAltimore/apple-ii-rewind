# Decisions

## 2026-09-05 — Keep apple2js as the emulator core

Considered switching emulators (the brief allowed it). Stayed with [apple2js](https://github.com/whscullin/apple2js) because:

- The template's rewind, save-state, and touch-control code is built on apple2js's `Restorable` state API; reusing it was the whole point of starting from the template.
- apple2js already mounts 32MB ProDOS `.hdv` images through its SmartPort card and boots them from slot 7, which is exactly what Total Replay needs (Enhanced //e, 128K, 65C02, hard drive).
- Alternatives (Apple2TS, MAME/WASM builds) would have meant rebuilding the UI and state plumbing from scratch for no functional gain.

The one real cost is that apple2js's SmartPort block I/O is asynchronous (each block read resolves on a later frame), so game launches take a second or two longer than on real hardware. Acceptable; revisit with a synchronous block-disk shim if it becomes annoying.

## 2026-09-05 — Exclude the hard drive from snapshots

`SmartPort.getState()` copies every block of the mounted drive (32MB) and is `async`, which `Apple2IO.getState()` doesn't await. Snapshots therefore wrap the card (`SnapshotExcludedCard` in `web/src/emulator/EmulatorController.ts`) so they contain only CPU/video/MMU/RAM (~170KB) and leave the live drive untouched on restore. Consequence: the drive's prefs/high-score writes are not rewound, and they are lost on page reload (the image is re-downloaded fresh). Persisting dirty blocks to IndexedDB is a possible follow-up.

## 2026-09-05 — IndexedDB for save states

The template used localStorage with base64-encoded snapshots. With a library of hundreds of games and ~170KB per snapshot, localStorage's ~5MB cap is too small. IndexedDB stores the `State` object directly via structured clone (typed arrays included), with a much larger quota and no encoding step.

## 2026-09-05 — Ship the disk image in the repo

`web/public/disks/TotalReplay.hdv` (32MB, v6.1, sha256 `7434fb5d…64be`) is committed rather than fetched from archive.org at build or run time: archive.org downloads are slow and rate-limited, and the site should not depend on a third party being up. Well under GitHub's 100MB file limit and Azure Static Web Apps' 250MB app size limit.

## 2026-09-05 — F2 for rewind, Delete for Ctrl-Reset

The template's Backspace-to-rewind shortcut collides with the //e Delete key that Total Replay's search box uses, so rewind moved to F2 (an app-only hotkey never forwarded to the emulator). Keyboard Delete keeps apple2js's mapping to Ctrl-Reset, which in Total Replay is "quit to menu" — and an accidental press is recoverable via rewind.
