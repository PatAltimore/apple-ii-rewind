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

## 2026-09-08 — Applesoft: a real cold boot (`?boot=basic`), not a mid-session jump

The first attempt (`breakToApplesoft()`) jumped a *running* Total Replay session's CPU straight to Applesoft's `RESTART` entry ($E003 → $D43C, found by reading the ROM's own bytes live — reference-doc addresses were wrong twice during this work). Patched enough state by hand (text window/cursor zero page, TEXT/PAGE1 softswitches, `EmptySlotStub` — an RTS-for-everything card — in slots 1-6 so the //e's real "touching $C100-$C7FF banks in $C800 expansion ROM" hardware behavior didn't hang the CPU probing empty ones) to get a correctly-rendering, correctly-echoing prompt. But pressing Return to submit a line reliably dropped into the machine-language monitor instead of executing it, reproducing even with *no* patches applied at all — evidently `RESTART` depends on further state (most likely BASIC's zero-page program/variable pointers, `$67 TXTTAB` onward) that only a genuine cold boot sets up, which no amount of hand-patching individual variables was reproducing correctly within reasonable effort.

Replaced entirely with a real cold boot instead of trying to patch around a warm jump: `?boot=basic` in the URL makes `main.ts` skip mounting Total Replay's drive, so the //e's own ROM autoboot logic does exactly what real hardware does with no bootable device anywhere — falls through to a correctly-initialized Applesoft prompt on its own, via the exact same `bootEmulator()` → `apple2.reset()` → `apple2.run()` path already proven for Total Replay itself. `EmptySlotStub` (still needed — the same slot-probing hang happens during a real autostart scan, not just a warm jump) is now an opt-in `bootEmulator()` option instead of something `breakToApplesoft()` installed itself, so it never touches the hundreds of already-verified-working Total Replay games. Verified live end-to-end: `PRINT 6*7` executed and printed `42`, back to a fresh `]` — the actual bar ("use Applesoft"), not just a rendering prompt.

Trade-off, and the reason this design was acceptable: since nothing is ever mounted in this mode, there's no soft reset vector for Ctrl-Reset to return to, so the only way back to Total Replay is a full navigation away from `?boot=basic` (the `] Applesoft` button and the in-page "⏏ Total Replay" link both just do that). No in-session round trip between the two — confirmed fine for this app's use case rather than assumed.

## 2026-09-08 — Fullscreen canvas sizing computed in JS, not left to CSS alone

The first version letterboxed the fullscreened game view with CSS alone (`aspect-ratio` + `max-width`/`max-height` on the canvas). Correct on paper, but there was no way to verify it live: this browser's own automation sandbox refuses Fullscreen API requests outright (`Permissions check failed`, likely iframe permissions-policy — confirmed by calling `requestFullscreen()` directly in the console), so the CSS could only ever be reasoned about, not seen. Given feedback that the letterbox was larger than expected, moved the sizing into JS instead: `ui/Fullscreen.ts`'s `fitCanvasToViewport()` computes the exact largest width/height at the game's native 592:416 ratio that fits `window.innerWidth`/`innerHeight`, and sets it as an inline style on `fullscreenchange` (and `resize`, for e.g. an external display change while active). Inline styles win over any CSS rule regardless of specificity, so this is now the authoritative sizing; the CSS `:fullscreen` rule stays only as a fallback for the instant before the JS handler runs.

Verified what could be verified without live Fullscreen: the arithmetic by hand for several real screen ratios (16:9, 4:3, ultrawide, portrait tablet — each correctly saturates whichever dimension the aspect-ratio mismatch allows), and that an inline `width`/`height` set on the canvas actually renders at that exact size (`getBoundingClientRect()` matched the set value) rather than being overridden by some other rule. Not verified: the real Fullscreen API code path itself, since the harness can't engage it — worth a real-browser check next time this file changes.

## 2026-09-08 — Applesoft: key-legend visibility bug, and Backspace needs $08 not $7F

Two follow-up fixes after using `?boot=basic` for real.

**Key-legend/controls not actually hiding.** `body.applesoft-mode .key-legend { display: none; }` and its siblings had the *same specificity* (two class selectors) as `body.force-keyboard-controls .key-legend { display: flex; }` down in the "Touch vs keyboard UI selection" block, and came *before* it in the file — so a visitor who had ever clicked "Switch to keyboard controls" (a persistent, `localStorage`-backed choice from an earlier Total Replay session) would still have `force-keyboard-controls` set on `<body>` on returning here, and by CSS's equal-specificity/source-order tiebreak, that later rule won, leaving the movement-key legend and the Applesoft/Fullscreen button row visible. Reproduced live by setting that `localStorage` key by hand. Fixed by moving the whole `body.applesoft-mode` hiding block to *after* the force-touch/force-keyboard rules, so it wins by source order the same way that block's own comment already documents winning over its own base rules.

