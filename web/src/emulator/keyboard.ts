import { mapKeyboardEvent } from 'js/components/util/keyboard';
import { Apple2 } from 'js/apple2';
import { hardReset } from './EmulatorController';
import { currentFullscreenElement } from '../ui/Fullscreen';

/**
 * Some Android/Fire-OS browsers send `event.key === 'AltGraph'` for the
 * right-hand Alt key instead of `'Alt'`. apple2js's `mapKeyboardEvent`
 * only checks for the literal `'Alt'`, so re-present it as a synthetic
 * Alt event (preserving `location`, which picks OPEN_APPLE vs
 * CLOSED_APPLE).
 */
function normalizeAltGraph(event: KeyboardEvent): KeyboardEvent {
    if (event.key !== 'AltGraph') {
        return event;
    }
    return new KeyboardEvent(event.type, { key: 'Alt', location: 2, bubbles: event.bubbles });
}

/** Keys this app reserves for itself; never forwarded to the emulator. */
const APP_HOTKEYS = new Set(['F2']);

/**
 * Escape is reserved too, but only while the game view is fullscreen (see
 * ui/Fullscreen.ts): that's the browser's own unblockable
 * fullscreen-exit gesture, and forwarding it to the emulator as well
 * would confusingly *also* send an Escape keypress into the running
 * game/launcher on the way out. Outside fullscreen, Escape is an
 * ordinary game key (it navigates back in Total Replay's menu) and must
 * reach the emulator as normal.
 */
function isFullscreenEscape(event: KeyboardEvent): boolean {
    return event.key === 'Escape' && currentFullscreenElement() !== null;
}

/**
 * Backspace is reserved too, but — unlike Escape and F2 — only while the
 * game view is fullscreen: that's when RewindScrubber.ts's
 * attachRewindButton additionally treats it as the "rewind 5s" hotkey (see
 * its doc comment), since the on-screen rewind bar isn't reachable in
 * that mode. Outside fullscreen, Backspace must reach the emulator as
 * normal — it's the //e's Delete key, which Total Replay's search box and
 * many games rely on for text editing.
 */
function isFullscreenBackspace(event: KeyboardEvent): boolean {
    return event.key === 'Backspace' && currentFullscreenElement() !== null;
}

/**
 * Letters are always sent upper-case, as if the //e's Caps Lock were
 * permanently down: the bulk of the Total Replay library predates
 * lower-case input and ignores or mis-renders lower-case letters, and the
 * launcher's search is case-insensitive anyway. The physical Caps Lock
 * key is therefore ignored rather than toggled.
 */
const ALWAYS_CAPS = true;

/**
 * Physical-keyboard-to-Apple-II wiring, following apple2js's own Keyboard
 * component (js/components/Keyboard.tsx) minus the on-screen keyboard.
 * Left Alt = Open-Apple (button 0), right Alt = Closed-Apple (button 1),
 * Delete = Ctrl-Reset — which in Total Replay returns to the launcher.
 * Letters are upper-cased regardless of Shift/Caps Lock (see ALWAYS_CAPS).
 * Listeners are attached to the canvas only, so typing into dialogs never
 * reaches the game.
 *
 * `onHardReset`, if given, is called whenever Delete/Ctrl-Reset fires a
 * real reset — main.ts uses it to drop out of Applesoft break mode (see
 * EmulatorController.ts's `breakToApplesoft`) when the player Ctrl-Resets
 * back to Total Replay's menu, since any reset is by definition an exit
 * from that mode.
 */
export function attachKeyboard(apple2: Apple2, target: HTMLElement, onHardReset?: () => void): () => void {
    let ctrl = false;

    const keyDown = (event: KeyboardEvent) => {
        if (APP_HOTKEYS.has(event.key) || isFullscreenEscape(event) || isFullscreenBackspace(event)) {
            return;
        }
        const { key, keyCode } = mapKeyboardEvent(normalizeAltGraph(event), ALWAYS_CAPS, ctrl);

        if (key === 'CTRL') {
            ctrl = true;
        }

        event.preventDefault();

        if (key === 'RESET') {
            hardReset(apple2);
            onHardReset?.();
            return;
        }

        const io = apple2.getIO();
        if (key === 'OPEN_APPLE' || key === 'CLOSED_APPLE') {
            io.buttonDown(key === 'OPEN_APPLE' ? 0 : 1, true);
            return;
        }

        if (keyCode !== 0xff) {
            io.keyDown(keyCode);
        }
    };

    const keyUp = (event: KeyboardEvent) => {
        if (APP_HOTKEYS.has(event.key) || isFullscreenEscape(event) || isFullscreenBackspace(event)) {
            return;
        }
        const { key } = mapKeyboardEvent(normalizeAltGraph(event));

        if (key === 'CTRL') {
            ctrl = false;
        }

        const io = apple2.getIO();
        if (key === 'OPEN_APPLE') {
            io.buttonDown(0, false);
        }
        if (key === 'CLOSED_APPLE') {
            io.buttonDown(1, false);
        }
        io.keyUp();
    };

    target.addEventListener('keydown', keyDown);
    target.addEventListener('keyup', keyUp);

    return () => {
        target.removeEventListener('keydown', keyDown);
        target.removeEventListener('keyup', keyUp);
    };
}
