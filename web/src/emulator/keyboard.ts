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
 * game view is fullscreen *and* `reserveBackspace` says it's wanted at
 * all: that's when RewindScrubber.ts's attachRewindButton additionally
 * treats it as the "rewind 5s" hotkey (see its doc comment), since the
 * on-screen rewind bar isn't reachable in that mode. `reserveBackspace`
 * is false in Applesoft's own boot mode (main.ts's BASIC_BOOT_MODE):
 * there, Backspace is needed for its ordinary job — erasing the last
 * typed character at the `]` prompt — even while fullscreen, since there
 * is no game session to rewind through in the first place. Outside
 * fullscreen (or with reserving turned off), Backspace always reaches
 * the emulator as normal — it's the //e's Delete key, which Total
 * Replay's search box and many games also rely on for text editing.
 */
function isFullscreenBackspace(event: KeyboardEvent, reserveBackspace: boolean): boolean {
    return reserveBackspace && event.key === 'Backspace' && currentFullscreenElement() !== null;
}

/**
 * Letters are always sent upper-case, as if the //e's Caps Lock were
 * permanently down: the bulk of the Total Replay library predates
 * lower-case input and ignores or mis-renders lower-case letters, and the
 * launcher's search is case-insensitive anyway. The physical Caps Lock
 * key is therefore ignored rather than toggled.
 */
const ALWAYS_CAPS = true;

export interface KeyboardOptions {
    /**
     * False in Applesoft's boot mode — see `isFullscreenBackspace`'s
     * comment for why Backspace shouldn't be taken over there even while
     * fullscreen. Defaults to true (Total Replay's normal behavior).
     */
    reserveFullscreenBackspace?: boolean;
    /**
     * True in Applesoft's boot mode. Sends Backspace as ASCII 8 (the
     * classic Apple II left-arrow/BS code) instead of the ASCII 127
     * ("DELETE") apple2js's own keyboard mapping normally sends for it.
     *
     * Confirmed live against this ROM: at Applesoft's `]` prompt, 127 is
     * *not* treated as backspace at all — GETLN just echoes it as an
     * ordinary character (a solid block glyph) and appends it to the
     * input line, same as any other keystroke; 8 correctly erases the
     * previous character from both the screen and the line GETLN will
     * actually parse (verified by backspacing over a stray character,
     * typing a replacement, and confirming the executed line reflected
     * only the correction, not both keystrokes).
     *
     * Off by default: Total Replay's own input handling (search box,
     * in-game text entry) almost certainly doesn't go through bare
     * Applesoft GETLN the way a cold-booted `]` prompt does, and hasn't
     * been tested against this remapping — changing its Backspace
     * behavior isn't something to risk on an assumption.
     */
    backspaceAsLeftArrow?: boolean;
    /**
     * Set in Applesoft's boot mode. Called with the line currently typed
     * at the `]` prompt the instant Return is pressed, *before* the
     * keystroke reaches the emulator, so the handler can recognise a disk
     * command (CATALOG/LOAD/SAVE — see src/disk/commands.ts) and blank the
     * emulator's input buffer before GETLN parses it. To track the line,
     * keyboard.ts keeps a shadow buffer: it appends printable keys and
     * removes on Backspace, and gives up (clears the shadow) on any
     * editing key it doesn't model (arrows, Ctrl-anything, Tab, Esc) — a
     * command typed with such a key in the middle simply won't be
     * recognised and runs as normal Applesoft.
     */
    onLineSubmit?: (line: string) => void;
}

/**
 * Physical-keyboard-to-Apple-II wiring, following apple2js's own Keyboard
 * component (js/components/Keyboard.tsx) minus the on-screen keyboard.
 * Left Alt = Open-Apple (button 0), right Alt = Closed-Apple (button 1),
 * Delete = Ctrl-Reset — which in Total Replay returns to the launcher.
 * Letters are upper-cased regardless of Shift/Caps Lock (see ALWAYS_CAPS).
 * Listeners are attached to the canvas only, so typing into dialogs never
 * reaches the game.
 */
/** ASCII BS / left-arrow — see `KeyboardOptions.backspaceAsLeftArrow`. */
const LEFT_ARROW_CODE = 0x08;

export function attachKeyboard(apple2: Apple2, target: HTMLElement, options: KeyboardOptions = {}): () => void {
    const reserveFullscreenBackspace = options.reserveFullscreenBackspace ?? true;
    const backspaceAsLeftArrow = options.backspaceAsLeftArrow ?? false;
    const onLineSubmit = options.onLineSubmit;
    let ctrl = false;
    // Shadow of the line being typed at the `]` prompt — see
    // KeyboardOptions.onLineSubmit. Only maintained when that hook is set.
    let shadowLine = '';

    const keyDown = (event: KeyboardEvent) => {
        if (APP_HOTKEYS.has(event.key) || isFullscreenEscape(event) || isFullscreenBackspace(event, reserveFullscreenBackspace)) {
            return;
        }
        const { key, keyCode: mappedKeyCode } = mapKeyboardEvent(normalizeAltGraph(event), ALWAYS_CAPS, ctrl);
        const keyCode = backspaceAsLeftArrow && key === 'DELETE' ? LEFT_ARROW_CODE : mappedKeyCode;

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

        if (onLineSubmit) {
            if (key === 'RETURN') {
                onLineSubmit(shadowLine);
                shadowLine = '';
            } else if (key === 'DELETE') {
                shadowLine = shadowLine.slice(0, -1);
            } else if (keyCode >= 0x20 && keyCode < 0x7f) {
                shadowLine += String.fromCharCode(keyCode & 0x7f);
            } else if (keyCode !== 0xff) {
                // A control/navigation key that still reaches the emulator
                // (arrows, Tab, Esc, Ctrl-letter) — we don't model its
                // effect on the line, so stop trusting the shadow. Pure
                // modifiers (keyCode 0xff, not forwarded) are left alone.
                shadowLine = '';
            }
        }

        if (keyCode !== 0xff) {
            io.keyDown(keyCode);
        }
    };

    const keyUp = (event: KeyboardEvent) => {
        if (APP_HOTKEYS.has(event.key) || isFullscreenEscape(event) || isFullscreenBackspace(event, reserveFullscreenBackspace)) {
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