**Backspace echoed a block glyph instead of erasing.** Confirmed by direct memory inspection (not just screenshots, which the harness's own frame-timing issues made unreliable — see below): at the `]` prompt, sending ASCII 127 (`DELETE`, apple2js's own default mapping for the physical Backspace key) is *not* recognized by this ROM's `GETLN` as an erase — it's treated as an ordinary printable character, appended to the line and echoed as a solid block. Sending ASCII 8 (`$08`, the classic Apple II left-arrow/BS code) instead correctly erases the previous character from both the screen and the line `GETLN` actually parses — confirmed by backspacing over a wrong character, typing the correction, hitting Return, and reading back a text-page dump showing exactly the corrected line, not both keystrokes concatenated. `keyboard.ts`'s new `backspaceAsLeftArrow` option remaps it, on only in `BASIC_BOOT_MODE`; Total Replay's own input handling (search box, in-game text entry) is untouched, since it almost certainly doesn't route through bare Applesoft `GETLN` the way a cold-booted prompt does, and nothing here tests it against this remap. The existing "reserve Backspace for the fullscreen rewind hotkey" behavior is also now off in `BASIC_BOOT_MODE` (`reserveFullscreenBackspace: false`) so Backspace reaches the emulator for editing even while fullscreen, since there's no game session to rewind through there.

Also worth recording: this session's automation harness intermittently drops keystrokes sent faster than roughly one every 1-2 real seconds (confirmed live — identical key sequences at 300-800ms spacing lost characters unpredictably, while the same sequences at 2s+ spacing were reliable every time), and separately throttles the emulator's `requestAnimationFrame`-driven run loop to a near-standstill whenever the Browser pane is backgrounded (confirmed via `tabs_context` reporting "hidden" during an apparent hang, PC frozen at the exact reset entry point). Neither is a real app bug; both cost significant time to tell apart from one while debugging this feature. A real, focused browser tab does not have either limitation.

## 2026-09-10 — Applesoft mode: a host-side CATALOG/LOAD/SAVE disk, no DOS

`?boot=basic` is a bare Applesoft cold boot with **no DOS** (see the 2026-09-08 entry), so `CATALOG`/`LOAD`/`SAVE` don't exist there. Two implementation routes were on the table: mount a real DOS 3.3 floppy (authentic commands for free, but depends on apple2js's DiskII **sector-write** path, which this Vite build has never exercised, and would mean persisting a whole disk image), or implement the commands host-side in TS. Went host-side — it also matches what the feature actually is (a small, editable set of program *files* in `localStorage`, seeded from a `disk/`-style folder), and leaves a clean seam for a future "disk 2" that mounts a real archive.org image behind the same command parser (which already accepts a DOS-style `,Dn` suffix — `CATALOG,D2` today answers "DRIVE 2 NOT CONNECTED").

How the interception works, since there's no KSW hook and no 6502 stub: `keyboard.ts` keeps a shadow copy of the line being typed at the `]` prompt (append printable keys, pop on Backspace, give up on any editing key it doesn't model) and calls `onLineSubmit(line)` the instant Return is pressed — *before* the keystroke reaches the emulator. If the line is one of our commands, the handler (`src/disk/commands.ts`):

1. does the work — for `LOAD`/`SAVE` that's copying the tokenized program image straight in/out of memory at `$0801` and setting the zero-page pointers (`$67`/`$69`/`$6B`/`$6D`/`$AF`) exactly as DOS's LOAD leaves them; apple2js's own `js/applesoft` compiler/decompiler do the text⇄token work for the Copy/Paste buttons;
2. draws any output (the catalog, an error line) **directly onto the text screen** via `src/emulator/AppleTextScreen.ts` — a small re-implementation of the `$FBxx` video routines (interleaved row addresses, `$20`-`$23` window vars, scroll) — because Applesoft's `GETLN` is still mid-line and can't print for us;
3. pokes `$00` into the input buffer at `$0200`, so when the swallowed Return does land, `GETLN` returns an empty line and Applesoft just reprints `]` — no `?SYNTAX ERROR`.

