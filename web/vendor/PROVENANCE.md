# Provenance

`apple2js/` is a git submodule of [whscullin/apple2js](https://github.com/whscullin/apple2js) (MIT), pinned to commit `ee0aed25f73c69d0245e86a2a5fccb3324c3056c` — the same commit the prince-of-persia-assist template boot-tested.

This app uses apple2js's core emulation modules (`js/apple2.ts`, `js/cards/smartport.ts`, `js/apple2io.ts`, `js/mmu.ts`, `js/ram.ts`, `js/videomodes.ts`, `js/canvas.ts`, `js/roms/*`, `js/formats/*`, `js/ui/audio.ts`, `js/components/util/keyboard.ts`, and the `@whscullin/cpu6502` submodule package) directly via TypeScript path/Vite aliases (`js/*` → `vendor/apple2js/js/*`, see `tsconfig.json` and `vite.config.ts`). The files are imported unmodified, not copied, so upstream fixes can be pulled by bumping the submodule commit.

Deliberately **not** used: apple2js's own UI layer (`js/components/*` React tree, `js/ui/apple2.ts`, both entry points). This app has its own UI (`web/src/`) built directly on the core classes.

Workarounds, all confined to `web/` (nothing in the submodule is modified on disk):

1. **ROM dynamic imports** (`vite.config.ts`, `apple2RomImportExtensionFix`): `js/apple2.ts` loads ROMs via extensionless dynamic imports that `@rollup/plugin-dynamic-import-vars` can't bundle; a Vite transform adds the `.ts` extension in memory.
2. **RAM restore aliasing** (`vite.config.ts`, `apple2RamAliasingFix`): `RAM.setState()` reassigns `this.mem`, orphaning the `subarray` views the video renderer holds; the transform makes it copy in place so the screen repaints correctly after a rewind/load.
3. **SmartPort snapshot size** (`src/emulator/EmulatorController.ts`, `SnapshotExcludedCard`): the card's `getState()` is async and copies the whole 32MB drive; a wrapper card forwards I/O and reports an empty synchronous state instead.
4. **`apple2shader` (GPL-2.0) import** (`src/shims/apple2shader.ts`): `js/gl.ts` imports the WebGL shader package unconditionally; this app runs with `gl: false`, so the import is aliased to a stub.
5. **AudioWorklet path** (`scripts/build-audio-worklet.mjs`): `js/ui/audio.ts` loads its worklet from the hardcoded `./dist/audio_worker.bundle.js`; a small esbuild step emits that file into `public/dist/` before dev/build.
