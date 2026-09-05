import { State } from 'js/apple2';

export interface RewindEntry {
    timestamp: number;
    state: State;
    /** PNG data URL, see thumbnail.ts. */
    thumbnail: string;
}

/**
 * Fixed-size in-memory ring buffer of timestamped snapshots for scrub-style
 * rewind. Not persisted — only needs to survive the current session.
 *
 * Sized by wall-clock time, not frame count: a raw (unencoded) snapshot for
 * this game measures ~451KB (mostly the ~233KB loaded disk image, plus
 * ~166KB of RAM/aux-RAM — see docs/SPIKE-NOTES.md for the full breakdown
 * and the memory-budget reasoning behind the interval chosen in main.ts).
 * Frame-counting would tie rewind depth to actual fps, which varies with
 * device/tab-visibility (see the rAF-throttling notes elsewhere in
 * SPIKE-NOTES); wall-clock timestamps keep "5 minutes of rewind" and "jump
 * back 10 seconds" accurate regardless. Each entry also carries a small
 * thumbnail (a few KB, negligible next to the ~451KB snapshot itself) so
 * the scrubber UI can preview a position before committing to it.
 */
// This is the one class-based module in the app (most of the rest of the
// codebase uses the closure-based "handle" pattern instead — see main.ts's
// top-of-file note for that alternative). A `class` bundles state
// (`entries`) and the functions that operate on it (`push`, `at`, etc.,
// called "methods") into one named, reusable blueprint — reach for one
// when you want multiple independent instances of the same behavior, each
// with its own private state, which is exactly the case here: main.ts
// creates exactly one `RewindBuffer`, but nothing here prevents making a
// second, fully independent one for a different purpose.
export class RewindBuffer {
    // `private` restricts this field to code inside this class — even
    // code elsewhere in this same file can't reach `someBuffer.entries`
    // directly, only through the methods below. It's the class-based
    // equivalent of the privacy a closure gives a plain function's local
    // variables.
    private entries: RewindEntry[] = [];

    // `constructor(private readonly capacity: number) {}` is TypeScript
    // shorthand: writing `private`/`readonly` directly on a constructor
    // parameter both declares a class field of that name *and* assigns
    // the passed-in argument to it, in one line — equivalent to writing
    // `private readonly capacity: number; constructor(capacity: number) {
    // this.capacity = capacity; }` the long way. `readonly` means it can
    // only ever be set once (right here, at construction), never
    // reassigned later.
    constructor(private readonly capacity: number) {}

    push(state: State, thumbnail: string, timestamp: number = Date.now()): void {
        this.entries.push({ timestamp, state, thumbnail });
        // This is what makes it a *ring buffer* (a.k.a. circular buffer):
        // a fixed maximum size where adding one more item past that size
        // discards the oldest one instead of growing forever.
        // `Array.shift()` removes and returns the *first* element — the
        // oldest entry, since new ones are always `.push()`ed onto the
        // end — which is a bit more expensive than removing from the end
        // (every remaining element has to shift down one index) but is
        // the right end to remove from here, and this only runs once
        // every `intervalMs` (5 seconds), so the cost is irrelevant.
        if (this.entries.length > this.capacity) {
            this.entries.shift();
        }
    }

    // A `get` method ("getter") is called like a plain property —
    // `buffer.length`, no parentheses — while still running code each
    // time it's read. Useful here so callers can treat `.length` like any
    // other property without knowing (or caring) that it's actually
    // computed from the private `entries` array underneath.
    get length(): number {
        return this.entries.length;
    }

    /** Snapshot at `index`, 0 = oldest, length-1 = newest. */
    at(index: number): State | undefined {
        // `this.entries[index]` is `undefined` if `index` is out of
        // range (JS array indexing never throws, it just gives you
        // `undefined`) — `?.state` ("optional chaining") means "read
        // `.state` only if the thing on the left isn't null/undefined,
        // otherwise short-circuit to `undefined` instead of throwing a
        // TypeError." Without it, an out-of-range `index` would crash on
        // `undefined.state`.
        return this.entries[index]?.state;
    }

    timestampAt(index: number): number | undefined {
        return this.entries[index]?.timestamp;
    }

    thumbnailAt(index: number): string | undefined {
        return this.entries[index]?.thumbnail;
    }

    get newestTimestamp(): number | undefined {
        return this.entries[this.entries.length - 1]?.timestamp;
    }