Anything not recognised is left completely alone. Verified live end-to-end: `CATALOG` lists the seeded programs and returns a clean prompt; `LOAD LEMONADE` puts a byte-identical image at `$0801` with `VARTAB`=`$801`+len; `LOAD COLORLOOP` then `LIST`/`RUN` shows and runs the real program; type-`SAVE MYPROG`-`NEW`-`LOAD MYPROG`-`LIST` round-trips through `localStorage` and survives a page reload; `PRINT 6*7` still prints `42`.

**The programs are fetched, not committed** — same call as the Total Replay image. `web/scripts/fetch-basic-programs.mjs` (zero deps; the user's network can't reach npmjs.org) downloads DOS 3.3 images from archive.org — Lemonade Stand (1979), the DOS 3.3 System Master (1980), the Applesoft Sampler — verifies each SHA-256, walks the DOS 3.3 VTOC/catalog inline, and writes each picked Applesoft file's tokenized image to `web/public/disks/programs/` (gitignored) plus a `manifest.json`. `LocalStorageDisk` seeds those into `localStorage` on first load (keyed by a manifest-hash "seed version"). Each index entry records whether it came from the seed; a new seed version prunes seeded entries the new manifest dropped and re-adds the rest, while user `SAVE`s (and any file a user saved over a seed name) are marked not-seeded and survive untouched.

Only Applesoft (DOS type `A`) files are taken. Several fondly-remembered System Master demos — **APPLEVISION** (the dancing stick figure), `ANIMALS`, `COLOR DEMO`, `BIORHYTHM` — are **Integer BASIC** (type `I`): a different tokenization and a different interpreter (the `>` prompt, language-card banked), so they can't be `LOAD`ed into the Applesoft `]` prompt this layer drives. Adding them would mean a second tokenizer/detokenizer and Integer-BASIC mode handling — deferred. `fetch-basic-programs.mjs --list [url…]` dumps a disk's full catalog with types, for finding candidates.

**On-screen controls are opt-in in Applesoft mode.** Some of the seeded programs read the paddles/buttons (Little Brick Out is a paddle game). `attachTouchControls` is already wired in this mode — only the CSS hid the panel — so a "🕹 On-screen controls" toggle in `.controls-basic` just adds an `applesoft-touch` body class that un-hides `.touch-controls` (`body.applesoft-mode.applesoft-touch .touch-controls`, three classes, outranks the hide rule and the `force-*` rules in both directions). Defaults on for coarse-pointer devices, off for mouse, and the choice is remembered (`apple-ii-rewind:applesoft-touch`). The panel's own "Switch to keyboard/touch controls" link is hidden here — this toggle is the control. Verified live: the on-screen joystick drives `_paddle[0]`/`[1]` `0↔1` (0.5 at rest, recentres on release), and Little Brick Out loads and runs.

**Clipboard is buttons, not typed commands.** `navigator.clipboard.readText()` needs a genuine user gesture; a command recognised after an emulated Return isn't one. `⧉ Copy program` / `⇤ Paste program` are real `<button>`s; Paste runs `validateListing()` (every non-blank line starts with an in-range line number, and the whole thing tokenizes) before touching memory. In the automation harness `readText` is denied outright even from a click — the app catches that and says so; the happy path was verified by stubbing `readText`.

## 2026-09-10 — Load other disks from the Internet Archive (curated list + paste-a-URL)

Total Replay mode grew a **Disk** row: a `<select>` of curated archive.org titles
(`web/public/disks/library.json` — pointers only, committed, editable), a URL box for any
other disk image, and a **⏏ Total Replay** button.

**Switching disks reloads the page** with `?disk=<url>` (Total Replay = no parameter);
`main.ts` mounts that image *before* the initial `apple2.reset()`, so it boots through the
exact same path as a normal load. The first attempt did it at runtime — mount the new
image, then a `coldReset()` (zero `$3F2`/`$3F3`/`$3F4` to invalidate the power-up byte so
the ROM re-runs its slot scan instead of warm-jumping the old `$3F2` vector). It worked
once, then reliably dropped into the monitor / hung the CPU spinning in slot 2's ROM space:
a mid-session cold reset leaves MMU and soft-switch state from the previous disk (INTCXROM,
the `$C800` expansion-ROM latch, language-card banking) that derails the slot scan — the
same class of failure that made `?boot=basic` a real reload rather than a jump (2026-09-08
entry), and the same slot-2 hang that `EmptySlotStub` exists for. A full navigation is the
only reliably clean cold boot, and it makes disk links shareable for free. `coldReset()` was
removed; `loadImageFromUrl()` no longer resets — the caller does.

