import { Apple2 } from 'js/apple2';
import { initGamepad } from 'js/ui/gamepad';
import { Audio } from 'js/ui/audio';
import { CPU6502 } from '@whscullin/cpu6502';
import { BLOCK_FORMATS } from 'js/formats/types';
import { includes, Card, byte } from 'js/types';
import DiskII from 'js/cards/disk2';
import type { Callbacks } from 'js/cards/disk2';
import type Apple2IO from 'js/apple2io';
import SyncSmartPort from './SyncSmartPort';
import { getCachedDisk, putCachedDisk } from './DiskCache';
import { isBlockFormat, isFloppyFormat, parseImageUrl, sniffImage, toFetchableUrl } from './imageFormat';

export interface EmulatorHandles {
    apple2: Apple2;
    smartport: SyncSmartPort;
    /**
     * Disk II controller in slot 6 for user-loaded 5.25" images. Absent
     * in `?boot=basic` mode (an empty Disk II in slot 6 would hang the
     * ROM's boot scan there, where slots 1-6 are otherwise stubbed).
     */
    floppy?: FloppyCard;
    cpu: CPU6502;
    audio: Audio;
}

/**
 * apple2js's Disk II card, minus its snapshot footprint. Its `getState()`
 * deep-copies every nibblised track (~230KB), and rewind/save snapshots
 * here are deliberately ~170KB (see SyncSmartPort for the same choice on
 * the hard drive). Reporting an empty state keeps a mounted floppy out of
 * snapshots; rewinding therefore doesn't un-write the disk, which — as
 * with the hard drive — is the behaviour you'd want anyway.
 */
class FloppyCard extends DiskII {
    override getState() {
        return { excludedFromSnapshot: true } as unknown as ReturnType<DiskII['getState']>;
    }
    override setState() {
        /* intentionally not restored — see the class comment */
    }
}

const noopDriveCallbacks: Callbacks = {
    driveLight: () => {},
    dirty: () => {},
    label: () => {},
};

/**
 * Builds the slot-6 Disk II card. apple2js's `DiskII` spins up a format
 * Web Worker from a hardcoded `dist/format_worker.bundle.js` that this
 * Vite build doesn't produce; with `window.Worker` hidden for the
 * duration of the constructor its `initWorker()` early-returns, and
 * `setBinary()` then decodes images synchronously on the main thread via
 * `createDisk()` — fine for 140K floppies.
 */
function createFloppyCard(io: Apple2IO): FloppyCard {
    const realWorker = (window as { Worker?: unknown }).Worker;
    try {
        (window as { Worker?: unknown }).Worker = undefined;
        return new FloppyCard(io, noopDriveCallbacks);
    } finally {
        (window as { Worker?: unknown }).Worker = realWorker;
    }
}

export type { FloppyCard };

/**
 * A slot with nothing plugged into it, standing in for slots 1-6 (Total
 * Replay only ever uses slot 7). Every ROM byte is `$60` (RTS), so any
 * stray access into an empty slot's address space — whether a genuine
 * data read or the CPU actually trying to *execute* from there —
 * resolves immediately instead of running into whatever apple2js leaves
 * an unpopulated slot showing.
 *
 * Confirmed necessary live: booting with no disk mounted anywhere (see
 * `bootEmulator`'s `emptySlotStubs` option, used for the Applesoft-only
 * boot mode) left the CPU spinning forever in slot 2's address space
 * partway through the ROM's own peripheral-slot autostart scan, without
 * this. apple2js's expansion-ROM paging logic (triggered by *any* access
 * to $C100-$C7FF — real //e hardware behavior) evidently expects
 * something coherent to be there once touched, which a genuinely absent
 * slot doesn't provide. Total Replay's own boot (slot 7 populated, 1-6
 * never touched) doesn't hit this, so it's only wired in for the
 * Applesoft boot path, not the default one, to avoid any chance of
 * changing behavior for the hundreds of already-verified-working games.
 */
class EmptySlotStub implements Card<Record<string, never>> {
    read(): byte {
        return 0x60;
    }
    write(): void {
        /* no device here */
    }
    ioSwitch(): byte {
        return 0x60;
    }
    getState(): Record<string, never> {
        return {};
    }
    setState(): void {
        /* nothing to restore */
    }
}

export interface BootOptions {
    /** Install EmptySlotStub in slots 1-6 — see that class's comment. */
    emptySlotStubs?: boolean;
}

/**
 * Boots an Enhanced Apple //e (128K, 65C02) with a hard-drive controller in
 * slot 7. That is the profile Total Replay targets: the //e ROM's autoboot
 * scans slot 7 first, finds the SmartPort boot signature, and boots
 * straight from a mounted .hdv (see `loadBlockImageFromUrl`) — or, if
 * nothing is ever mounted there, finds no bootable device anywhere and
 * falls through to an Applesoft BASIC prompt instead, which is how
 * `main.ts`'s Applesoft-only boot mode (`?boot=basic`) works: same boot
 * path, same ROM, just never loading Total Replay's drive. No Disk II
 * card is wired: Total Replay never touches a floppy, and leaving the
 * card out also avoids apple2js's DiskII Web Worker path that doesn't
 * exist in this Vite build.
 *
 * The hard-drive controller is this app's own SyncSmartPort rather than
 * apple2js's card — see that file for why (load speed, and keeping the
 * 32MB drive out of rewind/save snapshots).
 */
