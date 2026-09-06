import { mapKeyboardEvent } from 'js/components/util/keyboard';
import { Apple2 } from 'js/apple2';
import { hardReset } from './EmulatorController';

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
 */
export function attachKeyboard(apple2: Apple2, target: HTMLElement): () => void {
    let ctrl = false;

    const keyDown = (event: KeyboardEvent) => {
        if (APP_HOTKEYS.has(event.key)) {
            return;
        }
        const { key, keyCode } = mapKeyboardEvent(normalizeAltGraph(event), ALWAYS_CAPS, ctrl);

        if (key === 'CTRL') {
            ctrl = true;
        }

        event.preventDefault();

        if (key === 'RESET') {
            hardReset(apple2);
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
        if (APP_HOTKEYS.has(event.key)) {
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
