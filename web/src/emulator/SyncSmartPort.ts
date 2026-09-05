import { rom as smartPortRom } from 'js/roms/cards/smartport';
import { read2MGHeader } from 'js/formats/2mg';
import { BlockFormat } from 'js/formats/types';
import { Card, byte } from 'js/types';
import { CPU6502, flags } from '@whscullin/cpu6502';

/**
 * A synchronous, in-memory SmartPort / ProDOS block-device card.
 *
 * Why not apple2js's own `js/cards/smartport.ts`? Two reasons, both about
 * how it stores the disk:
 *
 * 1. Its block I/O is `async` (to support worker-backed disks). A read
 *    marks the card BUSY and resolves on a *later* macrotask, but the
 *    emulator runs a whole frame's worth of cycles in one synchronous
 *    `stepCycles()` call — so the ROM busy-loops for the rest of the
 *    frame and every block costs ~16ms. Total Replay loads a 100KB+ game
 *    through a few hundred block reads, which came out at ~10 seconds
 *    per launch. Here the block is copied into emulated RAM immediately,
 *    inside the same instruction fetch that entered the card ROM, so
 *    loads run at emulated-CPU speed.
 * 2. Its `getState()` is `async` and copies every block of the drive (32MB
 *    for Total Replay). `Apple2IO.getState()` doesn't await it, so a
 *    snapshot would hold a dangling Promise. This card reports an empty
 *    state and ignores restores: the drive is deliberately *not* part of
 *    rewind/save snapshots (~170KB each instead of 32MB), and rewinding
 *    gameplay doesn't un-write the drive's prefs/high-score blocks.
 *
 * The ROM and the register/entry-point protocol are the same as
 * apple2js's card (same `js/roms/cards/smartport` image), so ProDOS and
 * Total Replay's ProRWTS talk to it exactly as they would upstream.
 */

// ProDOS block-device call parameters (zero page).
const COMMAND = 0x42;
const UNIT = 0x43;
const ADDRESS_LO = 0x44;
const BLOCK_LO = 0x46;

// Result codes.
const OK = 0x00;
const IO_ERROR = 0x27;
const NO_DEVICE_CONNECTED = 0x28;
const WRITE_PROTECTED = 0x2b;
const DEVICE_OFFLINE = 0x2f;

const DEVICE_TYPE_SCSI_HD = 0x07;
const VENDOR_ID = 'SMARTPORT.J.S';
const BLOCK_SIZE = 512;

export type DriveNumber = 1 | 2;

export interface MountedDisk {
    name: string;
    format: BlockFormat;
    /** Block-ordered image data (2mg header already stripped). */
    data: Uint8Array;
    readOnly: boolean;
}

/** Deliberately empty — see the class comment. */
export interface SyncSmartPortState {
    excludedFromSnapshot: true;
}

export default class SyncSmartPort implements Card<SyncSmartPortState> {
    private readonly rom = smartPortRom;
    // Indexed by drive number (1 or 2); index 0 unused.
    private disks: Array<MountedDisk | undefined> = [undefined, undefined, undefined];
    private statusByte = 0x00;
    private xReg = 0x00;
    private yReg = 0x00;

    constructor(private readonly cpu: CPU6502) {}

    // --- Mounting ---------------------------------------------------------

    mount(driveNo: DriveNumber, name: string, format: BlockFormat, rawData: ArrayBuffer): MountedDisk {
        let readOnly = false;
        let data: Uint8Array;
        if (format === '2mg') {
            const header = read2MGHeader(rawData);
            readOnly = header.readOnly;
            data = new Uint8Array(rawData, header.offset, header.bytes);
        } else {
            data = new Uint8Array(rawData);
        }
        if (data.byteLength % BLOCK_SIZE !== 0) {
            throw new Error(`Block image size ${data.byteLength} is not a multiple of ${BLOCK_SIZE}`);
        }
        const disk: MountedDisk = { name, format, data, readOnly };
        this.disks[driveNo] = disk;
        return disk;
    }

    unmount(driveNo: DriveNumber): void {
        this.disks[driveNo] = undefined;
    }

    getDisk(driveNo: DriveNumber): MountedDisk | undefined {
        return this.disks[driveNo];
    }

