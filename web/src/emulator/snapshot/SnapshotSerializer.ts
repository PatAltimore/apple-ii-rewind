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
    resyncAudioClock(apple2);
}

/**
 * Apple2IO generates speaker samples by walking a private cycle counter
 * (`_sampleTime`) up to the CPU's current cycle count on every frame. That
 * counter is not part of the IO state, so after a snapshot restore it still
 * holds the pre-restore value while `cpu.cycles` has jumped backward: the
 * sample loop then produces nothing until the CPU catches back up, which
 * is heard as silence for as long as the rewind was (reported as "sound is
 * lost during replay, starts again after a few seconds"). Restoring a
 * *newer* state (loading a save, scrubbing forward) has the opposite
 * problem: one frame tries to emit every sample in the gap at once.
 * Snapping the counter to the restored cycle count fixes both; the
 * partially filled sample buffer is left alone, it is at most one
 * quantum of stale audio.
 */
function resyncAudioClock(apple2: Apple2): void {
    const io = apple2.getIO() as unknown as { _sampleTime: number };
    io._sampleTime = apple2.getCPU().getCycles();
}
