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

/** Wires a button to toggle `target` in and out of fullscreen. */
export function attachFullscreenToggle(button: HTMLButtonElement, target: HTMLElement): FullscreenHandle {
    const isFullscreen = () => currentFullscreenElement() === target;

    const updateLabel = () => {
        button.textContent = isFullscreen() ? '⛶ Exit Fullscreen' : '⛶ Fullscreen';
        button.setAttribute('aria-pressed', String(isFullscreen()));
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

    // Keeps the label correct however fullscreen ends — our own button,
    // the browser's native Escape gesture, or the browser's own
    // fullscreen-exit UI (e.g. an on-screen "Press Esc to exit" banner).
    document.addEventListener('fullscreenchange', updateLabel);
    document.addEventListener('webkitfullscreenchange', updateLabel);
    updateLabel();

    return { isFullscreen };
}
