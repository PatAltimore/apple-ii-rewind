import Apple2IO from 'js/apple2io';

/**
 * Apple II keyboard codes for the keys the on-screen controls synthesise.
 * Same values apple2js's mapKeyboardEvent produces for the physical keys
 * (see js/components/util/keyboard.ts SPECIAL_KEY_CODE).
 */
export const APPLE_KEY = {
    ESC: 27,
    RETURN: 13,
    TAB: 9,
    SPACE: 32,
    DELETE: 127,
    UP: 11,
    DOWN: 10,
    RIGHT: 21,
    LEFT: 8,
} as const;

/**
 * Upper-cases an ASCII letter code (a-z -> A-Z), leaving everything else
 * alone. Both keyboard paths (emulator/keyboard.ts for physical keys,
 * ui/TouchControls.ts for the phone's soft keyboard) send letters to the
 * Apple II upper-case only — see ALWAYS_CAPS in keyboard.ts for why.
 */
export function toUpperAscii(code: number): number {
    return code >= 0x61 && code <= 0x7a ? code - 0x20 : code;
}

/**
 * Presses one key: latches it into the keyboard register (the strobe stays
 * set until the program reads/clears $C010) and marks "a key is down" for
 * the //e's any-key-down bit. `release()` clears only the latter.
 */
export function pressKey(io: Apple2IO, code: number): void {
    io.keyDown(code);
}

export function releaseKey(io: Apple2IO): void {
    io.keyUp();
}

/**
 * Queues characters to be typed one after another. A program only sees
 * the *latest* latched key when it next reads $C000, so pasting a whole
 * word in one frame would drop all but the last letter; spacing presses a
 * few frames apart lets even a slow menu loop pick each one up.
 */
export class KeyTypingQueue {
    private queue: number[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private readonly io: Apple2IO,
        private readonly spacingMs = 70,
        private readonly holdMs = 35
    ) {}

    type(code: number): void {
        this.queue.push(code);
        if (this.timer === undefined) {
            this.drain();
        }
    }

    private drain(): void {
        const code = this.queue.shift();
        if (code === undefined) {
            this.timer = undefined;
            return;
        }
        pressKey(this.io, code);
        setTimeout(() => releaseKey(this.io), this.holdMs);
        this.timer = setTimeout(() => this.drain(), this.spacingMs);
    }
}

/**
 * Holds a key down with typematic repeat, like a real //e keyboard does
 * when you keep an arrow key pressed. Used by the on-screen joystick's
 * "arrow keys" mode: a held direction re-latches the key every
 * `repeatMs` after an initial `delayMs`, so menus and keyboard games that
 * poll the strobe see a stream of presses rather than one.
 */
export class HeldKey {
    private code: number | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private readonly io: Apple2IO,
        private readonly delayMs = 350,
        private readonly repeatMs = 90
    ) {}

    hold(code: number): void {
        if (this.code === code) {
            return;
        }
        this.clearTimer();
        this.code = code;
        pressKey(this.io, code);
        this.timer = setTimeout(() => this.repeat(), this.delayMs);
    }

    release(): void {
        this.clearTimer();
        if (this.code !== undefined) {
            this.code = undefined;
            releaseKey(this.io);
        }
    }

    private repeat(): void {
        if (this.code === undefined) {
            return;
        }
        pressKey(this.io, this.code);
        this.timer = setTimeout(() => this.repeat(), this.repeatMs);
    }

    private clearTimer(): void {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }
}
