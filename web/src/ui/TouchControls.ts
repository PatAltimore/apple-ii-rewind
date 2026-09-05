import Apple2IO from 'js/apple2io';
import { APPLE_KEY, HeldKey, KeyTypingQueue, pressKey, releaseKey } from '../emulator/keyInput';

/**
 * On-screen controls for touch devices (see .touch-controls in style.css,
 * shown on coarse-pointer devices or when forced via ControlModeSwitch):
 *
 * - A floating joystick driving paddles 0/1 through the same Apple2IO API
 *   a real joystick uses. Snapped to 8 compass directions at full
 *   deflection, like a digital stick — that is what almost every Apple II
 *   game expects, and it removes the jitter of free analog positioning on
 *   a touchscreen. A second mode turns the same stick into the four arrow
 *   keys (with typematic repeat) for the Total Replay menu and the many
 *   keyboard-driven games in the library.
 * - Two fire buttons: Open-Apple (button 0) and Closed-Apple (button 1).
 * - A row of keys games and the launcher commonly need (Esc, Tab, Space,
 *   Return) plus a "Type" button that focuses an off-screen text input so
 *   the phone's own keyboard can be used to search the library or type
 *   into a game.
 *
 * Pointer Events are used throughout so mouse, touch and pen behave the
 * same; each control tracks its own pointerId so multi-touch (stick + a
 * button at once) works.
 */
const BASE_RADIUS_PX = 60;
const DEADZONE_RATIO = 0.3;

export type JoystickMode = 'analog' | 'arrows';

export interface TouchControlsElements {
    joystickBase: HTMLElement;
    joystickThumb: HTMLElement;
    modeAnalogBtn: HTMLButtonElement;
    modeArrowsBtn: HTMLButtonElement;
    button0: HTMLElement;
    button1: HTMLElement;
    /** Buttons with a `data-key` attribute naming an APPLE_KEY entry. */
    keyButtons: HTMLElement[];
    typeBtn: HTMLButtonElement;
    typeInput: HTMLInputElement;
}

export interface TouchControlsHandle {
    getJoystickMode: () => JoystickMode;
    setJoystickMode: (mode: JoystickMode) => void;
}

const MODE_STORAGE_KEY = 'apple-ii-rewind:joystick-mode';

