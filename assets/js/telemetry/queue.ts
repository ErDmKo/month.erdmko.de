import type { ReadonlyTupleOf } from '@month/utils';
import { concatBytes, encodeBytesField } from '../utils/proto-utils';

export const TELEMETRY_STORAGE_KEY = 'chat-telemetry';
export const MAX_QUEUE_EVENTS = 64;
export const MAX_BATCH_EVENTS = 10;

const BATCH_EVENTS_FIELD = 1;

export type TelemetryQueue = Uint8Array[];

export const BATCH_LAST = 0 as const;
export const BATCH_BODY = 1 as const;

export type AssembledBatch = ReadonlyTupleOf<{
    [BATCH_LAST]: Uint8Array;
    [BATCH_BODY]: Uint8Array;
}>;

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

export const createTelemetryQueue = (): TelemetryQueue => [];

export const queueHasEntries = (queue: TelemetryQueue): boolean =>
    queue.length > 0;

export const enqueueBytes = (
    eventBytes: Uint8Array,
    queue: TelemetryQueue
): boolean => {
    if (eventBytes.length === 0) return false;
    while (queue.length >= MAX_QUEUE_EVENTS) {
        queue.shift();
    }
    queue.push(eventBytes);
    return true;
};

export const dropThroughItem = (
    lastItem: Uint8Array,
    queue: TelemetryQueue
): void => {
    const idx = queue.indexOf(lastItem);
    if (idx >= 0) {
        queue.splice(0, idx + 1);
    }
};

export const assembleNextBatch = (
    ctx: Window,
    queue: TelemetryQueue
): AssembledBatch | null => {
    const slice = queue.slice(0, MAX_BATCH_EVENTS);
    if (slice.length === 0) return null;
    const parts: Uint8Array[] = [];
    for (const item of slice) {
        for (const p of encodeBytesField(ctx, BATCH_EVENTS_FIELD, item)) {
            parts.push(p);
        }
    }
    return [slice[slice.length - 1], concatBytes(ctx, parts)];
};

export const hydrateQueue = (
    ctx: Window,
    storageKey: string,
    queue: TelemetryQueue
): void => {
    if (!storageKey) return;
    try {
        const raw = ctx.localStorage.getItem(storageKey);
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
        ctx.localStorage.setItem(storageKey, queue.map(bytesToHex).join(','));
    } catch {
        // ignore quota or restricted storage errors
    }
};
