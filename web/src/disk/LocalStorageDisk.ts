/**
 * Drive 1 for `?boot=basic` mode: a handful of classic Applesoft programs
 * (Lemonade Stand and friends), kept in the browser's localStorage as
 * tokenized program images and editable in place with SAVE/DELETE.
 *
 * The originals are fetched from archive.org at build time by
 * `scripts/fetch-basic-programs.mjs` and land in
 * `public/disks/programs/` (gitignored, like the Total Replay image).
 * On first run — or whenever the build ships a newer set — this class
 * pulls `manifest.json` and each program file and seeds them into
 * localStorage. After that everything is local: SAVE and DELETE only ever
 * touch localStorage, and the seed files are never rewritten.
 */
import { Disk, FileEntry } from './Disk';

const NS = 'apple-ii-rewind:disk1';
const INDEX_KEY = `${NS}:index`;
const SEED_KEY = `${NS}:seed-version`;
const FILE_PREFIX = `${NS}:file:`;

const MANIFEST_URL = '/disks/programs/manifest.json';
const PROGRAMS_BASE = '/disks/programs/';

const MAX_NAME_LENGTH = 30;

interface ManifestEntry {
    name: string;
    file: string;
    type?: string;
}

interface Manifest {
    version: string;
    programs: ManifestEntry[];
}

interface IndexEntry {
    name: string;
    type: string;
    /** True if this file came from the seed and hasn't been overwritten by
     *  a user SAVE — such entries are pruned when a new manifest drops them. */
    seeded?: boolean;
}

export function normalizeDiskName(raw: string): string {
    return raw.trim().toUpperCase().slice(0, MAX_NAME_LENGTH);
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        out[i] = binary.charCodeAt(i);
    }
    return out;
}

export class LocalStorageDisk implements Disk {
    readonly label = 'DRIVE 1';
    readonly readOnly = false;

    /** Resolves once seeding (if any) has finished. */
    readonly ready: Promise<void>;

    private index: IndexEntry[] = [];

    constructor() {
        this.loadIndex();
        this.ready = this.seed().catch((err) => {
            console.warn('Disk 1: could not seed classic programs —', err);
        });
    }

    private loadIndex(): void {
        try {
            const raw = window.localStorage.getItem(INDEX_KEY);
            const parsed = raw ? (JSON.parse(raw) as unknown) : [];
            if (Array.isArray(parsed)) {
                this.index = parsed
                    .filter((e): e is IndexEntry => !!e && typeof (e as IndexEntry).name === 'string')
                    .map((e) => ({ name: e.name, type: e.type || 'A', seeded: e.seeded === true }));
            }
        } catch {
            this.index = [];
        }
    }

    private saveIndex(): void {
        try {
            window.localStorage.setItem(INDEX_KEY, JSON.stringify(this.index));
        } catch {
            /* storage full / unavailable — the in-memory index still works this session */
        }
    }

    private async seed(): Promise<void> {
        const response = await fetch(MANIFEST_URL);
        if (!response.ok) {
            // No fetched programs (e.g. `npm run dev` without `npm run
            // fetch-programs`). Leave the disk as whatever's already local.
            return;
        }
        const manifest = (await response.json()) as Manifest;

        let seededVersion: string | null = null;
        try {
            seededVersion = window.localStorage.getItem(SEED_KEY);
        } catch {
            /* ignore */
        }
        if (seededVersion === manifest.version) {
            return;
        }

        // A new build's set: drop programs that were only here because a
        // previous seed put them (never a user's SAVE), then (re)seed.
        const manifestNames = new Set(manifest.programs.map((p) => normalizeDiskName(p.name)));
        for (const stale of this.index.filter((e) => e.seeded && !manifestNames.has(e.name))) {
            this.delete(stale.name);
        }

        for (const entry of manifest.programs) {
            try {
                const fileResponse = await fetch(PROGRAMS_BASE + entry.file);
                if (!fileResponse.ok) {
                    continue;
                }
                const bytes = new Uint8Array(await fileResponse.arrayBuffer());
                const name = normalizeDiskName(entry.name);
                this.putFile(name, entry.type || 'A', bytes, true);
            } catch {
                /* skip a program that failed to download */
            }
        }

        try {
            window.localStorage.setItem(SEED_KEY, manifest.version);
        } catch {
            /* ignore */
        }
    }

    private putFile(name: string, type: string, image: Uint8Array, seeded = false): void {
        try {
            window.localStorage.setItem(FILE_PREFIX + name, bytesToBase64(image));
        } catch (err) {
            throw new Error(`could not store "${name}": ${String(err)}`);
        }
        const existing = this.index.find((e) => e.name === name);
        if (existing) {
            existing.type = type;
            // A user SAVE over a seeded file makes it the user's from now on;
            // a reseed of an untouched file leaves it seeded.
            existing.seeded = existing.seeded === true && seeded;
        } else {
            this.index.push({ name, type, seeded });
        }
        this.saveIndex();
    }

    catalog(): FileEntry[] {
        return this.index.map((e) => {
            const image = this.read(e.name);
            return { name: e.name, type: e.type, bytes: image ? image.length : 0 };
        });
    }

    read(name: string): Uint8Array | undefined {
        const key = FILE_PREFIX + normalizeDiskName(name);
        let b64: string | null = null;
        try {
            b64 = window.localStorage.getItem(key);
        } catch {
            return undefined;
        }
        if (b64 === null) {
            return undefined;
        }
        try {
            return base64ToBytes(b64);
        } catch {
            return undefined;
        }
    }

    write(name: string, image: Uint8Array): void {
        this.putFile(normalizeDiskName(name), 'A', image);
    }

    delete(name: string): boolean {
        const normalized = normalizeDiskName(name);
        const at = this.index.findIndex((e) => e.name === normalized);
        if (at === -1) {
            return false;
        }
        this.index.splice(at, 1);
        this.saveIndex();
        try {
            window.localStorage.removeItem(FILE_PREFIX + normalized);
        } catch {
            /* ignore */
        }
        return true;
    }
}
