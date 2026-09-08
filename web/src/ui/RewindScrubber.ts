import { Apple2 } from 'js/apple2';
import { RewindBuffer } from '../emulator/snapshot/RewindBuffer';
import { restoreSnapshot } from '../emulator/snapshot/SnapshotSerializer';

/**
 * Wires a <input type="range"> to the rewind ring buffer: scrubbing pauses
 * the emulator and restores the snapshot at the selected position directly
 * (no forward-replay — simplest correct behavior for a scrub UX where
 * landing exactly on a frame boundary doesn't matter).
 *
 * Refocuses `canvas` once scrubbing ends: clicking/dragging a range input
 * naturally moves DOM focus onto it, same as clicking any button does —
 * since keyboard input is only wired to the canvas element (see
 * emulator/keyboard.ts), losing focus to the slider silently stops the
 * game from responding to the keyboard until something refocuses it. This
 * was reported via playtesting ("keyboard didn't work until I did
 * ctrl+k" — that keypress itself didn't fix anything; whatever incidental
 * click preceded it, refocusing the canvas, did).
 */
export function attachRewindScrubber(
    slider: HTMLInputElement,
    apple2: Apple2,
    buffer: RewindBuffer,
    canvas: HTMLElement,
    thumbnail: HTMLImageElement
): { syncRange: () => void } {
    let scrubbing = false;

    const showThumbnailAt = (index: number) => {
        const src = buffer.thumbnailAt(index);
        if (src) {
            thumbnail.src = src;
            thumbnail.hidden = false;
        }
    };

    // `slider.value` is always a *string* (every form input's `.value` is
    // — HTML has no separate "number" data type at the DOM level, even
    // for `<input type="range">`), so `Number(...)` converts it to an
    // actual JS number wherever it needs to be used as one, like indexing
    // into `buffer` below.
    slider.addEventListener('pointerdown', () => {
        if (buffer.length === 0) {
            return;
        }
        scrubbing = true;
        apple2.stop();
        showThumbnailAt(Number(slider.value));
    });

    // The 'input' event fires continuously *while* a range slider is
    // being dragged — once per position change, not just once at the
    // end — which is exactly what makes live scrubbing possible. Contrast
    // with the 'change' event (not used here), which only fires once,
    // after the drag ends; using 'change' instead would mean the game
    // only visibly jumped to the final position, with no live preview
    // while dragging.
    slider.addEventListener('input', () => {
        if (!scrubbing) {
            return;
        }
        const index = Number(slider.value);
        const state = buffer.at(index);
        if (state) {
            restoreSnapshot(apple2, state);
        }
        showThumbnailAt(index);
    });

    slider.addEventListener('pointerup', () => {
        if (scrubbing) {
            buffer.truncateAfter(Number(slider.value));
        }
        scrubbing = false;
        thumbnail.hidden = true;
        apple2.run();
        canvas.focus();
    });

    // Only touches the DOM when the buffer's length has actually changed,
    // rather than writing slider.max/value/disabled unconditionally on
    // every single frame — those writes are individually cheap, but this
    // is called from the same per-frame callback that drives audio sample
    // generation (see RewindRecorder's doc comment in RewindBuffer.ts for
    // the bigger version of this class of problem), so anything avoidably
    // running 60x/sec there is worth trimming.
    let lastSyncedLength = -1;
    const syncRange = () => {
        if (buffer.length === lastSyncedLength) {
            return;
        }
        lastSyncedLength = buffer.length;
        const max = Math.max(0, buffer.length - 1);
        slider.max = String(max);
        slider.disabled = buffer.length === 0;
        if (!scrubbing) {
            slider.value = String(max);
        }
    };

    return { syncRange };
}

/**
 * Wires a discrete "rewind N seconds" action to both a button and a
 * keyboard hotkey (while the canvas has focus — same scoping as game
 * input, see emulator/keyboard.ts, so it doesn't fire while typing a save
 * name). Jumps to the snapshot closest to N seconds before the newest one,
 * restores it, truncates the now-diverged future, and refocuses the canvas.
 *
 * `isHotkey` decides which keydowns trigger it — a predicate rather than
 * a fixed key, because this app actually wants two: F2 always (a function
 * key the Apple II has no use for; keyboard.ts lists it in APP_HOTKEYS so
 * it's never forwarded to the emulator), and Backspace *only* while the
 * game view is fullscreen (there's no on-screen rewind bar to reach in
 * that mode — see style.css's `:fullscreen` rules — and Backspace is a
 * more reliable key than a function key once the browser/OS chrome that
 * would otherwise show what F2 does is gone). Outside fullscreen,
 * Backspace is deliberately *not* a rewind hotkey: it's the //e's Delete
 * key, which Total Replay's search box and many games rely on for text
 * editing, so keyboard.ts only withholds it from the emulator under that
 * same fullscreen condition.
 */
export function attachRewindButton(
    button: HTMLButtonElement,
    apple2: Apple2,
    buffer: RewindBuffer,
    canvas: HTMLElement,
    seconds: number,
    isHotkey: (event: KeyboardEvent) => boolean
): void {
    const doRewind = () => {
        const index = buffer.indexSecondsAgo(seconds);
        if (index === undefined) {
            return;
        }
        const state = buffer.at(index);
        if (!state) {
            return;
        }
        apple2.stop();
        restoreSnapshot(apple2, state);
        buffer.truncateAfter(index);
        apple2.run();
        canvas.focus();
    };

    button.addEventListener('click', doRewind);

    canvas.addEventListener('keydown', (event) => {
        if (isHotkey(event)) {
            event.preventDefault();
            doRewind();
        }
    });
}
