import { Apple2, State } from 'js/apple2';

/**
 * apple2js's Apple2 class implements Restorable<State>: CPU registers,
 * video-mode softswitches, IO (annunciators plus every slot's card state),
 * MMU bank switching, and both 64K RAM banks. The SmartPort card is wrapped
 * (see EmulatorController.ts) so the 32MB hard drive is *not* part of this
 * — a snapshot is ~170KB of plain objects and Uint8Arrays, which IndexedDB
 * stores directly via structured clone, so no text encoding is needed.
 */
export function captureSnapshot(apple2: Apple2): State {
    return apple2.getState();
}

export function restoreSnapshot(apple2: Apple2, state: State): void {
    apple2.setState(state);
}
