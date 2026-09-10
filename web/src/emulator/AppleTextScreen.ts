/**
 * Just enough of the Apple II text-output firmware (COUT / the $FBxx
 * "video" routines) to let the host print lines onto the 40-column text
 * screen itself, from JavaScript, without going through the emulated CPU.
 *
 * The disk commands in `?boot=basic` mode (src/disk/commands.ts) use this
 * to render `CATALOG` output and short status messages: they run while
 * Applesoft's `GETLN` is still sitting in its read loop on the command
 * line, so there is no clean way to make the ROM print for us — we draw
 * the text directly and move the cursor zero page ($24/$25 and the
 * $28/$29 line base) so `GETLN` and Applesoft carry on from the right
 * place afterwards.
 *
 * Text page 1 only ($0400-$07FF), 40 columns, normal (non-inverse) video.
 * The interleaved row layout and the $20-$23 text-window variables are
 * honoured so this stays correct even if something narrowed the window.
 */
import { CPU6502 } from '@whscullin/cpu6502';
import { byte, word } from 'js/types';

const CH = 0x24; // cursor column within the window
const CV = 0x25; // cursor row (absolute, 0-23)
const BASL = 0x28; // start-of-line address, low
const BASH = 0x29; // start-of-line address, high
const WNDLFT = 0x20;
const WNDWDTH = 0x21;
const WNDTOP = 0x22;
const WNDBTM = 0x23; // one past the last row of the window

const TEXT_PAGE1 = 0x0400;
const BLANK = 0xa0; // space, normal video

/** Base address of text-page-1 row `row` (0-23), the classic interleave. */
function rowBase(row: byte): word {
    return TEXT_PAGE1 + (row & 0x07) * 0x80 + (row >> 3) * 0x28;
}

export class AppleTextScreen {
    constructor(private readonly cpu: CPU6502) {}

    private peek(addr: word): byte {
        return this.cpu.read((addr >> 8) & 0xff, addr & 0xff);
    }

    private poke(addr: word, val: byte): void {
        this.cpu.write((addr >> 8) & 0xff, addr & 0xff, val & 0xff);
    }

    private get left(): byte {
        return this.peek(WNDLFT);
    }
    private get width(): byte {
        return this.peek(WNDWDTH) || 40;
    }
    private get top(): byte {
        return this.peek(WNDTOP);
    }
    private get bottom(): byte {
        return this.peek(WNDBTM) || 24;
    }

    private get col(): byte {
        return this.peek(CH);
    }
    private set col(v: byte) {
        this.poke(CH, v);
    }
    private get row(): byte {
        return this.peek(CV);
    }
    private set row(v: byte) {
        this.poke(CV, v);
        const base = rowBase(v);
        this.poke(BASL, base & 0xff);
        this.poke(BASH, (base >> 8) & 0xff);
    }

    /** Carriage return + line feed, scrolling the window if needed. */
    cr(): void {
        this.col = this.left;
        if (this.row + 1 >= this.bottom) {
            this.scroll();
            this.row = this.bottom - 1;
        } else {
            this.row = this.row + 1;
        }
    }

    /** Scroll the text window up one line; blank the freed bottom line. */
    private scroll(): void {
        const left = this.left;
        const width = this.width;
        for (let r = this.top; r < this.bottom - 1; r++) {
            const dst = rowBase(r) + left;
            const src = rowBase(r + 1) + left;
            for (let c = 0; c < width; c++) {
                this.poke(dst + c, this.peek(src + c));
            }
        }
        const last = rowBase(this.bottom - 1) + left;
        for (let c = 0; c < width; c++) {
            this.poke(last + c, BLANK);
        }
    }

    /** Print one character; `\n`/`\r` act as {@link cr}. */
    putChar(ch: string): void {
        if (ch === '\n' || ch === '\r') {
            this.cr();
            return;
        }
        const code = ch.charCodeAt(0) & 0x7f;
        const base = rowBase(this.row);
        this.poke(base + this.col, code | 0x80);
        this.col = this.col + 1;
        if (this.col >= this.left + this.width) {
            this.cr();
        }
    }

    print(text: string): void {
        for (const ch of text) {
            this.putChar(ch);
        }
    }

    println(text = ''): void {
        this.print(text);
        this.cr();
    }
}
