/**
 * Persists the disk image in the browser's Cache Storage so a returning
 * visit skips the 32MB download entirely, instead of relying on the HTTP
 * cache. HTTP caching (see staticwebapp.config.json's `Cache-Control` on
 * `/disks/*`) only covers 24 hours and browsers are free to evict it
 * sooner under storage pressure or in private browsing; Cache Storage is
 * origin storage like IndexedDB/localStorage — same eviction risk as
 * those (cleared site data, private windows, an OS-level storage purge),
 * but no time ceiling, so a game played daily never re-downloads it.
 *
 * Keyed by DISK_VERSION rather than trusting the URL alone to stay
 * correct: `fetch-total-replay.mjs` always writes to the same filename
 * (`TotalReplay.hdv`), so bumping its pinned version/checksum changes the
 * *bytes* served at that same URL without changing the URL itself. A
 * small version marker cached alongside the disk bytes catches that —
 * bump DISK_VERSION here whenever that script's `TOTAL_REPLAY.version`
 * changes, and a stale cached copy is treated as a miss (re-fetched and
 * overwritten) instead of served forever.
 */

const CACHE_NAME = 'apple-ii-rewind-disk-cache-v1';

/** Bump alongside `TOTAL_REPLAY.version` in scripts/fetch-total-replay.mjs. */
export const DISK_VERSION = '6.1';

// A plain string key, not a real fetchable path — Cache Storage entries
// don't need to correspond to an actual network resource. Concatenated
// (not a URL fragment) so there's no ambiguity around the Cache API's
// fragment-stripping behavior when matching requests.
function versionMarkerRequest(url: string): Request {
    return new Request(`${url}.version-marker`);
}

/** Returns the cached image, or undefined on a miss (absent, unreadable, or a stale version). */
export async function getCachedDisk(url: string): Promise<ArrayBuffer | undefined> {
    if (!('caches' in window)) {
        return undefined; // unavailable in some private-browsing modes
    }
    try {
        const cache = await caches.open(CACHE_NAME);
        const [dataMatch, versionMatch] = await Promise.all([cache.match(url), cache.match(versionMarkerRequest(url))]);
        if (!dataMatch || !versionMatch) {
            return undefined;
        }
        if ((await versionMatch.text()) !== DISK_VERSION) {
            return undefined; // a different build was published at this same URL
        }
        return await dataMatch.arrayBuffer();
    } catch {
        return undefined;
    }
}

/** Best-effort: failures (quota exceeded, Cache Storage unavailable) just mean it re-downloads next time. */
export async function putCachedDisk(url: string, response: Response): Promise<void> {
    if (!('caches' in window)) {
        return;
    }
    try {
        const cache = await caches.open(CACHE_NAME);
        await Promise.all([cache.put(url, response), cache.put(versionMarkerRequest(url), new Response(DISK_VERSION))]);
    } catch {
        /* best-effort only */
    }
}