export async function bootEmulator(
    canvas: HTMLCanvasElement,
    tick: () => void,
    options: BootOptions = {}
): Promise<EmulatorHandles> {
    const apple2 = new Apple2({
        canvas,
        gl: false,
        rom: 'apple2enh',
        characterRom: 'apple2enh_char',
        e: true,
        enhanced: true,
        tick,
    });
    await apple2.ready;

    const cpu = apple2.getCPU();
    const io = apple2.getIO();

    // apple2js initialises paddles to 0.0 (hard left/up). Centre them so
    // joystick-reading games don't see a permanently deflected stick when
    // no gamepad or on-screen joystick is in use.
    io.paddle(0, 0.5);
    io.paddle(1, 0.5);
    io.paddle(2, 0.5);
    io.paddle(3, 0.5);

    // apple2js's gamepad button map (js/ui/gamepad.ts) starts out empty —
    // this app has no settings UI that calls initGamepad() the way
    // apple2js's own js/ui/apple2.ts does, so without this, a connected
    // controller's analog stick moves the paddles (that read happens
    // unconditionally in processGamepad()) but every button press is a
    // no-op: A/B/L1/R1 fire nothing and Start doesn't send Esc.
    initGamepad();

    // apple2js's processGamepad() always reads navigator.getGamepads()[0]
    // — fine with one controller, but some Xbox pads leave one or two
    // dead entries in the array (raw Bluetooth HID interfaces Chrome
    // can't map — `mapping: ""` — and never delivers live input for)
    // *ahead of* the entry Chrome actually drives, which shows up with
    // `mapping: "standard"` once recognised (e.g. as its built-in
    // "Xbox 360 Controller (XInput STANDARD GAMEPAD)" over USB).
    // Confirmed live: a user's controller sat at index 2 behind two
    // frozen Bluetooth duplicates at 0/1, so index-0 wiring never saw a
    // single live input. Reorder what apple2js sees — same spirit as
    // hiding window.Worker for createFloppyCard() above: work around a
    // vendored assumption without touching vendor/ itself — rather than
    // patch the vendor file for one hardcoded index.
    const nativeGetGamepads = navigator.getGamepads.bind(navigator);
    Object.defineProperty(navigator, 'getGamepads', {
        configurable: true,
        value: (): (Gamepad | null)[] => {
            const pads = nativeGetGamepads();
            const idx = pads.findIndex((pad) => pad?.mapping === 'standard');
            if (idx <= 0) {
                return pads;
            }
            const reordered = pads.slice();
            const [preferred] = reordered.splice(idx, 1);
            reordered.unshift(preferred);
            return reordered;
        },
    });

    const smartport = new SyncSmartPort(cpu);
    io.setSlot(7, smartport);

    let floppy: FloppyCard | undefined;
    if (options.emptySlotStubs) {
        for (const slot of [1, 2, 3, 4, 5, 6] as const) {
            io.setSlot(slot, new EmptySlotStub());
        }
    } else {
        // A Disk II card in slot 6 so user-loaded 5.25" images can boot.
        // Empty until one is loaded; the ROM's boot scan falls through it
        // to slot 7 (or, with slot 7 also empty, past it) with no disk.
        floppy = createFloppyCard(io);
        io.setSlot(6, floppy);
    }

    // apple2js's Audio class loads its AudioWorklet from the hardcoded
    // path ./dist/audio_worker.bundle.js; scripts/build-audio-worklet.mjs
    // produces that file before dev/build.
    const audio = new Audio(io);
    await audio.ready;

    return { apple2, smartport, floppy, cpu, audio };
}

/**
 * Simulates Ctrl-Reset the way the hardware does it.
 *
 * `Apple2.reset()` is just `cpu.reset()`, and apple2js's CPU reads the
 * reset vector at $FFFC *before* notifying its reset handlers — including
 * the MMU, which is what re-banks ROM over language-card RAM. If a game
 * (or Total Replay's launcher) has LC RAM switched in at $D000-$FFFF, the
 * vector is read from that RAM instead of ROM and the machine jumps into
 * garbage. Resetting the MMU first restores the ROM mapping, so the ROM's
 * reset routine runs, finds Total Replay's soft-reset vector at $3F2 and
 * relaunches the menu — which is what makes this the "quit game" button.
 */
export function hardReset(apple2: Apple2): void {
    const mmu = (apple2 as unknown as { mmu?: { reset(): void } }).mmu;
    mmu?.reset();
    apple2.reset();
}

export type ProgressCallback = (loadedBytes: number, totalBytes: number | undefined) => void;

