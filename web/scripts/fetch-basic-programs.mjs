// Downloads a few real DOS 3.3 disks from archive.org and extracts their
// Applesoft programs (Lemonade Stand and other classics that shipped with
// the Apple II) into public/disks/programs/ as raw tokenized program
// images, plus a manifest.json. Those files are gitignored — run
// `npm run fetch-programs` once after cloning, and the Azure workflow runs
// it before every build. `?boot=basic` mode seeds them into localStorage
// on first load (see web/src/disk/LocalStorageDisk.ts).
//
// The images are copyrighted software published by Apple; like the Total
// Replay image they are fetched, not committed. Nothing here is
// redistributed from this repo.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../public/disks/programs');

/**
 * Each source is a standard 143,360-byte DOS 3.3 5.25" image (DOS sector
 * order). `sha256` pins the download; set it to null on a new source and
 * this script prints the hash it computed so you can paste it back in.
 * `pick` is an allow-list of catalog names, or '*' for every Applesoft
 * file; `exclude` drops names from '*'.
 */
const SOURCES = [
    {
        id: 'lemonade-stand-1979',
        label: 'Lemonade Stand (1979) (Apple)',
        url: 'https://archive.org/download/Lemonade_Stand_1979_Apple/Lemonade_Stand_1979_Apple.do',
        sha256: '8bbecd5defb22e716a7d0bca366ca89ee5b19f42d006470064ac473131cf5e35',
        pick: ['LEMONADE'],
    },
    {
        id: 'dos33-system-master-1980',
        label: 'Apple DOS 3.3 System Master (1980)',
        url: 'https://archive.org/download/DOS_3.3_System_Master_16_Sector_Version_Apple_1980/DOS_3.3_System_Master_16_Sector_Version_Apple_1980.dsk',
        sha256: 'b2ac0af26ae0e6d17774bd50bbf633ac2b664c2ed1c03cdcd9783ca57ac6f5da',
        pick: ["BRIAN'S THEME", 'COLOR DEMOSOFT', 'LITTLE BRICK OUT', 'RANDOM'],
    },
    {
        id: 'applesoft-sampler',
        label: 'Applesoft Sampler',
        url: 'https://archive.org/download/Applesoft_Sampler/Applesoft_Sampler.dsk',
        sha256: '2ab66161b7504015b47050ccc1e5500a864b8428d8499683af78ca3b9aa64dd5',
        pick: [
            'HUE',
            'QUILT',
            'MOIRE',
            'HORSES',
            'ALPHABET',
            'SCRAMBLER',
            'COLORLOOP',
            'COLORBOUNCE',
            'COLORBOUNCESOUND',
        ],
    },
];

const IMAGE_BYTES = 143_360;
const SECTOR = 256;
const SECTORS_PER_TRACK = 16;
const VTOC_TRACK = 17;
const MAX_PROGRAMS = 30;

const FILE_TYPE_APPLESOFT = 0x02;

function sha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

function sectorOffset(track, sector) {
    return (track * SECTORS_PER_TRACK + sector) * SECTOR;
}

/** High-bit ASCII, space-padded → plain string. */
function decodeName(bytes) {
    let s = '';
    for (const b of bytes) {
        s += String.fromCharCode(b & 0x7f);
    }
    return s.replace(/\s+$/, '').toUpperCase();
}

function readCatalog(image) {
    const vtoc = sectorOffset(VTOC_TRACK, 0);
    let track = image[vtoc + 0x01];
    let sector = image[vtoc + 0x02];
    if (track < 1 || track > 34 || sector > 15) {
        throw new Error(`VTOC points at an implausible catalog (T${track} S${sector}) — not a DOS 3.3 image?`);
    }

    const entries = [];
    const seen = new Set();
    while (track !== 0) {
        const key = `${track},${sector}`;
        if (seen.has(key) || track > 34 || sector > 15) {
            break;
        }
        seen.add(key);
        const base = sectorOffset(track, sector);
        for (let e = 0x0b; e + 0x23 <= SECTOR; e += 0x23) {
            const first = image[base + e];
            if (first === 0x00) {
                continue; // never used
            }
            if (first === 0xff) {
                continue; // deleted
            }
            const typeByte = image[base + e + 0x02];
            const name = decodeName(image.subarray(base + e + 0x03, base + e + 0x03 + 30));
            entries.push({
                tsListTrack: first,
                tsListSector: image[base + e + 0x01],
                type: typeByte & 0x7f,
                locked: (typeByte & 0x80) !== 0,
                name,
            });
        }
        track = image[base + 0x01];
        sector = image[base + 0x02];
    }
    return entries;
}

