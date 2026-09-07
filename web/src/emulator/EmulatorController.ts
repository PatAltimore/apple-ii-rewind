import { Apple2 } from 'js/apple2';
import { Audio } from 'js/ui/audio';
import { CPU6502 } from '@whscullin/cpu6502';
import { BLOCK_FORMATS } from 'js/formats/types';
import { includes } from 'js/types';
import SyncSmartPort from './SyncSmartPort';
import { getCachedDisk, putCachedDisk } from './DiskCache';

export interface EmulatorHandles {
    apple2: Apple2;
    smartport: SyncSmartPort;
    cpu: CPU6502;
    audio: Audio;
}

/**
 * Boots an Enhanced Apple //e (128K, 65C02) with a hard-drive controller in
 * slot 7. That is the profile Total Replay targets: the //e ROM's autoboot
 * scans slot 7 first, finds the SmartPort boot signature, and boots
 * straight from the mounted .hdv. No Disk II card is wired: Total Replay
 * never touches a floppy, and leaving the card out also avoids apple2js's
 * DiskII Web Worker path that doesn't exist in this Vite build.
 *
 * The controller is this app's own SyncSmartPort rather than apple2js's
 * card — see that file for why (load speed, and keeping the 32MB drive out
 * of rewind/save snapshots).
 */
export async function bootEmulator(canvas: HTMLCanvasElement, tick: () => void): Promise<EmulatorHandles> {
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

    const smartport = new SyncSmartPort(cpu);
    io.setSlot(7, smartport);

    // apple2js's Audio class loads its AudioWorklet from the hardcoded
    // path ./dist/audio_worker.bundle.js; scripts/build-audio-worklet.mjs
    // produces that file before dev/build.
    const audio = new Audio(io);
    await audio.ready;

    return { apple2, smartport, cpu, audio };
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

function parseImageUrl(url: string): { name: string; ext: string } {
    const name = url.split('/').pop() || url;
    const ext = name.split('.').pop()?.toLowerCase() || '';
    return { name, ext };
}
