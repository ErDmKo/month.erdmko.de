import { bindArg } from '@month/utils';
import type { ReadonlyTupleOf } from '@month/utils';
import { concatBytes, encodeBytesField } from '../utils/proto-utils';

export const TELEMETRY_STORAGE_KEY = 'telemetry';
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

const charCode = (ch: string): number => ch.charCodeAt(0);

const bytesToBase64 = (ctx: Window, bytes: Uint8Array): string =>
    ctx.btoa(ctx.String.fromCharCode(...bytes));

const base64ToBytes = (ctx: Window, encoded: string): Uint8Array =>
    ctx.Uint8Array.from(ctx.atob(encoded), charCode);

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

export const hydrateQueue = (ctx: Window, queue: TelemetryQueue): void => {
    try {
        const raw = ctx.localStorage.getItem(TELEMETRY_STORAGE_KEY);
        if (!raw) return;
        for (const part of raw.split(',').slice(-MAX_QUEUE_EVENTS)) {
            if (part) {
                enqueueBytes(base64ToBytes(ctx, part), queue);
            }
        }
    } catch {
        // ignore restricted storage or malformed base64 errors
    }
};

export const persistQueue = (ctx: Window, queue: TelemetryQueue): void => {
    try {
        ctx.localStorage.setItem(
            TELEMETRY_STORAGE_KEY,
            queue.map(bindArg(ctx, bytesToBase64)).join(',')
        );
    } catch {
        // ignore quota or restricted storage errors
    }
};
