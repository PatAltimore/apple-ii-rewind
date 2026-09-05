// LEARNING NOTE — this whole file is what's commonly called a "shim" or
// "stub": a fake, minimal stand-in for a real module, swapped in (see
// vite.config.ts's alias configuration, which is what redirects any
// `import ... from 'apple2shader'` to this file instead of the real
// package) purely to satisfy an import that would otherwise cause
// problems, without providing any real functionality. This is only safe
// because of the specific reasoning below — the real module's exports are
// imported by other code but genuinely never *used* at runtime given how
// this app configures things, so nothing ever notices the substitute is
// hollow. `unknown` (rather than a more specific type) is the honest type
// for this fake value: nothing in this codebase should ever try to do
// anything real with it.
//
// Stub replacement for the `apple2shader` package (GPL-2.0, WebGL/NTSC shader
// renderer). js/apple2.ts unconditionally imports js/gl.ts, which imports
// `screenEmu` from this package, even though this app always runs with
// `gl: false` (see EmulatorController.ts) and so never instantiates any of
// the GL video-mode classes that actually dereference screenEmu's contents.
// Vite's dev-time CJS interop also can't cleanly load apple2shader's actual
// screenEmu.js (conditional `module.exports` pattern isn't statically
// analyzable), so rather than fight that for dead code, this stub stands in
// for it. If GL rendering is ever wanted later, swap this alias (in
// vite.config.ts) back to the real vendored file.
export const screenEmu: unknown = {};
