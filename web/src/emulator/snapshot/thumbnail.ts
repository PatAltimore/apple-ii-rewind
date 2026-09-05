/** Thumbnail pixel dimensions — a quarter of the 592x416 game canvas. */
export const THUMBNAIL_WIDTH = 148;
export const THUMBNAIL_HEIGHT = 104;

// "Lazily initialized, module-scoped cache" — `offscreen` starts
// `undefined` and only gets created the *first* time `captureThumbnail`
// runs (see the `if (!offscreen)` check below); every call after that
// reuses the same canvas element. Note this canvas is never attached
// to the visible page (nothing ever does `document.body.appendChild(offscreen)`)
// — it exists purely as an in-memory drawing surface, which is a common
// technique for image processing: draw onto it, read the result back out,
// but never actually display it.
let offscreen: HTMLCanvasElement | undefined;

/**
 * Downscales the live game canvas into a small PNG data URL for use as a
 * rewind-buffer thumbnail. Reuses one offscreen canvas across calls rather
 * than allocating a new one every snapshot (every 5s, but still — no need
 * to churn DOM nodes for something called this often over a session).
 *
 * PNG (not JPEG): this is flat-color, high-contrast Apple II hi-res
 * graphics, not photographic content — PNG compresses it well and stays
 * lossless at this tiny size, so there's no real tradeoff to make here.
 */
export function captureThumbnail(canvas: HTMLCanvasElement): string {
    if (!offscreen) {
        offscreen = document.createElement('canvas');
        offscreen.width = THUMBNAIL_WIDTH;
        offscreen.height = THUMBNAIL_HEIGHT;
    }
    // A canvas element is just a blank rectangle until you get its
    // "rendering context" — the actual toolkit of drawing operations
    // (`drawImage`, `fillRect`, etc.). `'2d'` asks for the standard flat
    // drawing API (as opposed to `'webgl'` for 3D); the `!` asserts the
    // browser will actually return one (it can technically return `null`
    // in obscure cases the type system tracks but that don't occur here).
    const ctx = offscreen.getContext('2d')!;
    // Off by default in most browsers, `imageSmoothingEnabled` controls
    // whether scaling an image blurs it to smooth out the transition
    // between pixels or keeps hard edges — turned off here to preserve
    // the game's crisp, blocky pixel-art look instead of blurring it.
    ctx.imageSmoothingEnabled = false;
    // `drawImage(source, x, y, width, height)` draws `source` (here, the
    // *live* game canvas — an image source can itself be another canvas)
    // onto this context, scaled to fit the given width/height — the
    // downscaling from the full 592×416 game canvas down to this
    // thumbnail's 148×104 happens automatically as part of this one call.
    ctx.drawImage(canvas, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
    // `.toDataURL(...)` encodes the canvas's current pixels as an image
    // file (PNG here) and returns it as a "data URL" — a string like
    // `data:image/png;base64,iVBORw0K...` that *is* the image data itself,
    // rather than a link to a separate image file. That's what lets this
    // get stored directly as a plain string (in a RewindEntry, and
    // ultimately assigned straight to an `<img>` element's `src` — see
    // RewindScrubber.ts) instead of needing a real URL to fetch from.
    return offscreen.toDataURL('image/png');
}