**CORS: the archive.org `/download/` URL is not directly fetchable.** Those responses carry
no `Access-Control-Allow-Origin`, so a browser can't read them cross-origin. The Internet
Archive runs `https://cors.archive.org/cors/<item>/<file>`, which reflects the Origin and
honours `Range`. `toFetchableUrl()` (`src/emulator/imageFormat.ts`) rewrites `/download/…`,
datanode `…/items/<item>/<file>`, and already-proxied links to that form; a `/details/…`
page URL is rejected with a "use Show all files" message; non-archive.org URLs pass through
untouched for a user's own CORS-enabled host.

**Two cards, picked by sniffing the bytes.** The build only had the SmartPort hard-drive
card (slot 7). 5.25″ floppies — the bulk of what's on archive.org — need a Disk II card, so
one is now wired into **slot 6** in non-`?boot=basic` mode. `sniffImage()` decides by
extension, then by size for the ambiguous ones: `.hdv` / big `.2mg` / big `.po`
(> 256 KB, 512-multiple) → SmartPort; `.dsk` `.do` `.po`@140K `.d13` `.nib` `.woz` → Disk
II. `.woz`/`.2mg` are recognised by magic too. Block images `mount()` into SmartPort
drive 1; floppies `setBinary()` into Disk II drive 1 after `unmount()`ing SmartPort so the
boot scan lands on slot 6.

