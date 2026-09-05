import { State } from 'js/apple2';

/**
 * Save states live in IndexedDB rather than localStorage. A snapshot is
 * ~170KB of typed arrays; localStorage would need base64 text (+33%) and
 * is capped around 5MB per origin, i.e. a dozen or two saves for a
 * library of hundreds of games. IndexedDB stores the State object as-is
 * (structured clone handles Uint8Array) with a quota in the hundreds of
 * MB or more.
 *
 * One object store, keyed by id, holding both metadata and the snapshot;
 * `listSaves` reads via a cursor and strips the snapshot so listing stays
 * cheap.
 */
const DB_NAME = 'apple-ii-rewind';
const DB_VERSION = 1;
const STORE = 'saves';

export interface SaveMeta {
    id: string;
    name: string;
    savedAt: number;
    /** PNG data URL captured at save time (see thumbnail.ts). */
    thumbnail?: string;
}

interface SaveRecord extends SaveMeta {
    state: State;
}

let dbPromise: Promise<IDBDatabase> | undefined;

function openOnce(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE)) {
                const store = db.createObjectStore(STORE, { keyPath: 'id' });
                store.createIndex('name', 'name', { unique: false });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
        request.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'));
    });
}

function deleteDb(): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(DB_NAME);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error('IndexedDB delete failed'));
        request.onblocked = () => reject(new Error('IndexedDB delete blocked by another tab'));
    });
}

function openDb(): Promise<IDBDatabase> {
    if (!dbPromise) {
        dbPromise = (async () => {
            let db = await openOnce();
            // A database at the current version but without our store can
            // only come from something else (devtools, an older build)
            // having created it; `onupgradeneeded` won't fire again for the
            // same version, so recreate it rather than fail every save.
            if (!db.objectStoreNames.contains(STORE)) {
                db.close();
                await deleteDb();
                db = await openOnce();
            }
            db.onversionchange = () => {
                db.close();
                dbPromise = undefined;
            };
            return db;
        })();
        dbPromise.catch(() => {
            dbPromise = undefined;
        });
    }
    return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
}

/** Most-recently-saved first. */
export async function listSaves(): Promise<SaveMeta[]> {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const records = await requestToPromise(tx.objectStore(STORE).getAll() as IDBRequest<SaveRecord[]>);
    return records
        .map(({ id, name, savedAt, thumbnail }) => ({ id, name, savedAt, thumbnail }))
        .sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * Saves under `name`. A save with the exact same name is overwritten (same
 * id, refreshed timestamp) rather than creating a duplicate.
 */
export async function saveGame(name: string, state: State, thumbnail?: string): Promise<SaveMeta> {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const existing = (await requestToPromise(store.index('name').getAll(name) as IDBRequest<SaveRecord[]>))[0];
    const id = existing?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const meta: SaveMeta = { id, name, savedAt: Date.now(), thumbnail };
    const record: SaveRecord = { ...meta, state };
    try {
        store.put(record);
        await transactionDone(tx);
    } catch (err) {
        throw new Error(`Couldn't save "${name}" — browser storage may be full. (${String(err)})`);
    }
    return meta;
}

export async function loadSave(id: string): Promise<State | null> {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const record = await requestToPromise(tx.objectStore(STORE).get(id) as IDBRequest<SaveRecord | undefined>);
    return record?.state ?? null;
}

export async function deleteSave(id: string): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    await transactionDone(tx);
}