export function attachTouchControls(io: Apple2IO, els: TouchControlsElements): TouchControlsHandle {
    const { joystickBase, joystickThumb, modeAnalogBtn, modeArrowsBtn, button0, button1, keyButtons, typeBtn, typeInput } =
        els;

    // --- Joystick -------------------------------------------------------
    let mode: JoystickMode = readStoredMode();
    const heldArrow = new HeldKey(io);
    let joystickPointerId: number | null = null;
    // The touch-down point becomes the stick's centre ("floating" stick),
    // so an off-centre first tap doesn't read as an immediate shove.
    let touchOrigin: { x: number; y: number } | null = null;

    function applyMode(next: JoystickMode) {
        mode = next;
        modeAnalogBtn.classList.toggle('active', next === 'analog');
        modeArrowsBtn.classList.toggle('active', next === 'arrows');
        modeAnalogBtn.setAttribute('aria-pressed', String(next === 'analog'));
        modeArrowsBtn.setAttribute('aria-pressed', String(next === 'arrows'));
        resetJoystick();
        try {
            window.localStorage.setItem(MODE_STORAGE_KEY, next);
        } catch {
            /* best-effort persistence */
        }
    }
    modeAnalogBtn.addEventListener('click', () => applyMode('analog'));
    modeArrowsBtn.addEventListener('click', () => applyMode('arrows'));
    applyMode(mode);

    function setThumb(dx: number, dy: number) {
        joystickThumb.style.transform = `translate(${dx}px, ${dy}px)`;
    }

    function setPaddlesFromOffset(dx: number, dy: number) {
        const nx = dx / BASE_RADIUS_PX;
        const ny = dy / BASE_RADIUS_PX;
        // Same mapping as apple2js's gamepad code (js/ui/gamepad.ts) so a
        // full deflection reads like a real stick pushed to its stop.
        io.paddle(0, clamp01((nx * 1.414 + 1) / 2));
        io.paddle(1, clamp01((ny * 1.414 + 1) / 2));
    }

    function setArrowFromOffset(dx: number, dy: number) {
        if (dx === 0 && dy === 0) {
            heldArrow.release();
            return;
        }
        // Four-way only for arrows: pick the dominant axis.
        if (Math.abs(dx) >= Math.abs(dy)) {
            heldArrow.hold(dx > 0 ? APPLE_KEY.RIGHT : APPLE_KEY.LEFT);
        } else {
            heldArrow.hold(dy > 0 ? APPLE_KEY.DOWN : APPLE_KEY.UP);
        }
    }

    function resetJoystick() {
        io.paddle(0, 0.5);
        io.paddle(1, 0.5);
        heldArrow.release();
        setThumb(0, 0);
        joystickBase.classList.remove('touch-joystick-pressed');
    }

    function snapToCompass(rawDx: number, rawDy: number, directions: 4 | 8): { dx: number; dy: number } {
        const dist = Math.hypot(rawDx, rawDy);
        if (dist < BASE_RADIUS_PX * DEADZONE_RATIO) {
            return { dx: 0, dy: 0 };
        }
        const step = (Math.PI * 2) / directions;
        const angle = Math.round(Math.atan2(rawDy, rawDx) / step) * step;
        return {
            dx: roundTiny(Math.cos(angle) * BASE_RADIUS_PX),
            dy: roundTiny(Math.sin(angle) * BASE_RADIUS_PX),
        };
    }

    function updateFromPointer(e: PointerEvent) {
        if (!touchOrigin) {
            return;
        }
        const { dx, dy } = snapToCompass(e.clientX - touchOrigin.x, e.clientY - touchOrigin.y, mode === 'analog' ? 8 : 4);
        setThumb(dx, dy);
        if (mode === 'analog') {
            setPaddlesFromOffset(dx, dy);
        } else {
            setArrowFromOffset(dx, dy);
        }
    }

    joystickBase.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        joystickPointerId = e.pointerId;
        touchOrigin = { x: e.clientX, y: e.clientY };
        joystickBase.classList.add('touch-joystick-pressed');
        try {
            joystickBase.setPointerCapture(e.pointerId);
        } catch {
            /* capture is a nice-to-have; window listeners below cover release */
        }
    });

    // Bound on window: a drag routinely leaves the 120px base, and if
    // pointer capture didn't stick the release fires on whatever is under
    // the finger instead.
    window.addEventListener('pointermove', (e) => {
        if (e.pointerId !== joystickPointerId) {
            return;
        }
        e.preventDefault();
        updateFromPointer(e);
    });

    function endJoystickPointer(e: PointerEvent) {
        if (e.pointerId !== joystickPointerId) {
            return;
        }
        joystickPointerId = null;
        touchOrigin = null;
        resetJoystick();
    }
    window.addEventListener('pointerup', endJoystickPointer);
    window.addEventListener('pointercancel', endJoystickPointer);

    // --- Fire buttons ---------------------------------------------------
    function wireFireButton(el: HTMLElement, button: 0 | 1) {
        let activePointer: number | null = null;
        el.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            activePointer = e.pointerId;
            el.classList.add('pressed');
            io.buttonDown(button, true);
        });
        const release = (e: PointerEvent) => {
            if (activePointer !== null && e.pointerId !== activePointer) {
                return;
            }
            activePointer = null;
            el.classList.remove('pressed');
            io.buttonDown(button, false);
        };
        el.addEventListener('pointerup', release);
        el.addEventListener('pointercancel', release);
        el.addEventListener('pointerleave', release);
    }
    wireFireButton(button0, 0);
    wireFireButton(button1, 1);

    // --- Key buttons ----------------------------------------------------
    for (const el of keyButtons) {
        const name = el.dataset.key as keyof typeof APPLE_KEY | undefined;
        if (!name || !(name in APPLE_KEY)) {
            continue;
        }
        const code = APPLE_KEY[name];
        el.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            el.classList.add('pressed');
            pressKey(io, code);
        });
        const release = () => {
            el.classList.remove('pressed');
            releaseKey(io);
        };
        el.addEventListener('pointerup', release);
        el.addEventListener('pointercancel', release);
        el.addEventListener('pointerleave', release);
    }

    // --- Soft keyboard ---------------------------------------------------
    attachSoftKeyboard(io, typeBtn, typeInput);

    return {
        getJoystickMode: () => mode,
        setJoystickMode: applyMode,
    };
}

