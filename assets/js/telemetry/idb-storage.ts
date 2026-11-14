// Opt-in IndexedDB persistence adapter (`createIdbTelemetryStorage()`).
// Decoupled from the core in-memory queue so bundles that omit `storage`
// include zero IndexedDB code after Closure Compiler ADVANCED optimization.

import {
    cont,
    isFunction,
    noop,
    objectStruct,
    pipe,
    taskCatch,
    taskChain,
    taskFork,
    validate,
} from '@month/utils';
import type { Task, TupleOf } from '@month/utils';
import {
    MAX_QUEUE_BYTES,
    MAX_QUEUE_EVENTS,
    QUEUE_ENTRIES,
    QUEUE_ENTRY_BYTES,
    QUEUE_ENTRY_ID,
    QUEUE_NEXT_ID,
    QUEUE_TOTAL_BYTES,
} from './queue';
import type { QueueEntry, TelemetryQueue, TelemetryStorage } from './queue';

declare global {
    interface Window {
        indexedDB: IDBFactory;
        IDBKeyRange: typeof IDBKeyRange;
        ArrayBuffer: typeof ArrayBuffer;
        Uint8Array: typeof Uint8Array;
    }
}

export const IDB_NAME = 't';
export const IDB_STORE = 'q';
const IDB_VERSION = 1;

const HANDLE_DB = 0 as const;
const HANDLE_PENDING = 1 as const;
type PendingOp = () => void;
type IdbHandle = TupleOf<{
    [HANDLE_DB]: IDBDatabase | null;
    [HANDLE_PENDING]: PendingOp[] | null;
}>;

const WIN_INDEXED_DB = 0 as const;
const IDB_OPEN = 0 as const;
const WIN_KEY_RANGE = 0 as const;
const KEY_RANGE_UPPER_BOUND = 0 as const;

const windowIdbStruct = objectStruct([
    'indexedDB',
    objectStruct(['open', isFunction<IDBFactory['open']>]),
]);

const windowKeyRangeStruct = objectStruct([
    'IDBKeyRange',
    objectStruct(['upperBound', isFunction<typeof IDBKeyRange.upperBound>]),
]);

const returnNull = (): null => null;
const returnEmptyEntries = (): QueueEntry[] => [];

const toUint8Array = (ctx: Window, raw: unknown): Uint8Array | null => {
    if (raw instanceof ctx.Uint8Array) return raw;
    if (ctx.ArrayBuffer) {
        if (ctx.ArrayBuffer.isView(raw)) {
            return new ctx.Uint8Array(
                raw.buffer,
                raw.byteOffset,
                raw.byteLength
            );
        }
        if (raw instanceof ctx.ArrayBuffer) return new ctx.Uint8Array(raw);
    }
    return null;
};

const openIdbRawTask =
    (ctx: Window): Task<IDBDatabase | null> =>
    (resolve, reject) => {
        const idb = validate(ctx, windowIdbStruct);
        if (!idb) {
            resolve(null);
            return;
        }
        const req = idb[WIN_INDEXED_DB][IDB_OPEN](IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => resolve(null);
    };

const readAllEntriesRawTask =
    (ctx: Window, db: IDBDatabase): Task<QueueEntry[]> =>
    (resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const entries: QueueEntry[] = [];
        const req = store.openCursor();
        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) {
                resolve(entries);
                return;
            }
            const id =
                typeof cursor.key === 'number' && cursor.key > 0
                    ? Math.floor(cursor.key)
                    : 0;
            const bytes = toUint8Array(ctx, cursor.value);
            if (id > 0 && bytes && bytes.length > 0) {
                entries.push([id, bytes]);
            }
            cursor.continue();
        };
        req.onerror = () => reject(req.error);
    };

