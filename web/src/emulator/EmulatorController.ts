import { Apple2 } from 'js/apple2';
import { Audio } from 'js/ui/audio';
import { CPU6502 } from '@whscullin/cpu6502';
import { BLOCK_FORMATS } from 'js/formats/types';
import { includes, Card, byte } from 'js/types';
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

/**
 * Applesoft's "warm start" entry: `$E003` is `JMP $D43C`, and $D43C is
 * this ROM's `RESTART` routine (per apple2js's own js/symbols.ts) — the
 * same address Applesoft's own reset-vector setup installs at the //e's
 * soft reset vector ($3F2/$3F3) so a real Ctrl-Reset returns to `]`
 * without disrupting the running program more than necessary. Jumping
 * straight here is the standard, well-known monitor incantation
 * (`E003G`), consistent across the whole Applesoft-in-ROM lineage
 * (II+ with the Applesoft firmware card, //e, //c).
 *
 * (An earlier version of this jumped to $E000 instead. Confirmed by
 * reading the ROM's own bytes live: $E000 is actually `JMP $F128`, the
 * *machine's* whole power-on reset — including a peripheral-slot
 * autostart scan — not Applesoft's own entry, and landing there
 * mid-session sent the CPU into empty slots' unmapped ROM space instead
 * of a prompt.)
 */
const APPLESOFT_WARM_START = 0xe003;

/**
 * A slot with nothing plugged into it, standing in for slots 1-6 (Total
 * Replay only ever uses slot 7). Every ROM byte is `$60` (RTS), so any
 * stray access into an empty slot's address space — whether a genuine
 * data read or the CPU actually trying to *execute* from there —
 * resolves immediately instead of running into whatever apple2js leaves
 * an unpopulated slot showing. See `breakToApplesoft` below for why this
 * matters: without it, breaking into BASIC mid-session left the CPU
 * spinning forever in slot 2's address space instead of ever reaching
 * a prompt — apple2js's own peripheral-card-scan/expansion-ROM paging
 * logic (triggered by *any* access to $C100-$C7FF, real hardware
 * behavior) evidently expects something coherent to be there once
 * touched, which a genuinely absent card doesn't provide.
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

/**
 * Breaks out of whatever is currently running — Total Replay's menu or a
 * game — directly into an interactive Applesoft prompt, bypassing the
 * soft reset vector Total Replay's launcher installs at $3F2 to always
 * return to its own menu.
 *
 * Jumping straight to Applesoft's RESTART isn't enough on its own: mid
 * session, the //e's text window, cursor position and video softswitches
 * are left however the running program last used them (confirmed live:
 * Total Replay leaves the scroll window restricted to a few bottom rows,
 * so RESTART's own screen-clear-and-prompt ran, correctly, entirely
 * outside the visible screen — nothing was wrong, it just couldn't be
 * seen). This resets them to the standard full-screen 40-column text
 * defaults before jumping in, the same way a genuine cold boot would:
 * TXTSET/PAGE1/LORES softswitches, a blanked text page, and the
 * $20-$25/$32 zero-page window+cursor+text-mode variables GETLN and COUT
 * depend on.
 *
 * hardReset() first gives a clean CPU/MMU baseline (registers, stack,
 * ROM banked in) so a program that left the 6502 mid-instruction-stream
 * (interrupts disabled, decimal mode, a blown stack) doesn't carry into
 * BASIC. Safe to call mid-run (no stop()/run() needed, matching the
 * keyboard's own Ctrl-Reset): everything here runs synchronously in one
 * JS turn, so the run loop's rAF callback can't interleave and execute
 * anything between the reset and the state patches.
 */
export function breakToApplesoft(apple2: Apple2): void {
    const io = apple2.getIO();
    for (const slot of [1, 2, 3, 4, 5, 6] as const) {
        io.setSlot(slot, new EmptySlotStub());
    }

    hardReset(apple2);
    const cpu = apple2.getCPU();

    const writeByte = (addr: number, value: number) => cpu.write((addr >> 8) & 0xff, addr & 0xff, value & 0xff);
    const readSwitch = (offset: number) => cpu.read(0xc0, offset); // triggers the softswitch as a side effect

    readSwitch(0x51); // TXTSET (40-column text mode)
    readSwitch(0x54); // PAGE1 (display text page 1, not page 2)
    readSwitch(0x56); // LORES (clears the stale hires flag; irrelevant once text mode is set, but keeps state consistent)

    // Blank text page 1 ($0400-$07FF): $A0 is a plain, non-inverse space.
    for (let page = 0x04; page <= 0x07; page++) {
        for (let offset = 0; offset <= 0xff; offset++) {
            cpu.write(page, offset, 0xa0);
        }
    }

    // Standard full-screen text window, cursor homed, normal (non-inverse) text.
    writeByte(0x20, 0x00); // WNDLFT
    writeByte(0x21, 0x28); // WNDWDTH = 40
    writeByte(0x22, 0x00); // WNDTOP
    writeByte(0x23, 0x18); // WNDBTM = 24
    writeByte(0x24, 0x00); // CH (cursor column)
    writeByte(0x25, 0x00); // CV (cursor row)
    writeByte(0x32, 0xff); // INVFLG = normal text

    const state = cpu.getState();
    state.pc = APPLESOFT_WARM_START;
    cpu.setState(state);
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