**Disk II without the format Web Worker.** apple2js's `DiskII` normally offloads image
decoding to `dist/format_worker.bundle.js`, which this Vite build doesn't produce.
`createFloppyCard()` constructs the card with `window.Worker` hidden, so `initWorker()`
early-returns and `setBinary()` takes its synchronous `createDisk()` fallback — fine for
140 K. The card is a `DiskII` subclass whose `getState()`/`setState()` are stubbed
(`{ excludedFromSnapshot: true }`, 29 bytes) exactly like `SyncSmartPort`, keeping a mounted
floppy out of the ~170 KB rewind/save snapshots. Not wired in `?boot=basic` (slots 1-6 are
`EmptySlotStub` there; an empty Disk II in slot 6 would hang that mode's fall-through boot).

**No explicit `PR#6`.** With a floppy image, `?disk=` mounts it in Disk II drive 1 and
leaves SmartPort slot 7 empty. The SmartPort boot ROM does `JMP $FABA` ("scan the next
lower slot") when its drive 1 is empty, so the //e's own boot scan reaches the slot 6 Disk
II and boots it. Block images go in slot 7, which the scan hits first.

A bad `?disk=` (unreachable, unrecognised format) is caught: the page falls back to mounting
Total Replay and shows the error next to the disk name, so the machine is never left dead.

The dropdown lists only other disks — Total Replay is not an entry in it (the **⏏ Total
Replay** button is how you go back). A pasted URL that isn't one of the curated titles shows
as a one-off "Custom disk" row so the box reflects what booted.

Verified live: the built-in **Total Replay** boots through the unified path; **The Oregon
Trail** from the dropdown reloads to `?disk=…` and boots from slot 6; a pasted raw
`archive.org/download/…` link to the **DOS 3.3 System Master** rewrites and boots to DOS; a
pasted `.hdv` boots from SmartPort; **⏏ Total Replay** returns cleanly from any of them,
including floppy → floppy → Total Replay (the chain the old runtime-reset approach hung on);
a `/details/` URL shows the error; `?boot=basic` still cold-boots Applesoft; snapshot card
state stays 29 bytes with a floppy mounted.

## 2026-09-11 — Collapsible control sections, Applesoft moved into the disk panel

Touch controls, the keyboard-shortcut legend, and the disk-image switcher are each now a
native `<details>`/`<summary>` panel below the rewind bar, in that order (touch, keyboard,
disk), all `open` by default. The `] Applesoft` button moved out of the desktop-only row and
into the disk-image panel, ahead of the disk dropdown/URL box/Find/⏏ Total Replay — it's
another way to switch what's booted, so it belongs there rather than paired with Fullscreen.

**No new wrapper elements for touch/keyboard.** `.touch-controls` and `.key-legend` — the
exact divs the "Touch vs keyboard UI selection" CSS block already toggled `display:none`/
`flex` on by device (`(pointer:coarse)`) and by the persisted `force-touch-controls`/
`force-keyboard-controls` choice (ControlModeSwitch.ts) — became `<details>` elements
directly, with a `<summary class="section-summary">` as their first child. `[open]`
independently controls the *content* below the summary; `display` (still set by the exact
same selectors as before) controls whether the whole element, summary included, renders at
all. This means the collapse behavior needed zero changes to the specificity-sensitive
exclusivity rules documented in the 2026-09-05 entry — only additive `border`/`padding`/
`summary` styling. The disk-image panel, having no such per-device exclusivity to reuse,
got a genuinely new `<details class="control-section disk-section">` wrapper around the
unchanged `.controls.controls-disk` row; `.disk-section` was added to the existing
`body.applesoft-mode` hide list (the `.controls` rule there only reaches the inner row, not
this new outer wrapper).

**Applesoft mode's own touch panel suppresses the new summary.** `.touch-controls` is the
same element Applesoft mode's "🕹 On-screen controls" toggle shows/hides via
`body.applesoft-mode.applesoft-touch .touch-controls { display: flex }` — so without
anything else, a collapse header would appear there too, redundant with
that toggle. `body.applesoft-mode .touch-controls > .section-summary { display: none }`
hides just the header (matching the pre-existing suppression of `.control-mode-switch` in
the same spot); `[open]` still applies underneath, so the joystick stays fully shown, exactly
as before this change.

Verified live: collapsing/expanding each of the three sections leaves the others untouched;
"Switch to touch controls" still swaps which of touch/keyboard shows (collapse state
persists per-section through the swap, since it's independent of the `display` toggle);
mobile emulation shows touch open + disk open with keyboard absent, matching the requested
touch → keyboard → disk order; `?boot=basic` hides all three (including `.disk-section`, the
one case needing a new rule) and its own On-screen-controls toggle shows the joystick with no
duplicate header; the relocated `] Applesoft` button and the disk Load/Find/⏏ Total Replay
buttons all still work from their new nesting. `tsc`/`npm run build` clean.

Same-day follow-up: `.touch-controls`' and `.key-legend`'s `<summary>` text started as
"🕹 Touch controls" / "⌨ Keyboard controls" but was unified to plain "🎮 Controls" for both —
only one of the two ever renders at a time (the exclusivity CSS above), and each one's own
content includes the button to switch to the other, so a mode-specific label read as if it
only covered that mode rather than being the single "controls" section for whichever is
currently active.

Same-day follow-up: converting `.touch-controls`/`.key-legend` to `<details>` above ran into
`::details-content` — the anonymous box modern Chromium/Firefox now wrap everything after
`<summary>` in. `flex-direction: column; gap` declared on `.touch-controls`/`.key-legend`
themselves only ever spaced the summary from that box as a whole; the rows *inside* it (the
stick/buttons row, the joystick-options toggle row, the keys row, the hint) collapsed flush
against each other, since inside that anonymous box they're just plain block children with no
margin. Fixed by re-declaring the same `display: flex; flex-direction: column; gap` on
`.touch-controls::details-content` / `.key-legend::details-content`; browsers without that
pseudo-element ignore the rule and keep using the outer element's own flex/gap as before, so
this is purely additive.

## 2026-09-11 — Gamepad buttons never worked: `initGamepad()` was never called

A connected Xbox controller's analog stick moved the paddles (README already claimed gamepad
support), but no button did anything — reported live by the user. apple2js's gamepad module
(`js/ui/gamepad.ts`) keeps its button map in `gamepadMap`, a module-level array that starts
empty; `processGamepad()` (called every frame from `Apple2.run()`) reads paddle axes into
`io.paddle()` unconditionally, but only fires `io.buttonDown()`/`keyDown()` for button indices
present in that map. The map is populated by `initGamepad()` — which apple2js's own reference
UI (`js/ui/apple2.ts`, a full app this project doesn't use) calls in several places, but which
this project's from-scratch `main.ts`/`EmulatorController.ts` never called at all. So the
stick half of "act as the joystick" worked and the button half silently didn't, for every user,
since gamepad support was added.

Fixed with a single `initGamepad()` call in `bootEmulator()` (`EmulatorController.ts`), right
after the existing paddle-centering lines — same one-time-setup spot, no args so it takes
apple2js's `DEFAULT_GAMEPAD` map (Xbox-style layout: `A`/`B`/`L1`/`R1` → paddle buttons 0/1,
`START` → Esc). No UI for remapping exists or was requested, so the default is left as the
only option.

Not verified live with a physical controller (no gamepad hardware reachable from the
browser-automation tool used for this session's testing) — verified by reading
`processGamepad()`/`initGamepad()` to confirm the map was the only missing piece, and that
`tsc`/`npm run build` stay clean. Asked the user to confirm with their controller.
