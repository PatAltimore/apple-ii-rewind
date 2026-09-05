// apple2js's Audio class (js/ui/audio.ts) loads its AudioWorklet processor
// from a hardcoded path, `./dist/audio_worker.bundle.js`, matching where
// apple2js's own webpack build happens to emit it. That file doesn't exist
// in this Vite project's build output, so it has to be produced separately
// and placed at the exact URL path the vendored code expects
// (public/dist/audio_worker.bundle.js -> served at /dist/audio_worker.bundle.js
// in both `vite dev` and the built `dist/` output, since Vite's publicDir
// contents are copied to the site root either way).
//
// js/ui/audio_worker.ts has no runtime imports (just ambient AudioWorklet
// type declarations), so this is a plain transpile, not real bundling —
// esbuild (already a transitive Vite dependency) is enough, no need for a
// second full Vite/Rollup config just for one self-contained file.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await build({
    entryPoints: [
        path.resolve(__dirname, '../vendor/apple2js/js/ui/audio_worker.ts'),
    ],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    outfile: path.resolve(__dirname, '../public/dist/audio_worker.bundle.js'),
    logLevel: 'info',
});
