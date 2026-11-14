import type { ReadonlyTupleOf, TupleOf } from '@month/utils';
import {
    concatBytes,
    encodeBytesField,
    encodeUint32Field,
} from '../utils/proto-utils';

declare global {
    interface Window {
        Uint8Array: typeof Uint8Array;
    }
}

export const MAX_QUEUE_EVENTS = 64;
export const MAX_QUEUE_BYTES = 32 * 1024;
export const MAX_BATCH_EVENTS = 16;
export const MAX_BATCH_BYTES = 12 * 1024;

const BATCH_ACK_FIELD = 1;
const BATCH_EVENTS_FIELD = 2;

export const QUEUE_ENTRY_ID = 0 as const;
export const QUEUE_ENTRY_BYTES = 1 as const;

export type QueueEntry = ReadonlyTupleOf<{
    [QUEUE_ENTRY_ID]: number;
    [QUEUE_ENTRY_BYTES]: Uint8Array;
}>;

export const QUEUE_ENTRIES = 0 as const;
export const QUEUE_TOTAL_BYTES = 1 as const;
export const QUEUE_NEXT_ID = 2 as const;

export type TelemetryQueue = TupleOf<{
    [QUEUE_ENTRIES]: QueueEntry[];
    [QUEUE_TOTAL_BYTES]: number;
    [QUEUE_NEXT_ID]: number;
}>;

export const STORAGE_HYDRATE = 0 as const;
export const STORAGE_PUT = 1 as const;
export const STORAGE_ACK = 2 as const;
export const STORAGE_CLOSE = 3 as const;

export type TelemetryStorage = ReadonlyTupleOf<{
    [STORAGE_HYDRATE]: (
        ctx: Window,
        queue: TelemetryQueue,
        onReady: () => void
    ) => void;
    [STORAGE_PUT]: (
        evictedIds: readonly number[],
        id: number,
        bytes: Uint8Array
    ) => void;
    [STORAGE_ACK]: (
        ctx: Window,
        ackId: number,
        removedIds: readonly number[]
    ) => void;
    [STORAGE_CLOSE]: () => void;
}>;

export const BATCH_ACK_ID = 0 as const;
export const BATCH_FRAME = 1 as const;

export type AssembledBatch = ReadonlyTupleOf<{
    [BATCH_ACK_ID]: number;
    [BATCH_FRAME]: Uint8Array;
}>;

export const createTelemetryQueue = (): TelemetryQueue => [[], 0, 0];

export const queueHasEntries = (queue: TelemetryQueue): boolean =>
    queue[QUEUE_ENTRIES].length > 0;

export const queueEntryCount = (queue: TelemetryQueue): number =>
    queue[QUEUE_ENTRIES].length;

export const queueTotalBytes = (queue: TelemetryQueue): number =>
    queue[QUEUE_TOTAL_BYTES];

export const enqueueEntry = (
    eventBytes: Uint8Array,
    queue: TelemetryQueue,
    storage: TelemetryStorage | null = null
): boolean => {
    const len = eventBytes.length;
    if (len === 0 || len > MAX_BATCH_BYTES - 16) return false;

    const entries = queue[QUEUE_ENTRIES];
    const evictedIds: number[] = [];
    while (
        entries.length > 0 &&
        (entries.length >= MAX_QUEUE_EVENTS ||
            queue[QUEUE_TOTAL_BYTES] + len > MAX_QUEUE_BYTES)
    ) {
        const removed = entries.shift()!;
        queue[QUEUE_TOTAL_BYTES] -= removed[QUEUE_ENTRY_BYTES].length;
        evictedIds.push(removed[QUEUE_ENTRY_ID]);
    }

    const id = ++queue[QUEUE_NEXT_ID];
    entries.push([id, eventBytes]);
    queue[QUEUE_TOTAL_BYTES] += len;
    if (storage) {
        storage[STORAGE_PUT](evictedIds, id, eventBytes);
    }
    return true;
};

export const ackEntries = (
    ctx: Window,
    ackId: number,
    queue: TelemetryQueue,
    storage: TelemetryStorage | null = null
): void => {
    if (ackId <= 0) return;
    const entries = queue[QUEUE_ENTRIES];
    const removedIds: number[] = [];
    while (entries.length > 0 && entries[0][QUEUE_ENTRY_ID] <= ackId) {
        const removed = entries.shift()!;
        queue[QUEUE_TOTAL_BYTES] -= removed[QUEUE_ENTRY_BYTES].length;
        removedIds.push(removed[QUEUE_ENTRY_ID]);
    }
    if (queue[QUEUE_TOTAL_BYTES] < 0) queue[QUEUE_TOTAL_BYTES] = 0;
    if (storage && removedIds.length > 0) {
        storage[STORAGE_ACK](ctx, ackId, removedIds);
    }
};

export const assembleNextBatch = (
    ctx: Window,
    queue: TelemetryQueue
): AssembledBatch | null => {
    const entries = queue[QUEUE_ENTRIES];
    if (entries.length === 0) return null;

    const parts: Uint8Array[] = [];
    let count = 0;
    let ackId = 0;
    let bodyBytes = 0;

    for (const entry of entries) {
        if (count >= MAX_BATCH_EVENTS) break;
        const encoded = encodeBytesField(
            ctx,
            BATCH_EVENTS_FIELD,
            entry[QUEUE_ENTRY_BYTES]
        );
        let fieldLen = 0;
        for (const p of encoded) fieldLen += p.length;
        if (count > 0 && bodyBytes + fieldLen + 6 > MAX_BATCH_BYTES) break;
        for (const p of encoded) parts.push(p);
        bodyBytes += fieldLen;
        ackId = entry[QUEUE_ENTRY_ID];
        count++;
    }

    return count > 0
        ? [
              ackId,
              concatBytes(ctx, [
                  ...encodeUint32Field(ctx, BATCH_ACK_FIELD, ackId),
                  ...parts,
              ]),
          ]
        : null;
};
