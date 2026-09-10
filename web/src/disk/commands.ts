/**
 * The CATALOG / LOAD / SAVE / DELETE commands for `?boot=basic` mode.
 *
 * There is no DOS in that mode — it is a bare Applesoft cold boot (see
 * docs/DECISIONS.md 2026-09-08) — so these are implemented on the host
 * side. `keyboard.ts` keeps a shadow copy of the line being typed at the
 * `]` prompt and hands it here the instant Return is pressed, before the
 * keystroke reaches the emulator. If the line is one of our commands we:
 *
 *   1. do the work (list the disk, move a program in or out of memory);
 *   2. draw any output straight onto the text screen (AppleTextScreen),
 *      since Applesoft's GETLN is still mid-line and can't print for us;
 *   3. blank the emulator's input buffer ($0200) so when the Return does
 *      land, GETLN returns an empty line and Applesoft simply reprints
 *      `]` — no `?SYNTAX ERROR`.
 *
 * Anything we don't recognise is left completely alone and runs as normal
 * Applesoft.
 */
import { CPU6502 } from '@whscullin/cpu6502';
import { AppleTextScreen } from '../emulator/AppleTextScreen';
import { isImmediateMode, readProgramImage, writeProgramImage } from '../emulator/applesoft/program';
import { Disk } from './Disk';

/** Applesoft / monitor line-input buffer. */
const INPUT_BUFFER = 0x0200;

export interface DiskCommandContext {
    cpu: CPU6502;
    screen: AppleTextScreen;
    /** Index 0 is drive 1; more may be added later. */
    disks: Disk[];
}

interface ParsedCommand {
    verb: 'CATALOG' | 'LOAD' | 'SAVE' | 'DELETE';
    name: string;
    drive: number;
}

/**
 * Parses `LOAD LEMONADE`, `SAVE MY PROGRAM,D1`, `CATALOG`, `CATALOG,D2`,
 * etc. Names may contain spaces; an optional trailing `,Dn` (and any
 * `,Sn`/`,Vn`/`,A$…` we just ignore) picks the drive, DOS-style. Returns
 * `undefined` if the line isn't one of our commands (`\b` after the verb
 * so `LOADED = 1` is left for Applesoft).
 */
function parse(line: string): ParsedCommand | undefined {
    const match = /^\s*(CATALOG|LOAD|SAVE|DELETE)\b\s*(.*)$/i.exec(line);
    if (!match) {
        return undefined;
    }
    const verb = match[1].toUpperCase() as ParsedCommand['verb'];

    let rest = match[2].trim();
    let drive = 1;
    const driveMatch = /,\s*D\s*(\d+)\s*$/i.exec(rest);
    if (driveMatch) {
        drive = Number(driveMatch[1]);
        rest = rest.slice(0, driveMatch.index).trim();
    }
    // Drop any other DOS-style parameters (,S6 ,V0 ,A$800 …); unsupported here.
    rest = rest.replace(/,\s*[A-Z]\$?[0-9A-F]*\s*$/i, '').trim();

    return { verb, name: rest.toUpperCase(), drive };
}

export type LineSubmitHandler = (line: string) => void;

export function createDiskCommandHandler(ctx: DiskCommandContext): LineSubmitHandler {
    const { cpu, screen, disks } = ctx;

    const neutralizeInputLine = (): void => {
        // GETLN's line lives at $0200; a leading zero makes Applesoft read
        // it as an empty line when our swallowed Return finally lands.
        cpu.write(INPUT_BUFFER >> 8, INPUT_BUFFER & 0xff, 0x00);
    };

    const fail = (message: string): void => {
        screen.cr();
        screen.println(message);
        neutralizeInputLine();
    };

    return (line: string): void => {
        const command = parse(line);
        if (!command) {
            return;
        }
        // Only act at the `]` prompt — not while an INPUT statement in a
        // running program happens to read a line that looks like a command.
        if (!isImmediateMode(cpu)) {
            return;
        }

        const disk = disks[command.drive - 1];
        if (!disk) {
            fail(`DRIVE ${command.drive} NOT CONNECTED`);
            return;
        }

        if (command.verb === 'CATALOG') {
            const entries = disk.catalog();
            screen.cr();
            screen.println(disk.label);
            screen.cr();
            if (entries.length === 0) {
                screen.println(' (EMPTY)');
            } else {
                for (const entry of entries) {
                    const sectors = Math.min(999, Math.ceil(entry.bytes / 256) + 1);
                    const sec = String(sectors).padStart(3, '0');
                    screen.println(` ${entry.type} ${sec} ${entry.name}`);
                }
            }
            neutralizeInputLine();
            return;
        }

        if (command.name === '') {
            fail(`${command.verb} WHAT?`);
            return;
        }

        if (command.verb === 'LOAD') {
            const image = disk.read(command.name);
            if (!image) {
                fail('FILE NOT FOUND');
                return;
            }
            writeProgramImage(cpu, image);
            neutralizeInputLine();
            return;
        }

        if (command.verb === 'SAVE') {
            if (disk.readOnly) {
                fail(`${disk.label} IS WRITE PROTECTED`);
                return;
            }
            try {
                disk.write(command.name, readProgramImage(cpu));
            } catch {
                fail('DISK FULL');
                return;
            }
            neutralizeInputLine();
            return;
        }

        // DELETE
        if (disk.readOnly) {
            fail(`${disk.label} IS WRITE PROTECTED`);
            return;
        }
        if (!disk.delete(command.name)) {
            fail('FILE NOT FOUND');
            return;
        }
        neutralizeInputLine();
    };
}