export interface LoadBlockImageResult {
    /** True when the image came from Cache Storage instead of the network — see DiskCache.ts. */
    fromCache: boolean;
}

/**
 * Mounts a block-device image (.hdv/.2mg/.po) in the given drive, from
 * Cache Storage if a previous visit already downloaded and cached it (see
 * DiskCache.ts), otherwise fetching it fresh and caching it for next time.
 * A fresh fetch streams the download so the caller can show progress —
 * Total Replay is 32MB, which is a noticeable wait on a phone.
 */
export async function loadBlockImageFromUrl(
    smartport: SyncSmartPort,
    driveNo: 1 | 2,
    url: string,
    onProgress?: ProgressCallback
): Promise<LoadBlockImageResult> {
    const cached = await getCachedDisk(url);
    let rawData: ArrayBuffer;
    if (cached) {
        rawData = cached;
        onProgress?.(cached.byteLength, cached.byteLength);
    } else {
        rawData = await fetchAndCache(url, onProgress);
    }

    const { name, ext } = parseImageUrl(url);
    if (!includes(BLOCK_FORMATS, ext)) {
        throw new Error(`Unrecognized block image extension: "${ext}"`);
    }
    smartport.mount(driveNo, name, ext, rawData);
    return { fromCache: cached !== undefined };
}

async function fetchAndCache(url: string, onProgress?: ProgressCallback): Promise<ArrayBuffer> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch disk image: ${response.status} ${response.statusText}`);
    }
    // Cache Storage needs its own, never-read copy of the response — clone
    // it before either stream is consumed, then read the original for the
    // caller and cache the clone in the background (don't block boot on
    // the write completing).
    const toCache = response.clone();
    const rawData = await readWithProgress(response, onProgress);
    void putCachedDisk(url, toCache);
    return rawData;
}

async function readWithProgress(response: Response, onProgress?: ProgressCallback): Promise<ArrayBuffer> {
    const lengthHeader = response.headers.get('Content-Length');
    const total = lengthHeader ? Number(lengthHeader) : undefined;
    if (!response.body || !onProgress) {
        return response.arrayBuffer();
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        chunks.push(value);
        loaded += value.byteLength;
        onProgress(loaded, total);
    }
    const result = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result.buffer;
}

export interface LoadImageResult {
    /** Short human summary of what was mounted, e.g. "140K 5.25″ disk". */
    description: string;
    /** Which card it went into. */
    kind: 'block' | 'floppy';
    fromCache: boolean;
}

/**
 * Fetches an arbitrary Apple II disk image and mounts it in drive 1 —
 * block images (.hdv/.2mg/big .po) in the SmartPort card, 5.25" images in
 * the Disk II card (with SmartPort drive 1 emptied so the ROM's boot scan
 * falls through to slot 6). `rawUrl` is whatever the user pasted or a
 * curated entry; archive.org links are rewritten to the CORS proxy.
 *
 * Does **not** reset — call this before the machine's initial
 * `apple2.reset()` so the first boot targets the mounted disk. Runtime
 * disk switching is done by reloading the page with a `?disk=` parameter
 * (see main.ts) rather than resetting a running machine: a mid-session
 * cold reset leaves MMU/soft-switch state (INTCXROM, expansion-ROM latch,
 * language-card banking) from the previous disk that can hang the slot
 * scan — the same reason `?boot=basic` is a real reload, not a jump.
 */
export async function loadImageFromUrl(
    handles: Pick<EmulatorHandles, 'apple2' | 'smartport' | 'floppy'>,
    rawUrl: string,
    onProgress?: ProgressCallback
): Promise<LoadImageResult> {
    const url = toFetchableUrl(rawUrl);

    const cached = await getCachedDisk(url);
    let rawData: ArrayBuffer;
    if (cached) {
        rawData = cached;
        onProgress?.(cached.byteLength, cached.byteLength);
    } else {
        rawData = await fetchAndCache(url, onProgress);
    }

    const { name } = parseImageUrl(url);
    const sniffed = sniffImage(name, rawData);

    if (sniffed.kind === 'block') {
        // The floppy drive, if one is present, is left as-is: the ROM's
        // boot scan reaches slot 7 (SmartPort) before slot 6, so a stale
        // floppy there never wins.
        if (!isBlockFormat(sniffed.format)) {
            throw new Error(`Not a block image format: "${sniffed.format}"`);
        }
        handles.smartport.mount(1, name, sniffed.format, rawData);
    } else {
        if (!handles.floppy) {
            throw new Error('5.25″ disks can’t be loaded in this mode.');
        }
        if (!isFloppyFormat(sniffed.format)) {
            throw new Error(`Not a 5.25″ image format: "${sniffed.format}"`);
        }
        handles.smartport.unmount(1);
        await handles.floppy.setBinary(1, name, sniffed.format, rawData);
    }

    return { description: sniffed.description, kind: sniffed.kind, fromCache: cached !== undefined };
}
