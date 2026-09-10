/**
 * Works out what kind of Apple II disk image a downloaded file is, and
 * turns whatever archive.org URL a user pastes into one a browser is
 * actually allowed to `fetch()`.
 *
 * Two destinations for an image:
 *  - **block device** (`.hdv`, big `.2mg`/`.po`): mounts in the SmartPort
 *    hard-drive card in slot 7, exactly like Total Replay.
 *  - **5.25" floppy** (`.dsk`, `.do`, `.po` @ 140K, `.d13`, `.nib`,
 *    `.woz`): mounts in the Disk II card in slot 6.
 *
 * The split is by extension first, then by size for the ambiguous ones
 * (`.po` and `.2mg` can wrap either a floppy or a hard drive).
 */
import {
    BLOCK_FORMATS,
    FLOPPY_FORMATS,
    type BlockFormat,
    type FloppyFormat,
} from 'js/formats/types';

export interface SniffedImage {
    kind: 'block' | 'floppy';
    /** apple2js format id handed to the card's `mount()` / `setBinary()`. */
    format: BlockFormat | FloppyFormat;
    /** Short human summary for the status line. */
    description: string;
}

/** A 140K/116K/232K image is a 5.25" floppy; anything bigger that is a
 *  clean multiple of 512 is treated as a hard-drive image. */
const BLOCK_THRESHOLD = 256 * 1024;
const FLOPPY_16_SECTOR = 143_360;
const FLOPPY_13_SECTOR = 116_480;
const FLOPPY_NIB = 232_960;

function magic(bytes: Uint8Array, count = 4): string {
    let out = '';
    for (let i = 0; i < count && i < bytes.length; i++) {
        out += String.fromCharCode(bytes[i]);
    }
    return out;
}

function le32(bytes: Uint8Array, offset: number): number {
    return (
        (bytes[offset] |
            (bytes[offset + 1] << 8) |
            (bytes[offset + 2] << 16) |
            (bytes[offset + 3] << 24)) >>>
        0
    );
}

function sizeDescription(byteLength: number): string {
    const kb = byteLength / 1024;
    return kb >= 1024 ? `${(kb / 1024).toFixed(kb % 1024 ? 1 : 0)} MB` : `${Math.round(kb)} KB`;
}

export function sniffImage(fileName: string, raw: ArrayBuffer): SniffedImage {
    const bytes = new Uint8Array(raw);
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    const head = magic(bytes);

    if (head === 'PK\x03\x04' || ext === 'zip' || ext === 'gz') {
        throw new Error(
            'That is a compressed archive. Link straight to the .dsk / .woz / .hdv file inside it.'
        );
    }

    if (head === 'WOZ1' || head === 'WOZ2' || ext === 'woz') {
        return { kind: 'floppy', format: 'woz', description: 'WOZ 5.25″ disk' };
    }

    if (head === '2IMG' || ext === '2mg') {
        const dataLen = le32(bytes, 0x1c) || raw.byteLength - le32(bytes, 0x18);
        return dataLen > BLOCK_THRESHOLD
            ? { kind: 'block', format: '2mg', description: `${sizeDescription(dataLen)} 2IMG image` }
            : { kind: 'floppy', format: '2mg', description: '140K 2IMG floppy' };
    }

    if (ext === 'hdv') {
        return { kind: 'block', format: 'hdv', description: `${sizeDescription(raw.byteLength)} hard-drive image` };
    }

    if (ext === 'd13') {
        return { kind: 'floppy', format: 'd13', description: '116K 13-sector disk' };
    }
    if (ext === 'nib') {
        return { kind: 'floppy', format: 'nib', description: '5.25″ nibble image' };
    }
    if (ext === 'do' || ext === 'dsk') {
        return { kind: 'floppy', format: ext === 'do' ? 'do' : 'dsk', description: '140K 5.25″ disk' };
    }
    if (ext === 'po') {
        return raw.byteLength > BLOCK_THRESHOLD && raw.byteLength % 512 === 0
            ? { kind: 'block', format: 'po', description: `${sizeDescription(raw.byteLength)} ProDOS image` }
            : { kind: 'floppy', format: 'po', description: '140K ProDOS floppy' };
    }

    // No usable extension — fall back to size.
    if (raw.byteLength === FLOPPY_16_SECTOR) {
        return { kind: 'floppy', format: 'dsk', description: '140K 5.25″ disk' };
    }
    if (raw.byteLength === FLOPPY_13_SECTOR) {
        return { kind: 'floppy', format: 'd13', description: '116K 13-sector disk' };
    }
    if (raw.byteLength === FLOPPY_NIB) {
        return { kind: 'floppy', format: 'nib', description: '5.25″ nibble image' };
    }
    if (raw.byteLength >= FLOPPY_16_SECTOR && raw.byteLength % 512 === 0) {
        return { kind: 'block', format: 'hdv', description: `${sizeDescription(raw.byteLength)} hard-drive image` };
    }

    throw new Error(
        `Couldn't tell what kind of disk "${fileName}" is (${raw.byteLength} bytes). ` +
            'Supported: .hdv .2mg .po .dsk .do .d13 .nib .woz'
    );
}

export function isBlockFormat(format: string): format is BlockFormat {
    return (BLOCK_FORMATS as readonly string[]).includes(format);
}

export function isFloppyFormat(format: string): format is FloppyFormat {
    return (FLOPPY_FORMATS as readonly string[]).includes(format);
}

/**
 * A browser can only read a cross-origin response the server opts into
 * with CORS headers. archive.org's plain `/download/…` URLs don't send
 * them, but its `https://cors.archive.org/cors/<item>/<file>` proxy does
 * (and honours Range requests). Rewrite the URLs people are likely to
 * paste — an item's "download" link, a datanode link, an already-proxied
 * link — to that form; pass anything else through untouched so a user's
 * own CORS-enabled host still works.
 */
export function toFetchableUrl(input: string): string {
    let url: URL;
    try {
        url = new URL(input.trim());
    } catch {
        throw new Error('That doesn’t look like a URL.');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error('Only http(s) URLs can be loaded.');
    }

    const host = url.hostname.toLowerCase();
    const isArchive = host === 'archive.org' || host.endsWith('.archive.org');
    if (!isArchive) {
        return url.toString();
    }

    if (host === 'cors.archive.org') {
        return url.toString();
    }

    // `/details/<item>` is a web page, not a file.
    if (url.pathname.startsWith('/details/')) {
        throw new Error(
            'That is an item page. Open “Show all files”, then copy the direct link to the .dsk / .hdv file.'
        );
    }

    // `/download/<item>/<file>` or a datanode `…/items/<item>/<file>`.
    const download = url.pathname.match(/^\/download\/(.+\/.+)$/);
    const datanode = url.pathname.match(/\/items?\/(.+\/.+)$/);
    const itemPath = download?.[1] ?? datanode?.[1];
    if (itemPath) {
        return `https://cors.archive.org/cors/${itemPath}`;
    }

    return url.toString();
}

/** Filename (no query string) and lowercased extension from a URL. */
export function parseImageUrl(url: string): { name: string; ext: string } {
    let pathname = url;
    try {
        pathname = new URL(url).pathname;
    } catch {
        /* not absolute — treat the whole thing as a path */
    }
    const name = decodeURIComponent(pathname.split('/').pop() || url);
    const ext = name.split('.').pop()?.toLowerCase() || '';
    return { name, ext };
}