    /**
     * Index of the snapshot closest to (at or before) `secondsAgo` seconds
     * before the newest entry. Returns the oldest available entry if the
     * buffer doesn't have enough history yet, or undefined if empty.
     */
    indexSecondsAgo(secondsAgo: number): number | undefined {
        if (this.entries.length === 0) {
            return undefined;
        }
        // `this.newestTimestamp!` — the `!` asserts "I know this isn't
        // undefined," which is safe here specifically because of the
        // `length === 0` check just above: `newestTimestamp` is only
        // undefined when the buffer is empty, and this line is
        // unreachable in that case. TypeScript's own analysis can't
        // always follow that kind of reasoning across a getter call, so
        // the assertion tells it to trust the surrounding logic instead.
        const target = this.newestTimestamp! - secondsAgo * 1000;
        // Walking backward from the newest entry (rather than forward
        // from the oldest) means this finds the answer in the fewest
        // steps for the common case — rewinding a few seconds — since
        // that target is close to the end of the array; it only has to
        // walk the full array in the rare case of rewinding almost the
        // entire buffer.
        for (let i = this.entries.length - 1; i >= 0; i--) {
            if (this.entries[i].timestamp <= target) {
                return i;
            }
        }
        return 0;
    }

    clear(): void {
        this.entries = [];
    }

    /**
     * Discards every entry after `index` — call when gameplay resumes from
     * a rewound point (scrubber release, rewind button/key). Without this,
     * RewindRecorder keeps appending new snapshots by wall-clock time
     * regardless of what the emulator is actually doing, so the entries
     * recorded *before* the rewind but *after* the restored point are from
     * a timeline that no longer happened — scrubbing into them would show
     * stale, diverged gameplay, and the slider wouldn't reflect "now" until
     * the next scheduled snapshot happened to land, up to intervalMs later.
     */
    truncateAfter(index: number): void {
        // Clamped to the current length on both ends: setting .length past
        // an array's current size doesn't truncate, it *grows* it with
        // empty holes — never what a "discard the future" operation should
        // do, so an out-of-range index is a no-op here, not silent
        // corruption.
        this.entries.length = Math.max(0, Math.min(index + 1, this.entries.length));
    }
}

/**
 * Drives periodic snapshotting from the emulator's per-frame tick hook.
 * Call `onTick()` every frame; it pushes a new snapshot once at least
 * `intervalMs` of wall-clock time has passed since the last one.
 *
 * The actual capture work (~11ms measured: ~1ms to copy state, ~10ms for
 * PNG-encoding the thumbnail) is deferred to a separate macrotask
 * (`setTimeout(..., 0)`) rather than run synchronously inside `onTick()`.
 * `onTick()` is called from the same per-frame callback that drives audio
 * sample generation (`Apple2IO.tick()`) and schedules the next
 * `requestAnimationFrame` (see apple2.ts's `run()`), so ~11ms of
 * synchronous work there — more than half of a 60fps frame's ~16.7ms
 * budget — delayed the next frame's audio generation enough to be an
 * audible glitch every single interval. Reported via playtesting as
 * "pulsing... not steady... a stutter", which lines up exactly with a
 * hitch recurring on the snapshot interval. Deferring lets the current
 * frame (and the next rAF scheduling) complete first; the snapshot lands
 * a macrotask later, a few ms of skew that's irrelevant at 5-second
 * granularity.
 *
 * LEARNING NOTE — what "macrotask" means: the browser's JS engine runs
 * one thing at a time on a single thread, working through a queue of
 * discrete units of work. `setTimeout(fn, 0)` doesn't run `fn`
 * *immediately* — it puts `fn` at the back of that queue (a "macrotask"),
 * to run only once everything already queued or currently executing
 * finishes, even though the requested delay is zero. That's exactly what
 * this code wants: "run this, but only after the current frame's already
 * synchronous work — including the code that schedules the *next*
 * frame — has had a chance to finish first," rather than "run this right
 * this instant, blocking whatever's already in progress."
 */
export class RewindRecorder {
    private lastSnapshotAt = 0;
    // Tracks whether a deferred capture (the setTimeout below) is still
    // waiting to run. Needed because `onTick` fires every frame — without
    // this flag, if a capture somehow took longer than one frame, the
    // *next* tick could see enough time has passed and schedule a second
    // overlapping capture before the first has even landed.
    private capturePending = false;

    // `captureFn`/`thumbnailFn` are functions *passed in* by main.ts
    // rather than this class importing `captureSnapshot`/`captureThumbnail`
    // and calling them directly — a small example of "dependency
    // injection": this class knows it needs *some* way to capture a
    // snapshot and a thumbnail, but not the concrete details of how,
    // which keeps it decoupled from those other modules.
    constructor(
        private readonly buffer: RewindBuffer,
        private readonly intervalMs: number,
        private readonly captureFn: () => State,
        private readonly thumbnailFn: () => string
    ) {}

    onTick(): void {
        const now = Date.now();
        if (now - this.lastSnapshotAt >= this.intervalMs && !this.capturePending) {
            this.lastSnapshotAt = now;
            this.capturePending = true;
            setTimeout(() => {
                this.buffer.push(this.captureFn(), this.thumbnailFn(), now);
                this.capturePending = false;
            }, 0);
        }
    }
}
