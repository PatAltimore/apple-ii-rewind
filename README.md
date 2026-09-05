# Apple II Rewind — Total Replay in the browser

A browser-playable Apple II running [Total Replay](https://archive.org/details/TotalReplay) (4am's curated hard-drive collection of hundreds of Apple II games), with a gameplay rewind buffer, save/load states, and on-screen joystick and buttons for phones and tablets.

Play it at [https://red-island-06620351e.3.azurestaticapps.net/](https://red-island-06620351e.3.azurestaticapps.net/) (first load downloads the 32 MB disk image).

Built from the [prince-of-persia-assist](https://github.com/PatAltimore/prince-of-persia-assist) project as a template, minus that game's hints, cheats, and source-code panes.

## What this is

- A real Apple II system emulator ([apple2js](https://github.com/whscullin/apple2js), Enhanced //e, 128K, 65C02) booting the unmodified Total Replay v6.1 `.hdv` image from an emulated SmartPort hard-drive controller in slot 7.
- **Rewind**: a snapshot is taken every 2 seconds and kept for 5 minutes. Drag the slider to scrub back through recent play (with a thumbnail preview), or hit **⏪ -5s** / <kbd>F2</kbd>.
- **Save / Load State**: named snapshots with thumbnails, stored in the browser's IndexedDB. Snapshots are ~170KB, so there is room for hundreds.
- **Touch controls** on phones/tablets: a floating 8-way joystick (or, toggled, the four arrow keys with typematic repeat for the launcher and keyboard games), Open-Apple / Closed-Apple fire buttons, Esc/Tab/Space/Return keys, and a **⌨ Type** button that brings up the device keyboard for searching the library.
- USB/Bluetooth gamepads are picked up by apple2js's Gamepad API support and act as the joystick.

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

That downloads `Total Replay v6.1.hdv` from [archive.org/details/TotalReplay](https://archive.org/details/TotalReplay) to `web/public/disks/TotalReplay.hdv` and verifies its SHA-256 (`7434fb5d…64be`). To do it by hand instead: download the `.hdv` from that page (or from the [Total Replay releases](https://github.com/a2-4am/4cade/releases)) and save it as `web/public/disks/TotalReplay.hdv`. The `disks/` folder is gitignored, so it won't be committed by accident. If archive.org publishes a newer build, update the URL and checksum in `web/scripts/fetch-total-replay.mjs` after confirming it boots.

The Azure workflow runs the same script before every build, so deployments never depend on the file being checked in.

## Running locally

```bash
cd web
npm install
npm run fetch-disk
npm run dev
```

The repo uses git submodules; clone with `--recurse-submodules` or run `git submodule update --init --recursive`.

## Deployment

Hosted on Azure Static Web Apps (Free tier) via `.github/workflows/azure-static-web-apps.yml`, which builds `web/` (`app_location: "web"`, `output_location: "dist"`, no API) on every push to `main` and on pull requests (with PR preview environments). The workflow needs a repository secret named `AZURE_STATIC_WEB_APPS_API_TOKEN` holding the Static Web App's deployment token (*Overview → Manage deployment token* in the Azure portal, or `az staticwebapp secrets list`).

```bash
cd web
npm run build
npm run preview
```