/**
 * Routes the device's own keyboard into the emulator via an off-screen
 * <input>. Focusing a text input is the only way to summon the soft
 * keyboard on phones. Two event paths are needed because mobile browsers
 * differ: iOS reports real `key` values on keydown, while Android IMEs
 * report `Unidentified`/`Process` on keydown and deliver the character via
 * `beforeinput` (insertText). Whatever is handled on keydown is
 * `preventDefault`ed so it doesn't also arrive as beforeinput.
 */
function attachSoftKeyboard(io: Apple2IO, typeBtn: HTMLButtonElement, input: HTMLInputElement): void {
    const typing = new KeyTypingQueue(io);

    const SPECIAL: Record<string, number> = {
        Enter: APPLE_KEY.RETURN,
        Escape: APPLE_KEY.ESC,
        Tab: APPLE_KEY.TAB,
        Backspace: APPLE_KEY.DELETE,
        Delete: APPLE_KEY.DELETE,
        ArrowUp: APPLE_KEY.UP,
        ArrowDown: APPLE_KEY.DOWN,
        ArrowLeft: APPLE_KEY.LEFT,
        ArrowRight: APPLE_KEY.RIGHT,
    };

    typeBtn.addEventListener('click', () => {
        if (document.activeElement === input) {
            input.blur();
        } else {
            input.focus();
        }
    });
    input.addEventListener('focus', () => typeBtn.classList.add('active'));
    input.addEventListener('blur', () => typeBtn.classList.remove('active'));

    input.addEventListener('keydown', (e) => {
        if (e.key in SPECIAL) {
            e.preventDefault();
            typing.type(SPECIAL[e.key]);
            return;
        }
        if (e.key.length === 1) {
            e.preventDefault();
            let code = e.key.charCodeAt(0);
            if (e.ctrlKey && code >= 0x40 && code < 0x80) {
                code = (code & 0x1f); // Ctrl-letter
            }
            typing.type(code);
        }
        // 'Unidentified' / 'Process' / 'Dead': let beforeinput handle it.
    });

    input.addEventListener('beforeinput', (e) => {
        const ev = e as InputEvent;
        if (ev.inputType === 'insertText' || ev.inputType === 'insertCompositionText') {
            e.preventDefault();
            for (const ch of ev.data ?? '') {
                const code = ch.charCodeAt(0);
                if (code < 0x80) {
                    typing.type(code);
                }
            }
        } else if (ev.inputType === 'deleteContentBackward') {
            e.preventDefault();
            typing.type(APPLE_KEY.DELETE);
        } else if (ev.inputType === 'insertLineBreak' || ev.inputType === 'insertParagraph') {
            e.preventDefault();
            typing.type(APPLE_KEY.RETURN);
        }
    });

    // Keep the field non-empty with a space so Android always has a
    // character to "delete" (some IMEs don't fire deleteContentBackward
    // on an empty field) and never accumulates typed text.
    const settle = () => {
        input.value = ' ';
        input.setSelectionRange(1, 1);
    };
    input.addEventListener('input', settle);
    input.addEventListener('focus', settle);
    settle();
}

function readStoredMode(): JoystickMode {
    try {
        const v = window.localStorage.getItem(MODE_STORAGE_KEY);
        if (v === 'analog' || v === 'arrows') {
            return v;
        }
    } catch {
        /* storage unavailable */
    }
    return 'analog';
}

function clamp01(v: number): number {
    return Math.max(0, Math.min(1, v));
}

function roundTiny(v: number): number {
    return Math.abs(v) < 1e-6 ? 0 : v;
}
