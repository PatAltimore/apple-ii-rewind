# Apple II Rewind — Total Replay in the browser

A browser-playable Apple II running [Total Replay](https://archive.org/details/TotalReplay) (4am's curated hard-drive collection of hundreds of Apple II games), with a gameplay rewind buffer, save/load states, and on-screen joystick and buttons for phones and tablets.

Play it at [https://red-island-06620351e.3.azurestaticapps.net/](https://red-island-06620351e.3.azurestaticapps.net/). The first visit downloads the 32 MB disk image; the browser then caches it (via the Cache Storage API, not just HTTP headers), so later visits skip the download and boot straight from the cached copy. Clearing site data, or a private/incognito window, forces a fresh download.

Built from the [prince-of-persia-assist](https://github.com/PatAltimore/prince-of-persia-assist) project as a template, minus that game's hints, cheats, and source-code panes.

## What this is

- A real Apple II system emulator ([apple2js](https://github.com/whscullin/apple2js), Enhanced //e, 128K, 65C02) booting the unmodified Total Replay v6.1 `.hdv` image from an emulated SmartPort hard-drive controller in slot 7.
- **Rewind**: a snapshot is taken every 2 seconds and kept for 5 minutes. Drag the slider to scrub back through recent play (with a thumbnail preview), or hit **⏪ -5s** / <kbd>F2</kbd>.
- **Save / Load State**: named snapshots with thumbnails, stored in the browser's IndexedDB. Snapshots are ~170KB, so there is room for hundreds.
- **Touch controls** on phones/tablets: a floating 8-way joystick with a self-centering toggle (off, it stays where you leave it, like the switch on a CH Mach III or Kraft stick), or, toggled to "Keys", keyboard presses with typematic repeat: arrow keys for the launcher and //e games, or the I/J/K/M, I/J/K/L, A/Z+arrows and Q/W/E/A/D/Z/X/C layouts older games used), two fire buttons labelled by button number with a swap toggle (games that use both, like Raster Blaster, disagree on which side is button 0), Esc/Space/Return keys, and a **⌨ Type** button that brings up the device keyboard for searching the library.
- USB/Bluetooth gamepads are picked up by apple2js's Gamepad API support and act as the joystick.
- **Desktop-only extras**: **⛶ Fullscreen** puts the game view in true chromeless fullscreen, scaled to the largest size that fits your screen at the game's native aspect ratio (Escape — the browser's own built-in gesture — leaves it; <kbd>F2</kbd>/<kbd>Backspace</kbd> still rewind while fullscreen even without the visible bar). **] Applesoft** leaves Total Replay for a freshly cold-booted, fully interactive Applesoft BASIC prompt — no disk mounted, same as a real Apple II with nothing to boot from. The in-page **⏏ Total Replay** link (or reloading without `?boot=basic`) goes back.
- **A classic-programs disk in Applesoft mode**: `?boot=basic` has no DOS, so a small host-side layer implements `CATALOG`, `LOAD` *name*, `SAVE` *name* and `DELETE` *name* typed at the `]` prompt, backed by `localStorage`. It is seeded with real Applesoft programs that shipped with the Apple II — Lemonade Stand, Little Brick Out, Color Demosoft, Brian's Theme and more — fetched from archive.org at build time (see below). `SAVE` keeps your edits in that browser. Two buttons handle the clipboard (which needs a real click, not a keystroke): **⧉ Copy program** puts the current listing on the clipboard, **⇤ Paste program** loads an Applesoft listing from it after checking it parses. **🕹 On-screen controls** shows the same joystick and buttons Total Replay uses, for paddle programs like Little Brick Out (turn off *Self-centering* so the paddle holds position).

## Controls

| Input | Apple II |
|---|---|
| Arrow keys, letters, Return, Esc | As labelled |
| Left <kbd>Alt</kbd> / right <kbd>Alt</kbd> | Open-Apple (button 0) / Closed-Apple (button 1) |
| <kbd>Delete</kbd> or the **⏏ Menu** button | Ctrl-Reset — Total Replay quits the running game back to its menu |
| <kbd>F2</kbd> | Rewind 5 seconds (app hotkey, not sent to the emulator) |

## Provenance

| Component | Source | License | Role |
|---|---|---|---|
| Total Replay v6.1 | [archive.org/details/TotalReplay](https://archive.org/details/TotalReplay) · [source](https://github.com/a2-4am/4cade) | Launcher: MIT (© 2019–2026 4am). Games and artwork belong to their respective authors. | Downloaded to `web/public/disks/TotalReplay.hdv` by `npm run fetch-disk` (gitignored); mounted read/write in memory (changes are lost on reload) |
| Emulator core | [whscullin/apple2js](https://github.com/whscullin/apple2js) (`web/vendor/apple2js`, submodule) | MIT | Runs the image client-side; see `web/vendor/PROVENANCE.md` |
| Applesoft-mode programs | [Lemonade Stand (1979)](https://archive.org/details/Lemonade_Stand_1979_Apple) · [DOS 3.3 System Master (1980)](https://archive.org/details/DOS_3.3_System_Master_16_Sector_Version_Apple_1980) · [Applesoft Sampler](https://archive.org/details/Applesoft_Sampler) | © Apple Computer, Inc. | ~13 short Applesoft programs extracted by `npm run fetch-programs` into `web/public/disks/programs/` (gitignored); seeded into `localStorage` in `?boot=basic` mode. Not redistributed from this repo. |

This is a non-commercial preservation project for personal use. It is not affiliated with 4am, the Internet Archive, or any of the games' publishers.

## How rewind and save states stay small

apple2js's `Apple2.getState()` asks every slot card for its state, and the SmartPort card's answer is a copy of the entire mounted drive — 32MB here. The emulator controller wraps that card so snapshots report an empty state for it and restores leave the live drive alone (`web/src/emulator/EmulatorController.ts`). A snapshot is therefore just CPU, video, MMU and the two 64K RAM banks. Rewinding does not un-write the drive's prefs/high-score blocks, which is the behaviour you'd want anyway.

## Getting the disk image

The Total Replay image is **not** in this repo (it is 32 MB and collects hundreds of commercially published games). Fetch it once after cloning:

```bash
cd web
npm install
npm run fetch-disk
```

That downloads `Total Replay v6.1.hdv` from [archive.org/details/TotalReplay](https://archive.org/details/TotalReplay) to `web/public/disks/TotalReplay.hdv` and verifies its SHA-256 (`7434fb5d…64be`). To do it by hand instead: download the `.hdv` from that page (or from the [Total Replay releases](https://github.com/a2-4am/4cade/releases)) and save it as `web/public/disks/TotalReplay.hdv`. The `disks/` folder is gitignored, so it won't be committed by accident. If archive.org publishes a newer build, update the URL and checksum in `web/scripts/fetch-total-replay.mjs`, **and** bump `DISK_VERSION` in `web/src/emulator/DiskCache.ts` — otherwise browsers that already cached the old build keep serving it instead of fetching the new one — after confirming it boots.

The Azure workflow runs the same script before every build, so deployments never depend on the file being checked in.

### The Applesoft-mode programs

`?boot=basic` mode's disk of classic BASIC programs is **not** in this repo either — the programs are Apple-copyrighted. `npm run fetch-programs` (`web/scripts/fetch-basic-programs.mjs`) downloads a few DOS 3.3 disk images from archive.org, verifies their SHA-256, reads their catalogs, and writes each Applesoft program's tokenized image to `web/public/disks/programs/` (gitignored) with a `manifest.json`. `npm run dev` runs it automatically the first time; the Azure workflow runs it before every build. To change the set, edit `SOURCES` in that script (leave `sha256: null` on a new disk and it prints the hash it computed).

## Running locally

```bash
cd web
npm install
npm run fetch-disk
npm run dev
```

`npm run dev` also runs `npm run fetch-programs` the first time (the classic BASIC programs for Applesoft mode); run it by hand if you want them without starting the dev server.

The repo uses git submodules; clone with `--recurse-submodules` or run `git submodule update --init --recursive`.

## Deployment

Hosted on Azure Static Web Apps (Free tier) via `.github/workflows/azure-static-web-apps.yml`, which builds `web/` (`app_location: "web"`, `output_location: "dist"`, no API) on every push to `main` and on pull requests (with PR preview environments). The workflow needs a repository secret named `AZURE_STATIC_WEB_APPS_API_TOKEN` holding the Static Web App's deployment token (*Overview → Manage deployment token* in the Azure portal, or `az staticwebapp secrets list`).

```bash
cd web
npm run build
npm run preview
```
