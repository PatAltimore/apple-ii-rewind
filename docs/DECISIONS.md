# Decisions

## 2026-09-05 — Keep apple2js as the emulator core

Considered switching emulators (the brief allowed it). Stayed with [apple2js](https://github.com/whscullin/apple2js) because:

- The template's rewind, save-state, and touch-control code is built on apple2js's `Restorable` state API; reusing it was the whole point of starting from the template.
- apple2js already mounts 32MB ProDOS `.hdv` images through its SmartPort card and boots them from slot 7, which is exactly what Total Replay needs (Enhanced //e, 128K, 65C02, hard drive).
- Alternatives (Apple2TS, MAME/WASM builds) would have meant rebuilding the UI and state plumbing from scratch for no functional gain.

The one real cost is that apple2js's SmartPort block I/O is asynchronous (each block read resolves on a later frame), so game launches take a second or two longer than on real hardware. Acceptable; revisit with a synchronous block-disk shim if it becomes annoying.

## 2026-09-05 — Exclude the hard drive from snapshots

`SmartPort.getState()` copies every block of the mounted drive (32MB) and is `async`, which `Apple2IO.getState()` doesn't await. The app therefore uses its own card (`web/src/emulator/SyncSmartPort.ts`, which also makes block I/O synchronous — see the first entry) whose state is empty, so snapshots contain only CPU/video/MMU/RAM (~170KB) and leave the live drive untouched on restore. Consequence: the drive's prefs/high-score writes are not rewound, and they are lost on page reload (the image is re-downloaded fresh). Persisting dirty blocks to IndexedDB is a possible follow-up.

## 2026-09-05 — IndexedDB for save states

The template used localStorage with base64-encoded snapshots. With a library of hundreds of games and ~170KB per snapshot, localStorage's ~5MB cap is too small. IndexedDB stores the `State` object directly via structured clone (typed arrays included), with a much larger quota and no encoding step.

## 2026-09-05 — Do not commit the disk image

`web/public/disks/TotalReplay.hdv` (32MB, v6.1, sha256 `7434fb5d…64be`) was committed in the first revision and then removed: it is a collection of copyrighted games, and 32MB of binary in every clone is unwelcome. `web/scripts/fetch-total-replay.mjs` (`npm run fetch-disk`) downloads it from archive.org and verifies the checksum; the Azure workflow runs it before each build. Trade-off: builds now depend on archive.org being reachable. The blob remains in the repo's early history unless that is rewritten.

## 2026-09-05 — F2 for rewind, Delete for Ctrl-Reset

The template's Backspace-to-rewind shortcut collides with the //e Delete key that Total Replay's search box uses, so rewind moved to F2 (an app-only hotkey never forwarded to the emulator). Keyboard Delete keeps apple2js's mapping to Ctrl-Reset, which in Total Replay is "quit to menu" — and an accidental press is recoverable via rewind.

## 2026-09-07 — Cache the disk image with the Cache Storage API, not just HTTP headers

Without any application-level caching, `main.ts` called `fetch()` on the 32MB disk image every page load; whether that actually hit the network depended entirely on the browser's HTTP cache honoring `staticwebapp.config.json`'s `Cache-Control: public, max-age=86400` on `/disks/*` — which caps out at 24 hours and browsers are free to evict sooner (storage pressure, private browsing).

`web/src/emulator/DiskCache.ts` now stores the fetched image in Cache Storage explicitly (`getCachedDisk`/`putCachedDisk`, wired into `loadBlockImageFromUrl` in `EmulatorController.ts`) so a returning visit boots straight from local storage with no network request at all, indefinitely — not just within a day. Verified live: reload after a first load shows no second network request for the `.hdv` and the boot overlay reads "Loaded from local cache".

Correctness risk: the image is always fetched from the same fixed URL (`/disks/TotalReplay.hdv`), so if `fetch-total-replay.mjs`'s pinned version is ever bumped, the *bytes* at that URL change without the URL changing — a naive URL-keyed cache would then serve stale bits forever. Fixed by caching a small version-marker string alongside the image and comparing it against `DiskCache.ts`'s `DISK_VERSION` constant on every load; a mismatch is treated as a cache miss (re-fetched and overwritten). Verified live by hand-downgrading the cached marker to an old version and confirming it triggered a re-fetch and restored the marker. Consequence: bumping the disk image version now requires updating two files (`fetch-total-replay.mjs` and `DiskCache.ts`) — each has a comment pointing at the other.