    private blockCount(driveNo: number): number {
        const disk = this.disks[driveNo];
        return disk ? disk.data.byteLength / BLOCK_SIZE : 0;
    }

    // --- Emulated-memory helpers -------------------------------------------

    private readByte(addr: number): byte {
        addr &= 0xffff;
        return this.cpu.read(addr >> 8, addr & 0xff);
    }

    private writeByte(addr: number, val: byte): void {
        addr &= 0xffff;
        this.cpu.write(addr >> 8, addr & 0xff, val);
    }

    private readWord(addr: number): number {
        return this.readByte(addr) | (this.readByte(addr + 1) << 8);
    }

    private writeWord(addr: number, val: number): void {
        this.writeByte(addr, val & 0xff);
        this.writeByte(addr + 1, (val >> 8) & 0xff);
    }

    // --- Commands ------------------------------------------------------------

    private begin(): void {
        this.xReg = 0x00;
        this.yReg = 0x00;
    }

    private deviceInfo(driveNo: number): number {
        if (!this.disks[driveNo]) {
            return NO_DEVICE_CONNECTED;
        }
        const blocks = this.blockCount(driveNo);
        this.xReg = blocks & 0xff;
        this.yReg = (blocks >> 8) & 0xff;
        return OK;
    }

    private readBlock(driveNo: number, blockNumber: number, buffer: number): number {
        const disk = this.disks[driveNo];
        if (!disk) {
            return DEVICE_OFFLINE;
        }
        const offset = blockNumber * BLOCK_SIZE;
        if (offset + BLOCK_SIZE > disk.data.byteLength) {
            return IO_ERROR;
        }
        for (let idx = 0; idx < BLOCK_SIZE; idx++) {
            this.writeByte(buffer + idx, disk.data[offset + idx]);
        }
        return OK;
    }

    private writeBlock(driveNo: number, blockNumber: number, buffer: number): number {
        const disk = this.disks[driveNo];
        if (!disk) {
            return DEVICE_OFFLINE;
        }
        if (disk.readOnly) {
            return WRITE_PROTECTED;
        }
        const offset = blockNumber * BLOCK_SIZE;
        if (offset + BLOCK_SIZE > disk.data.byteLength) {
            return IO_ERROR;
        }
        for (let idx = 0; idx < BLOCK_SIZE; idx++) {
            disk.data[offset + idx] = this.readByte(buffer + idx);
        }
        return OK;
    }

    private formatDevice(driveNo: number): number {
        const disk = this.disks[driveNo];
        if (!disk) {
            return DEVICE_OFFLINE;
        }
        if (disk.readOnly) {
            return WRITE_PROTECTED;
        }
        disk.data.fill(0);
        return OK;
    }

    // --- Card interface -----------------------------------------------------

    private access(off: byte, val?: byte): byte {
        let result = 0x00;
        const readMode = val === undefined;

        switch (off & 0x8f) {
            case 0x80:
                // Drives-present mask; the boot ROM does `LSR / BCS` on it,
                // so drive 1 must be bit 0 for autoboot to proceed.
                if (readMode) {
                    result = (this.disks[1] ? 0x01 : 0) | (this.disks[2] ? 0x02 : 0);
                }
                break;
            case 0x81:
                result = this.statusByte;
                break;
            case 0x82:
                result = this.xReg;
                break;
            case 0x83:
                result = this.yReg;
                break;
            case 0x84:
                result = this.statusByte ? 0x01 : 0x00;
                break;
        }

        return result & 0xff;
    }

    ioSwitch(off: byte, val?: byte): byte {
        return this.access(off, val);
    }

