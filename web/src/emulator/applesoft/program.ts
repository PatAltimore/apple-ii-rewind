/**
 * Reading and writing the Applesoft BASIC program that lives in the
 * emulated machine's memory, for the disk commands and clipboard buttons
 * in `?boot=basic` mode (see src/disk/commands.ts).
 *
 * The heavy lifting — the token tables and the tokenize/detokenize passes
 * — is apple2js's own `js/applesoft` code, which already round-trips a
 * program between text and the exact in-memory layout Applesoft expects
 * (linked lines from $0801, zero-page pointers at $67/$69/$6B/$6D/$AF).
 * This module is a thin adapter: it presents the running CPU's address
 * space as the `Memory` interface those classes take, and adds the two
 * raw-image helpers DOS-style LOAD/SAVE need (byte-for-byte program image
 * in and out, no text round-trip, so a freshly fetched original loads
 * exactly as it was on its disk).
 */
import { CPU6502 } from '@whscullin/cpu6502';
import { Memory, byte, word } from 'js/types';
import ApplesoftCompiler from 'js/applesoft/compiler';
import ApplesoftDecompiler from 'js/applesoft/decompiler';
import { TXTTAB, VARTAB, ARYTAB, STREND, PRGEND } from 'js/applesoft/zeropage';

/** Standard Applesoft program start. */
export const PROGRAM_START = 0x801;

/**
 * Applesoft's immediate-mode prompt character, stored at $0033 (PROMPT).
 * It is `]` (0xDD, i.e. `']' | 0x80`) at the `]` prompt and `?` while an
 * INPUT statement is reading — the disk command handler only acts when
 * the machine is sitting at `]`, so a program that happens to read a line
 * starting with `CATALOG` isn't hijacked.
 */
export const PROMPT = 0x33;
export const IMMEDIATE_MODE_PROMPT = 0xdd;

/** Presents the running CPU's memory as the `Memory` interface apple2js's
 *  applesoft helpers expect. Reads/writes go through the MMU, which at the
 *  `]` prompt means main RAM for $0800+ — exactly where the program is. */
export function cpuMemory(cpu: CPU6502): Memory {
    return {
        read: (page: byte, offset: byte): byte => cpu.read(page, offset),
        write: (page: byte, offset: byte, value: byte): void => cpu.write(page, offset, value),
    };
}

function readByte(mem: Memory, addr: word): byte {
    return mem.read((addr >> 8) & 0xff, addr & 0xff);
}

function writeByte(mem: Memory, addr: word, val: byte): void {
    mem.write((addr >> 8) & 0xff, addr & 0xff, val & 0xff);
}

function readWord(mem: Memory, addr: word): word {
    return readByte(mem, addr) | (readByte(mem, addr + 1) << 8);
}

function writeWord(mem: Memory, addr: word, val: word): void {
    writeByte(mem, addr, val & 0xff);
    writeByte(mem, addr + 1, (val >> 8) & 0xff);
}

export function isImmediateMode(cpu: CPU6502): boolean {
    return readByte(cpuMemory(cpu), PROMPT) === IMMEDIATE_MODE_PROMPT;
}

/**
 * The program exactly as it sits in memory, from TXTTAB ($0801) through
 * PRGEND — including the two zero bytes that terminate the linked list.
 * This is the payload a DOS 3.3 `A` (Applesoft) file stores after its
 * 2-byte length header, so it is what `SAVE` persists and what `LOAD`
 * writes straight back.
 */
export function readProgramImage(cpu: CPU6502): Uint8Array {
    const mem = cpuMemory(cpu);
    const start = readWord(mem, TXTTAB);
    const end = readWord(mem, PRGEND);
    const length = Math.max(0, end - start);
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
        out[i] = readByte(mem, start + i);
    }
    return out;
}

/**
 * Writes a raw program image to $0801 and sets the zero-page pointers the
 * way DOS 3.3's LOAD does: VARTAB/ARYTAB/STREND/PRGEND all at the end of
 * the image. The image already carries correct absolute line links (they
 * are relative to $0801, which never moves), so no relink pass is needed.
 */
export function writeProgramImage(cpu: CPU6502, image: Uint8Array): void {
    const mem = cpuMemory(cpu);
    for (let i = 0; i < image.length; i++) {
        writeByte(mem, PROGRAM_START + i, image[i]);
    }
    const end = PROGRAM_START + image.length;
    writeWord(mem, TXTTAB, PROGRAM_START);
    writeWord(mem, PRGEND, end);
    writeWord(mem, VARTAB, end);
    writeWord(mem, ARYTAB, end);
    writeWord(mem, STREND, end);
}

/**
 * The current program as a plain-text listing, one line per BASIC line,
 * `PRINT` kept as `PRINT` (not `?`) and evenly spaced — the form the
 * Copy-program button puts on the clipboard, and which
 * {@link compileTextToProgram} accepts back.
 */
export function readProgramText(cpu: CPU6502): string {
    const decompiler = ApplesoftDecompiler.decompilerFromMemory(cpuMemory(cpu));
    return decompiler.decompile({ style: 'pretty' });
}

/**
 * Tokenizes a text listing straight into memory, setting all the
 * zero-page pointers (apple2js's compiler does this). Throws if the text
 * isn't a well-formed listing — callers validate first with
 * {@link validateListing} to turn that into a friendly message.
 */
export function compileTextToProgram(cpu: CPU6502, text: string): void {
    ApplesoftCompiler.compileToMemory(cpuMemory(cpu), text, PROGRAM_START);
}

export interface ListingValidation {
    ok: boolean;
    /** Set when `ok` is false — a short, screen-printable reason. */
    error?: string;
}

const MAX_LISTING_LINES = 12_000;
const MAX_LINE_NUMBER = 63_999;

/**
 * A cheap structural check that clipboard text looks like an Applesoft
 * listing before we tokenize it: every non-blank line must start with a
 * line number in range, there must be at least one line, and the whole
 * thing must actually tokenize. This is deliberately lenient about the
 * code itself (Applesoft has no reserved-word collisions to speak of) —
 * it is here to reject "I copied a paragraph of prose", not to lint BASIC.
 */
export function validateListing(text: string): ListingValidation {
    const rawLines = text.replace(/\r\n?/g, '\n').split('\n');
    const codeLines = rawLines.map((l) => l.trim()).filter((l) => l.length > 0);

    if (codeLines.length === 0) {
        return { ok: false, error: 'CLIPBOARD IS EMPTY' };
    }
    if (codeLines.length > MAX_LISTING_LINES) {
        return { ok: false, error: 'PROGRAM TOO LONG' };
    }

    for (const line of codeLines) {
        const match = /^(\d{1,5})(?:\s|$)/.exec(line);
        if (!match) {
            return { ok: false, error: 'NOT AN APPLESOFT LISTING' };
        }
        if (Number(match[1]) > MAX_LINE_NUMBER) {
            return { ok: false, error: 'LINE NUMBER TOO LARGE' };
        }
    }

    try {
        const compiler = new ApplesoftCompiler();
        compiler.compile(codeLines.join('\n'));
        compiler.program(PROGRAM_START);
    } catch {
        return { ok: false, error: 'COULD NOT TOKENIZE PROGRAM' };
    }

    return { ok: true };
}
