/**
 * Chromeless fullscreen for the game view via the Fullscreen API — the
 * only real way a web page can "maximize" itself; there's no API for a
 * page to resize or maximize the browser's own OS window (any such
 * capability being exposed to arbitrary websites would be a security
 * problem), so this is the correct choice rather than a limitation.
 *
 * Targets `.canvas-wrap` (canvas + rewind thumbnail + boot overlay), not
 * the whole page: the Fullscreen API only renders the fullscreen
 * element's own subtree, so everything else — buttons, rewind bar, key
 * legend, footer — is simply not part of what's shown, with no extra
 * code needed to hide it. See style.css's `:fullscreen` rules for how the
 * canvas keeps its native aspect ratio (letterboxed) instead of
 * stretching to whatever the display happens to be shaped like.
 *
 * "A key to return to windowed environment": Escape is the browser's own
 * built-in fullscreen-exit gesture, enforced at the spec level so a page
 * can't block it — nothing here needs to implement that. The only thing
 * this app needs to get right on its side is *not also* forwarding that
 * Escape press to the emulator (see keyboard.ts's `document.fullscreenElement`
 * check) — otherwise leaving fullscreen would also, confusingly, send an
 * Escape keypress into the running game/launcher.
 */
export interface FullscreenHandle {
    isFullscreen: () => boolean;
}

// Safari's Fullscreen API implementation predates the unprefixed standard
// and needs the `webkit`-prefixed names; feature-detected rather than
// branching on user agent.
interface PrefixedFullscreenDocument extends Document {
    webkitFullscreenElement?: Element | null;
    webkitExitFullscreen?: () => Promise<void>;
}
interface PrefixedFullscreenElement extends HTMLElement {
    webkitRequestFullscreen?: () => Promise<void>;
}

/** Exported for keyboard.ts, which needs to know this too — see its `isFullscreenEscape`. */
export function currentFullscreenElement(): Element | null {
    const doc = document as PrefixedFullscreenDocument;
    return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

async function requestFullscreen(el: HTMLElement): Promise<void> {
    const target = el as PrefixedFullscreenElement;
    if (target.requestFullscreen) {
        await target.requestFullscreen();
    } else {
        await target.webkitRequestFullscreen?.();
    }
}

async function exitFullscreen(): Promise<void> {
    const doc = document as PrefixedFullscreenDocument;
    if (document.exitFullscreen) {
        await document.exitFullscreen();
    } else {
        await doc.webkitExitFullscreen?.();
    }
}

/** The game's native resolution — see index.html's `<canvas width height>`. */
const GAME_WIDTH = 592;
const GAME_HEIGHT = 416;
const GAME_ASPECT = GAME_WIDTH / GAME_HEIGHT;

/**
 * Sizes the canvas to the largest it can be at its native aspect ratio
 * without overflowing the viewport, letterboxing only the unavoidable
 * remainder (a 592:416 ≈ 1.42:1 game can never exactly fill a 16:9 or
 * ultrawide display without either cropping or distorting it).
 *
 * Computed in JS and applied as inline styles — which win over any CSS
 * rule, including style.css's own `:fullscreen` sizing, which stays only
 * as a fallback for the brief instant before this runs — rather than
 * relying purely on CSS `aspect-ratio` + `max-width`/`max-height` on the
 * canvas. That combination is exactly correct on paper, but a `<canvas>`
 * is a "replaced element" with its own intrinsic size (from its `width`/
 * `height` HTML attributes) the way `<img>`/`<video>` are, and cross-browser
 * behavior for replaced elements sizing themselves from `aspect-ratio`
 * inside `max-width`/`max-height` constraints has known inconsistencies;
 * computing the target pixels directly removes any doubt.
 */
function fitCanvasToViewport(canvas: HTMLCanvasElement): void {
    const viewportRatio = window.innerWidth / window.innerHeight;
    const width = viewportRatio > GAME_ASPECT ? window.innerHeight * GAME_ASPECT : window.innerWidth;
    const height = viewportRatio > GAME_ASPECT ? window.innerHeight : window.innerWidth / GAME_ASPECT;
    canvas.style.width = `${Math.floor(width)}px`;
    canvas.style.height = `${Math.floor(height)}px`;
}

/** Reverts to style.css's normal (non-fullscreen) sizing rules. */
function clearFittedCanvasSize(canvas: HTMLCanvasElement): void {
    canvas.style.width = '';
    canvas.style.height = '';
}

/** Wires a button to toggle `target` in and out of fullscreen, resizing `canvas` to fit while it's active. */
export function attachFullscreenToggle(
    button: HTMLButtonElement,
    target: HTMLElement,
    canvas: HTMLCanvasElement
): FullscreenHandle {
    const isFullscreen = () => currentFullscreenElement() === target;

    const updateLabel = () => {
        button.textContent = isFullscreen() ? '⛶ Exit Fullscreen' : '⛶ Fullscreen';
        button.setAttribute('aria-pressed', String(isFullscreen()));
    };

    const updateCanvasSize = () => {
        if (isFullscreen()) {
            fitCanvasToViewport(canvas);
        } else {
            clearFittedCanvasSize(canvas);
        }
    };

    button.addEventListener('click', () => {
        const action = isFullscreen() ? exitFullscreen() : requestFullscreen(target);
        // The Fullscreen API rejects if the browser (or an embedding
        // iframe's permissions policy) denies the request — there's no
        // finer-grained reason available than that. Log it rather than
        // letting it surface as an unhandled rejection; updateLabel()
        // still runs on the resulting 'fullscreenchange' (or lack of one
        // here, since nothing changed) so the button never claims a state
        // that didn't actually happen.
        action.catch((err: unknown) => {
            console.warn('Fullscreen request failed:', err);
        });
    });

    // Keeps the label and canvas size correct however fullscreen changes —
    // our own button, the browser's native Escape gesture, its own
    // fullscreen-exit UI (e.g. an on-screen "Press Esc to exit" banner),
    // or (via 'resize') the display/window changing shape while active,
    // e.g. an external monitor being unplugged or a tablet rotating.
    document.addEventListener('fullscreenchange', () => {
        updateLabel();
        updateCanvasSize();
    });
    document.addEventListener('webkitfullscreenchange', () => {
        updateLabel();
        updateCanvasSize();
    });
    window.addEventListener('resize', () => {
        if (isFullscreen()) {
            fitCanvasToViewport(canvas);
        }
    });
    updateLabel();

    return { isFullscreen };
}
