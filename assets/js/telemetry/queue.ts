import { isFunction, objectStruct, validate } from '@month/utils';
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

export const TELEMETRY_STORAGE_KEY = 'chat-telemetry';
export const MAX_QUEUE_EVENTS = 64;
export const MAX_BATCH_EVENTS = 10;

const BATCH_ACK_FIELD = 1;
const BATCH_EVENTS_FIELD = 2;
const HEAD_INDEX = 0 as const;

export const QUEUE_ENTRY_ID = 0 as const;
export const QUEUE_ENTRY_BYTES = 1 as const;

export type QueueEntry = ReadonlyTupleOf<{
    [QUEUE_ENTRY_ID]: number;
    [QUEUE_ENTRY_BYTES]: Uint8Array;
}>;

export const QUEUE_ENTRIES = 0 as const;
export const QUEUE_NEXT_ID = 1 as const;

export type TelemetryQueue = TupleOf<{
    [QUEUE_ENTRIES]: QueueEntry[];
    [QUEUE_NEXT_ID]: number;
}>;

export const BATCH_ACK_ID = 0 as const;
export const BATCH_FRAME = 1 as const;

export type AssembledBatch = ReadonlyTupleOf<{
    [BATCH_ACK_ID]: number;
    [BATCH_FRAME]: Uint8Array;
}>;

const WIN_LOCAL_STORAGE = 0 as const;
const STORAGE_GET_ITEM = 0 as const;
const STORAGE_SET_ITEM = 1 as const;

const windowLocalStorageStruct = objectStruct([
    'localStorage',
    objectStruct(
        ['getItem', isFunction<Storage['getItem']>],
        ['setItem', isFunction<Storage['setItem']>]
    ),
]);

const bytesToHex = (bytes: Uint8Array): string => {
    let out = '';
    for (const b of bytes) out += b.toString(16).padStart(2, '0');
    return out;
};

const hexToBytes = (ctx: Window, hex: string): Uint8Array => {
    const len = hex.length >> 1;
    const out = new ctx.Uint8Array(len);
    for (let i = 0; i < len; i++) {
        out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
};

export const createTelemetryQueue = (): TelemetryQueue => [[], 0];

export const queueHasEntries = (queue: TelemetryQueue): boolean =>
    queue[QUEUE_ENTRIES].length > 0;

export const queueEntryCount = (queue: TelemetryQueue): number =>
    queue[QUEUE_ENTRIES].length;

export const enqueueBytes = (
    eventBytes: Uint8Array,
    queue: TelemetryQueue
): boolean => {
    if (eventBytes.length === 0) return false;
    const entries = queue[QUEUE_ENTRIES];
    while (entries.length >= MAX_QUEUE_EVENTS) {
        entries.shift();
    }
    entries.push([++queue[QUEUE_NEXT_ID], eventBytes]);
    return true;
};

export const ackQueueEntries = (ackId: number, queue: TelemetryQueue): void => {
    if (ackId <= 0) return;
    const entries = queue[QUEUE_ENTRIES];
    while (entries.length > 0 && entries[HEAD_INDEX][QUEUE_ENTRY_ID] <= ackId) {
        entries.shift();
    }
};

export const assembleNextBatch = (
    ctx: Window,
    queue: TelemetryQueue
): AssembledBatch | null => {
    const slice = queue[QUEUE_ENTRIES].slice(0, MAX_BATCH_EVENTS);
    if (slice.length === 0) return null;
    const ackId = slice[slice.length - 1][QUEUE_ENTRY_ID];
    const parts: Uint8Array[] = encodeUint32Field(ctx, BATCH_ACK_FIELD, ackId);
    for (const entry of slice) {
        for (const p of encodeBytesField(
            ctx,
            BATCH_EVENTS_FIELD,
            entry[QUEUE_ENTRY_BYTES]
        )) {
            parts.push(p);
        }
    }
    return [ackId, concatBytes(ctx, parts)];
};

export const hydrateQueue = (
    ctx: Window,
    storageKey: string,
    queue: TelemetryQueue
): void => {
    if (!storageKey) return;
    try {
        const ls = validate(ctx, windowLocalStorageStruct);
        const raw = ls
            ? ls[WIN_LOCAL_STORAGE][STORAGE_GET_ITEM](storageKey)
            : null;
        if (!raw) return;
        for (const part of raw.split(',').slice(-MAX_QUEUE_EVENTS)) {
            if (part.length >= 2 && (part.length & 1) === 0) {
                enqueueBytes(hexToBytes(ctx, part), queue);
            }
        }
    } catch {
        // ignore restricted storage errors
    }
};

export const persistQueue = (
    ctx: Window,
    storageKey: string,
    queue: TelemetryQueue
): void => {
    if (!storageKey) return;
    try {
        const ls = validate(ctx, windowLocalStorageStruct);
        if (!ls) return;
        const entries = queue[QUEUE_ENTRIES];
        ls[WIN_LOCAL_STORAGE][STORAGE_SET_ITEM](
            storageKey,
            entries.length > 0
                ? entries.map((e) => bytesToHex(e[QUEUE_ENTRY_BYTES])).join(',')
                : ''
        );
    } catch {
        // ignore quota or restricted storage errors
    }
};