    read(_page: byte, off: byte): byte {
        const blockOff = this.rom[0xff];
        const smartOff = blockOff + 3;

        // Only act on an *instruction fetch* of the entry point (i.e. a
        // JSR into the card ROM), not on data reads of those bytes.
        if (off === blockOff && this.cpu.getSync()) {
            // ProDOS block-device entry: parameters in zero page.
            const cmd = this.readByte(COMMAND);
            const unit = this.readByte(UNIT);
            const buffer = this.readWord(ADDRESS_LO);
            const block = this.readWord(BLOCK_LO);
            const drive = unit & 0x80 ? 2 : 1;

            this.begin();
            switch (cmd) {
                case 0: // STATUS
                    this.statusByte = this.deviceInfo(drive);
                    break;
                case 1: // READ
                    this.statusByte = this.readBlock(drive, block, buffer);
                    break;
                case 2: // WRITE
                    this.statusByte = this.writeBlock(drive, block, buffer);
                    break;
                case 3: // FORMAT
                    this.statusByte = this.formatDevice(drive);
                    break;
                default:
                    this.statusByte = IO_ERROR;
            }
        } else if (off === smartOff && this.cpu.getSync()) {
            // SmartPort entry: `JSR entry / DFB cmd / DW cmdlist`. The
            // return address on the stack points at the cmd byte; read the
            // parameters, then bump the return address past the 3 inline
            // bytes.
            const state = this.cpu.getState();
            const stackAddr = 0x0100 + ((state.sp + 1) & 0xff);
            const retVal = this.readWord(stackAddr);
            const cmd = this.readByte(retVal + 1);
            const cmdListAddr = this.readWord(retVal + 2);
            this.writeWord(stackAddr, retVal + 3);

            const unit = this.readByte(cmdListAddr + 1);
            const buffer = this.readWord(cmdListAddr + 2);
            const drive: DriveNumber = unit === 2 ? 2 : 1;

            this.begin();
            switch (cmd) {
                case 0x00: {
                    // STATUS
                    const statusCode = this.readByte(cmdListAddr + 4);
                    if (unit === 0) {
                        if (statusCode === 0) {
                            this.writeByte(buffer, 2); // two devices
                            this.writeByte(buffer + 1, 1 << 6); // no interrupts
                            this.writeByte(buffer + 2, 0x2); // other vendor
                            this.writeByte(buffer + 3, 0x0);
                            this.writeByte(buffer + 4, 0);
                            this.writeByte(buffer + 5, 0);
                            this.writeByte(buffer + 6, 0);
                            this.writeByte(buffer + 7, 0);
                            this.xReg = 8;
                            this.yReg = 0;
                        }
                        this.statusByte = OK;
                    } else {
                        const blocks = this.blockCount(drive);
                        const present = this.disks[drive] ? 0xf0 : 0x00; // block device, r/w, online
                        this.writeByte(buffer, present);
                        this.writeByte(buffer + 1, blocks & 0xff);
                        this.writeByte(buffer + 2, (blocks >> 8) & 0xff);
                        this.writeByte(buffer + 3, (blocks >> 16) & 0xff);
                        if (statusCode === 3) {
                            // Device Information Block
                            this.writeByte(buffer + 4, VENDOR_ID.length);
                            for (let idx = 0; idx < 16; idx++) {
                                this.writeByte(buffer + 5 + idx, idx < VENDOR_ID.length ? VENDOR_ID.charCodeAt(idx) : 0x20);
                            }
                            this.writeByte(buffer + 21, DEVICE_TYPE_SCSI_HD);
                            this.writeByte(buffer + 22, 0x0); // subtype
                            this.writeWord(buffer + 23, 0x0101); // version
                            this.xReg = 25;
                        } else {
                            this.xReg = 4;
                        }
                        this.yReg = 0;
                        this.statusByte = OK;
                    }
                    state.a = 0;
                    state.s &= ~flags.C;
                    break;
                }
                case 0x01: // READ BLOCK
                    this.statusByte = this.readBlock(drive, this.readWord(cmdListAddr + 4), buffer);
                    break;
                case 0x02: // WRITE BLOCK
                    this.statusByte = this.writeBlock(drive, this.readWord(cmdListAddr + 4), buffer);
                    break;
                case 0x03: // FORMAT
                    this.statusByte = this.formatDevice(drive);
                    break;
                default:
                    // CONTROL / INIT / OPEN / CLOSE / READ / WRITE: accepted as no-ops.
                    this.statusByte = OK;
            }
            this.cpu.setState(state);
        }

        return this.rom[off];
    }

    write(): void {
        // ROM is not writable.
    }

    getState(): SyncSmartPortState {
        return { excludedFromSnapshot: true };
    }

    setState(): void {
        // The mounted drive is intentionally not part of snapshots.
    }
}