const mergeLoadedWithLive = (
    loaded: readonly QueueEntry[],
    live: readonly QueueEntry[]
): readonly [
    kept: QueueEntry[],
    evictedIds: number[],
    totalBytes: number,
    maxId: number,
] => {
    let maxLoadedId = 0;
    for (const e of loaded) {
        if (e[QUEUE_ENTRY_ID] > maxLoadedId) maxLoadedId = e[QUEUE_ENTRY_ID];
    }
    const renumberedLive: QueueEntry[] = live.map((e, idx) => [
        maxLoadedId + idx + 1,
        e[QUEUE_ENTRY_BYTES],
    ]);
    const combined = [...loaded, ...renumberedLive];
    const maxId =
        combined.length > 0 ? combined[combined.length - 1][QUEUE_ENTRY_ID] : 0;

    const keptReversed: QueueEntry[] = [];
    const evictedIds: number[] = [];
    let totalBytes = 0;
    for (let i = combined.length - 1; i >= 0; i--) {
        const entry = combined[i];
        const len = entry[QUEUE_ENTRY_BYTES].length;
        if (
            keptReversed.length < MAX_QUEUE_EVENTS &&
            totalBytes + len <= MAX_QUEUE_BYTES
        ) {
            keptReversed.push(entry);
            totalBytes += len;
        } else {
            evictedIds.push(entry[QUEUE_ENTRY_ID]);
        }
    }
    keptReversed.reverse();
    return [keptReversed, evictedIds, totalBytes, maxId];
};

export const createIdbTelemetryStorage = (): TelemetryStorage => {
    const handle: IdbHandle = [null, []];

    const runOrBuffer = (fn: (db: IDBDatabase) => void): void => {
        const db = handle[HANDLE_DB];
        if (db) {
            try {
                fn(db);
            } catch {
                // ignore storage write failures
            }
            return;
        }
        const pending = handle[HANDLE_PENDING];
        if (pending) {
            pending.push(() => {
                const readyDb = handle[HANDLE_DB];
                if (readyDb) {
                    try {
                        fn(readyDb);
                    } catch {
                        // ignore
                    }
                }
            });
        }
    };

    const hydrate = (
        ctx: Window,
        queue: TelemetryQueue,
        onReady: () => void
    ): void => {
        pipe(
            openIdbRawTask(ctx),
            taskCatch(returnNull),
            taskChain((db: IDBDatabase | null): Task<QueueEntry[]> => {
                handle[HANDLE_DB] = db;
                if (!db) return cont([]);
                return pipe(
                    readAllEntriesRawTask(ctx, db),
                    taskCatch(returnEmptyEntries)
                );
            }),
            taskFork((loaded: QueueEntry[]) => {
                const db = handle[HANDLE_DB];
                if (db) {
                    const liveBeforeHydrate = queue[QUEUE_ENTRIES].slice();
                    const [kept, evictedIds, totalBytes, maxId] =
                        mergeLoadedWithLive(loaded, liveBeforeHydrate);
                    queue[QUEUE_ENTRIES] = kept;
                    queue[QUEUE_TOTAL_BYTES] = totalBytes;
                    if (maxId > queue[QUEUE_NEXT_ID]) {
                        queue[QUEUE_NEXT_ID] = maxId;
                    }
                    // Sync any pre-hydration live entries & evictions in one tx
                    if (liveBeforeHydrate.length > 0 || evictedIds.length > 0) {
                        try {
                            const tx = db.transaction(IDB_STORE, 'readwrite');
                            const store = tx.objectStore(IDB_STORE);
                            for (const id of evictedIds) store.delete(id);
                            for (const entry of kept) {
                                store.put(
                                    entry[QUEUE_ENTRY_BYTES],
                                    entry[QUEUE_ENTRY_ID]
                                );
                            }
                        } catch {
                            // ignore
                        }
                    }
                }
                // Clear pre-hydrate op buffer (already reconciled above) and mark live
                handle[HANDLE_PENDING] = null;
                onReady();
            }, noop)
        );
    };

    const put = (
        evictedIds: readonly number[],
        id: number,
        bytes: Uint8Array
    ): void => {
        if (handle[HANDLE_PENDING] !== null) {
            // Pre-hydration entries are reconciled in `hydrate` once loaded keys are known
            return;
        }
        runOrBuffer((db) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            for (const evId of evictedIds) {
                store.delete(evId);
            }
            store.put(bytes, id);
        });
    };

    const ack = (
        ctx: Window,
        ackId: number,
        removedIds: readonly number[]
    ): void => {
        runOrBuffer((db) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            const kr = validate(ctx, windowKeyRangeStruct);
            if (kr) {
                store.delete(kr[WIN_KEY_RANGE][KEY_RANGE_UPPER_BOUND](ackId));
            } else {
                for (const id of removedIds) {
                    store.delete(id);
                }
            }
        });
    };

    const close = (): void => {
        handle[HANDLE_PENDING] = null;
        const db = handle[HANDLE_DB];
        if (db) {
            try {
                db.close();
            } catch {
                // ignore
            }
            handle[HANDLE_DB] = null;
        }
    };

    return [hydrate, put, ack, close];
};
