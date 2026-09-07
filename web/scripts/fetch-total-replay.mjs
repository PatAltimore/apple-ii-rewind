// Downloads the Total Replay hard-drive image into public/disks/ and
// verifies its SHA-256. The image is not committed to this repo (it is
// 32MB and collects hundreds of commercially published games) — run
// `npm run fetch-disk` once after cloning, and the Azure workflow runs the
// same script before every build.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// If you bump `version`/`url`/`sha256` here for a new Total Replay build,
// also bump `DISK_VERSION` in web/src/emulator/DiskCache.ts — otherwise
// returning visitors keep getting served their old cached copy from
// Cache Storage instead of the new one.
export const TOTAL_REPLAY = {
    version: '6.1',
    url: 'https://archive.org/download/TotalReplay/Total%20Replay%20v6.1.hdv',
    sha256: '7434fb5d0fc45279f76ee7d2e5291612e72e315b00989cef9e1fe091301164be',
    bytes: 33553920,
};

const dest = path.resolve(__dirname, '../public/disks/TotalReplay.hdv');

function sha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

if (existsSync(dest)) {
    const existing = readFileSync(dest);
    if (sha256(existing) === TOTAL_REPLAY.sha256) {
        console.log(`Total Replay v${TOTAL_REPLAY.version} already present at ${dest}`);
        process.exit(0);
    }
    console.warn(`${dest} exists but its checksum does not match v${TOTAL_REPLAY.version}; re-downloading.`);
}

console.log(`Downloading Total Replay v${TOTAL_REPLAY.version} (${(TOTAL_REPLAY.bytes / 1048576).toFixed(0)} MB) from archive.org…`);
const response = await fetch(TOTAL_REPLAY.url, { redirect: 'follow' });
if (!response.ok) {
    console.error(`Download failed: ${response.status} ${response.statusText}`);
    process.exit(1);
}
const data = Buffer.from(await response.arrayBuffer());
const digest = sha256(data);
if (digest !== TOTAL_REPLAY.sha256) {
    console.error(`Checksum mismatch.\n  expected ${TOTAL_REPLAY.sha256}\n  got      ${digest}`);
    console.error('archive.org may have published a newer build; update TOTAL_REPLAY in this script after checking it boots.');
    process.exit(1);
}
mkdirSync(path.dirname(dest), { recursive: true });
writeFileSync(dest, data);
console.log(`Saved ${data.length} bytes to ${dest}`);
