import { APPLE_KEY } from './keyInput';

/**
 * Keyboard direction layouts the on-screen joystick can emulate in "Keys"
 * mode (see ui/TouchControls.ts). Before the //e added up/down arrows
 * (1983), Apple II games each picked their own movement keys, and the
 * Total Replay library spans that whole era, so one arrow-key mapping only
 * covers the launcher and the later titles. These are the layouts that
 * recur across many games; a game's own instructions (Total Replay shows
 * them on its info page) say which one it wants.
 *
 * Letters are upper-case ASCII — everything this app sends is (see
 * ALWAYS_CAPS in keyboard.ts). Layouts with diagonal entries make the
 * stick snap to eight directions instead of four.
 */
export interface DirectionKeys {
    up: number;
    down: number;
    left: number;
    right: number;
    upLeft?: number;
    upRight?: number;
    downLeft?: number;
    downRight?: number;
}

export interface KeyLayout {
    id: string;
    /** Short label for the layout picker. */
    label: string;
    keys: DirectionKeys;
}

const ch = (c: string): number => c.toUpperCase().charCodeAt(0);

export const KEY_LAYOUTS: readonly KeyLayout[] = [
    {
        // The //e keys; Total Replay's launcher, Ultima III and later, etc.
        id: 'arrows',
        label: 'Arrow keys',
        keys: { up: APPLE_KEY.UP, down: APPLE_KEY.DOWN, left: APPLE_KEY.LEFT, right: APPLE_KEY.RIGHT },
    },
    {
        // The classic II/II+ "diamond": Qix, Aztec, Ms. Pac-Man, many more.
        id: 'ijkm',
        label: 'I J K M',
        keys: { up: ch('I'), left: ch('J'), right: ch('K'), down: ch('M') },
    },
    {
        // Lode Runner and Championship Lode Runner.
        id: 'ijkl',
        label: 'I J K L (Lode Runner)',
        keys: { up: ch('I'), left: ch('J'), down: ch('K'), right: ch('L') },
    },
    {
        // II+ games that used the two arrows the machine had, plus A/Z
        // for up/down: Gorgon and its contemporaries.
        id: 'az-arrows',
        label: 'A Z + ← →',
        keys: { up: ch('A'), down: ch('Z'), left: APPLE_KEY.LEFT, right: APPLE_KEY.RIGHT },
    },
    {
        // Eight-way block around S: Castle Wolfenstein, Beyond Castle
        // Wolfenstein.
        id: 'qweadzxc',
        label: 'Q W E / A D / Z X C (Wolfenstein)',
        keys: {
            upLeft: ch('Q'),
            up: ch('W'),
            upRight: ch('E'),
            left: ch('A'),
            right: ch('D'),
            downLeft: ch('Z'),
            down: ch('X'),
            downRight: ch('C'),
        },
    },
];

export const DEFAULT_KEY_LAYOUT_ID = 'arrows';

export function findKeyLayout(id: string | null | undefined): KeyLayout | undefined {
    return KEY_LAYOUTS.find((l) => l.id === id);
}

export function layoutHasDiagonals(layout: KeyLayout): boolean {
    const k = layout.keys;
    return k.upLeft !== undefined || k.upRight !== undefined || k.downLeft !== undefined || k.downRight !== undefined;
}

/**
 * Key code for a stick direction given as unit steps (-1/0/1 per axis,
 * screen coordinates so +y is down). Returns undefined for centre, or for
 * a diagonal in a four-way layout.
 */
export function keyForDirection(layout: KeyLayout, sx: number, sy: number): number | undefined {
    const k = layout.keys;
    if (sy < 0) {
        return sx < 0 ? k.upLeft : sx > 0 ? k.upRight : k.up;
    }
    if (sy > 0) {
        return sx < 0 ? k.downLeft : sx > 0 ? k.downRight : k.down;
    }
    return sx < 0 ? k.left : sx > 0 ? k.right : undefined;
}
