/**
 * A minimal "disk" abstraction for the Applesoft (`?boot=basic`) mode's
 * CATALOG / LOAD / SAVE commands (src/disk/commands.ts).
 *
 * Only drive 1 exists today — {@link LocalStorageDisk}, a set of Applesoft
 * program images kept in localStorage and seeded from the programs the
 * build fetches from archive.org. The interface is deliberately drive-
 * shaped (the command parser already accepts a `,Dn` suffix) so a future
 * drive 2 that mounts a real disk image from the Internet Archive can be
 * added behind the same commands without touching them.
 */
export interface FileEntry {
    /** Catalog name, upper-case, no trailing spaces. */
    name: string;
    /** DOS file-type letter; always `A` (Applesoft) for drive 1. */
    type: string;
    /** Size of the stored program image in bytes. */
    bytes: number;
}

export interface Disk {
    /** Human label for messages ("DRIVE 1"). */
    readonly label: string;
    /** True if SAVE/DELETE are rejected. */
    readonly readOnly: boolean;
    /** Directory listing, in insertion order. */
    catalog(): FileEntry[];
    /** The stored program image, or `undefined` if there is no such file. */
    read(name: string): Uint8Array | undefined;
    /** Create or replace a file. Throws if {@link readOnly}. */
    write(name: string, image: Uint8Array): void;
    /** Remove a file. Returns false if it did not exist. Throws if {@link readOnly}. */
    delete(name: string): boolean;
}