/** Follows an entry's track/sector list and concatenates its data sectors. */
function readFileData(image, entry) {
    let track = entry.tsListTrack;
    let sector = entry.tsListSector;
    const chunks = [];
    const seen = new Set();
    while (track !== 0) {
        const key = `${track},${sector}`;
        if (seen.has(key) || track > 34 || sector > 15) {
            break;
        }
        seen.add(key);
        const base = sectorOffset(track, sector);
        for (let p = 0x0c; p + 1 < SECTOR; p += 2) {
            const dt = image[base + p];
            const ds = image[base + p + 1];
            if (dt === 0 && ds === 0) {
                continue; // sparse / unused slot
            }
            chunks.push(image.subarray(sectorOffset(dt, ds), sectorOffset(dt, ds) + SECTOR));
        }
        track = image[base + 0x01];
        sector = image[base + 0x02];
    }
    return Buffer.concat(chunks);
}

/**
 * A DOS 3.3 Applesoft file is a 2-byte little-endian length followed by
 * the tokenized program exactly as it sits from $0801 (link pointers and
 * all). Return just that program image.
 */
function applesoftImage(fileData) {
    if (fileData.length < 2) {
        return null;
    }
    const length = fileData[0] | (fileData[1] << 8);
    if (length < 2 || length > 0xa000) {
        return null;
    }
    return fileData.subarray(2, 2 + length);
}

function sanitizeFileName(name) {
    return name.replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'PROGRAM';
}

async function download(url) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
}

async function main() {
    mkdirSync(OUT_DIR, { recursive: true });
    for (const existing of readdirSync(OUT_DIR)) {
        rmSync(path.join(OUT_DIR, existing));
    }

    const programs = [];
    const usedFileNames = new Set();
    const versionParts = [];

    for (const source of SOURCES) {
        console.log(`\n${source.label}`);
        let image;
        try {
            image = await download(source.url);
        } catch (err) {
            console.warn(`  download failed (${err.message}) — skipping this source`);
            continue;
        }
        const digest = sha256(image);
        if (source.sha256 && digest !== source.sha256) {
            console.error(`  checksum mismatch\n    expected ${source.sha256}\n    got      ${digest}`);
            process.exit(1);
        }
        if (!source.sha256) {
            console.warn(`  no sha256 pinned; computed ${digest} — paste this into SOURCES`);
        }
        if (image.length !== IMAGE_BYTES) {
            console.warn(`  unexpected size ${image.length} (want ${IMAGE_BYTES}) — skipping this source`);
            continue;
        }
        versionParts.push(`${source.id}:${digest.slice(0, 12)}`);

        let catalog;
        try {
            catalog = readCatalog(image);
        } catch (err) {
            console.warn(`  ${err.message} — skipping this source`);
            continue;
        }

        for (const entry of catalog) {
            if (entry.type !== FILE_TYPE_APPLESOFT) {
                continue;
            }
            if (source.pick !== '*' && !source.pick.includes(entry.name)) {
                continue;
            }
            if (source.exclude?.includes(entry.name)) {
                continue;
            }
            if (programs.some((p) => p.name === entry.name)) {
                continue; // first source wins on a name clash
            }
            const image2 = applesoftImage(readFileData(image, entry));
            if (!image2 || image2.length < 4) {
                console.warn(`  ${entry.name}: not a readable Applesoft file — skipped`);
                continue;
            }

            let fileName = sanitizeFileName(entry.name) + '.bin';
            let n = 2;
            while (usedFileNames.has(fileName)) {
                fileName = `${sanitizeFileName(entry.name)}_${n++}.bin`;
            }
            usedFileNames.add(fileName);

            writeFileSync(path.join(OUT_DIR, fileName), image2);
            programs.push({
                name: entry.name,
                file: fileName,
                type: 'A',
                bytes: image2.length,
                source: source.id,
            });
            console.log(`  + ${entry.name}  (${image2.length} bytes → ${fileName})`);
            if (programs.length >= MAX_PROGRAMS) {
                break;
            }
        }
        if (programs.length >= MAX_PROGRAMS) {
            break;
        }
    }

    if (programs.length === 0) {
        console.error('\nNo Applesoft programs were extracted. Check the source URLs / formats.');
        process.exit(1);
    }

    programs.sort((a, b) => a.name.localeCompare(b.name));
    const manifest = {
        version: sha256(Buffer.from(versionParts.join('|') + '|' + programs.map((p) => p.name).join(','))).slice(0, 16),
        generated: new Date().toISOString(),
        programs,
    };
    writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(`\nWrote ${programs.length} programs + manifest.json (version ${manifest.version}) to ${path.relative(process.cwd(), OUT_DIR)}`);
}

// Skip the network in CI-less local dev if the manifest is already there
// and non-empty, matching fetch-total-replay.mjs's "already present" fast
// path. Pass --force to always re-fetch.
const manifestPath = path.join(OUT_DIR, 'manifest.json');
if (!process.argv.includes('--force') && existsSync(manifestPath)) {
    try {
        const current = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (Array.isArray(current.programs) && current.programs.length > 0) {
            console.log(`BASIC programs already present (${current.programs.length}); pass --force to re-fetch.`);
            process.exit(0);
        }
    } catch {
        /* fall through and refetch */
    }
}

await main();
