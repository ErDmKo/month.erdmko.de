import { isBoolean, objectStruct, validate } from '@month/utils';
import type { TupleOf } from '@month/utils';
import {
    TELEMETRY_ACK_ACK_ID,
    decodeTelemetryAck,
    encodeTelemetryEvent,
} from '@month/gen/telemetry';
import { createDedupState, DEDUP_WINDOW_MS, shouldRecordEvent } from './dedup';
import type { DedupState } from './dedup';
import {
    ackEntries,
    assembleNextBatch,
    BATCH_ACK_ID,
    BATCH_FRAME,
    createTelemetryQueue,
    enqueueEntry,
    queueHasEntries,
    STORAGE_CLOSE,
    STORAGE_HYDRATE,
} from './queue';
import type { TelemetryQueue, TelemetryStorage } from './queue';

declare global {
    interface Window {
        WebSocket: typeof WebSocket;
        ArrayBuffer: typeof ArrayBuffer;
        Date: typeof Date;
    }
}

export const IDLE_CLOSE_MS = 10000;
export const BACKOFF_DELAYS_MS = [1000, 2000, 5000, 15000] as const;

const WS_CONNECTING_STATE = 0;
const WS_OPEN_STATE = 1;

export const CLIENT_QUEUE = 0 as const;
export const CLIENT_DEDUP = 1 as const;
export const CLIENT_WS = 2 as const;
export const CLIENT_IN_FLIGHT_ACK = 3 as const;
export const CLIENT_RETRY_ATTEMPT = 4 as const;
export const CLIENT_RETRY_TIMER = 5 as const;
export const CLIENT_IDLE_TIMER = 6 as const;
export const CLIENT_READY = 7 as const;
export const CLIENT_IDLE_MS = 8 as const;
export const CLIENT_DEDUP_MS = 9 as const;
export const CLIENT_ONLINE_HANDLER = 10 as const;
export const CLIENT_STORAGE = 11 as const;

export type TelemetryClient = TupleOf<{
    [CLIENT_QUEUE]: TelemetryQueue;
    [CLIENT_DEDUP]: DedupState;
    [CLIENT_WS]: WebSocket | null;
    [CLIENT_IN_FLIGHT_ACK]: number;
    [CLIENT_RETRY_ATTEMPT]: number;
    [CLIENT_RETRY_TIMER]: number | null;
    [CLIENT_IDLE_TIMER]: number | null;
    [CLIENT_READY]: boolean;
    [CLIENT_IDLE_MS]: number;
    [CLIENT_DEDUP_MS]: number;
    [CLIENT_ONLINE_HANDLER]: (() => void) | null;
    [CLIENT_STORAGE]: TelemetryStorage | null;
}>;

const WIN_NAVIGATOR = 0 as const;
const NAV_ON_LINE = 0 as const;

const navigatorOnlineStruct = objectStruct([
    'navigator',
    objectStruct(['onLine', isBoolean]),
]);

export const isNavigatorOnline = (ctx: Window): boolean => {
    const parsed = validate(ctx, navigatorOnlineStruct);
    return parsed ? parsed[WIN_NAVIGATOR][NAV_ON_LINE] : true;
};

const clearTimer = (
    ctx: Window,
    slot: typeof CLIENT_RETRY_TIMER | typeof CLIENT_IDLE_TIMER,
    client: TelemetryClient
): void => {
    const timer = client[slot];
    if (timer !== null) {
        ctx.clearTimeout(timer);
        client[slot] = null;
    }
};

const closeActiveSocket = (client: TelemetryClient): void => {
    const ws = client[CLIENT_WS];
    client[CLIENT_WS] = null;
    client[CLIENT_IN_FLIGHT_ACK] = 0;
    if (ws) {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        ws.close();
    }
};

const startIdleTimer = (ctx: Window, client: TelemetryClient): void => {
    clearTimer(ctx, CLIENT_IDLE_TIMER, client);
    if (!client[CLIENT_WS] || !client[CLIENT_READY]) return;
    client[CLIENT_IDLE_TIMER] = ctx.setTimeout(() => {
        client[CLIENT_IDLE_TIMER] = null;
        if (
            !queueHasEntries(client[CLIENT_QUEUE]) &&
            client[CLIENT_IN_FLIGHT_ACK] === 0
        ) {
            closeActiveSocket(client);
        }
    }, client[CLIENT_IDLE_MS]);
};

const scheduleReconnect = (ctx: Window, client: TelemetryClient): void => {
    if (
        !client[CLIENT_READY] ||
        client[CLIENT_RETRY_TIMER] !== null ||
        !queueHasEntries(client[CLIENT_QUEUE]) ||
        !isNavigatorOnline(ctx)
    ) {
        return;
    }
    const delayMs =
        BACKOFF_DELAYS_MS[
            Math.min(client[CLIENT_RETRY_ATTEMPT], BACKOFF_DELAYS_MS.length - 1)
        ];
    client[CLIENT_RETRY_ATTEMPT] += 1;
    client[CLIENT_RETRY_TIMER] = ctx.setTimeout(() => {
        client[CLIENT_RETRY_TIMER] = null;
        flushTelemetry(ctx, client);
    }, delayMs);
};

const sendNextBatchOnOpenSocket = (
    ctx: Window,
    client: TelemetryClient
): void => {
    const ws = client[CLIENT_WS];
    if (
        !ws ||
        ws.readyState !== WS_OPEN_STATE ||
        client[CLIENT_IN_FLIGHT_ACK] !== 0
    ) {
        return;
    }
    const batch = assembleNextBatch(ctx, client[CLIENT_QUEUE]);
    if (!batch) {
        startIdleTimer(ctx, client);
        return;
    }
    clearTimer(ctx, CLIENT_IDLE_TIMER, client);
    client[CLIENT_IN_FLIGHT_ACK] = batch[BATCH_ACK_ID];
    ws.send(batch[BATCH_FRAME] as Uint8Array<ArrayBuffer>);
};

export const flushTelemetry = (ctx: Window, client: TelemetryClient): void => {
    if (
        !client[CLIENT_READY] ||
        !queueHasEntries(client[CLIENT_QUEUE]) ||
        !isNavigatorOnline(ctx)
    ) {
        return;
    }

    const existing = client[CLIENT_WS];
    if (existing) {
        if (existing.readyState === WS_OPEN_STATE) {
            sendNextBatchOnOpenSocket(ctx, client);
            return;
        }
        if (existing.readyState === WS_CONNECTING_STATE) return;
        closeActiveSocket(client);
    }

    clearTimer(ctx, CLIENT_RETRY_TIMER, client);
    clearTimer(ctx, CLIENT_IDLE_TIMER, client);

    const proto = ctx.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new ctx.WebSocket(`${proto}//${ctx.location.host}/ws/telemetry`);
    ws.binaryType = 'arraybuffer';
    client[CLIENT_WS] = ws;
    client[CLIENT_IN_FLIGHT_ACK] = 0;

    ws.onopen = () => {
        if (client[CLIENT_WS] === ws) sendNextBatchOnOpenSocket(ctx, client);
    };

    ws.onmessage = (ev: MessageEvent) => {
        if (client[CLIENT_WS] !== ws || !ev.data) return;
        const bytes =
            ev.data instanceof ctx.Uint8Array
                ? ev.data
                : new ctx.Uint8Array(ev.data as ArrayBuffer);
        const ack = decodeTelemetryAck(ctx, bytes);
        const ackId = ack ? ack[TELEMETRY_ACK_ACK_ID] : 0;
        if (ackId <= 0) return;
        client[CLIENT_RETRY_ATTEMPT] = 0;
        if (ackId >= client[CLIENT_IN_FLIGHT_ACK]) {
            client[CLIENT_IN_FLIGHT_ACK] = 0;
        }
        ackEntries(ctx, ackId, client[CLIENT_QUEUE], client[CLIENT_STORAGE]);
        if (queueHasEntries(client[CLIENT_QUEUE])) {
            sendNextBatchOnOpenSocket(ctx, client);
        } else {
            startIdleTimer(ctx, client);
        }
    };

    ws.onclose = () => {
        if (client[CLIENT_WS] !== ws) return;
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        client[CLIENT_WS] = null;
        client[CLIENT_IN_FLIGHT_ACK] = 0;
        clearTimer(ctx, CLIENT_IDLE_TIMER, client);
        if (queueHasEntries(client[CLIENT_QUEUE])) {
            scheduleReconnect(ctx, client);
        }
    };
};

export const createTelemetryClient = (
    ctx: Window,
    storage: TelemetryStorage | null = null,
    idleCloseMs: number = IDLE_CLOSE_MS,
    dedupWindowMs: number = DEDUP_WINDOW_MS
): TelemetryClient => {
    const queue = createTelemetryQueue();
    const client: TelemetryClient = [
        queue,
        createDedupState(),
        null,
        0,
        0,
        null,
        null,
        storage === null,
        idleCloseMs,
        dedupWindowMs,
        null,
        storage,
    ];

    const onOnline = (): void => {
        client[CLIENT_RETRY_ATTEMPT] = 0;
        clearTimer(ctx, CLIENT_RETRY_TIMER, client);
        flushTelemetry(ctx, client);
    };
    client[CLIENT_ONLINE_HANDLER] = onOnline;
    if (typeof ctx.addEventListener === 'function') {
        ctx.addEventListener('online', onOnline);
    }

    if (storage) {
        storage[STORAGE_HYDRATE](ctx, queue, () => {
            client[CLIENT_READY] = true;
            flushTelemetry(ctx, client);
        });
    }

    return client;
};

export const reportTelemetryEvent = (
    ctx: Window,
    severity: number,
    kind: number,
    op: number,
    code: string,
    message: string,
    path: string,
    line: number,
    column: number,
    chainId: number,
    providerFlags: number,
    client: TelemetryClient
): void => {
    const nowMs = ctx.Date.now();
    if (
        !shouldRecordEvent(
            nowMs,
            kind,
            op,
            code,
            message,
            client[CLIENT_DEDUP_MS],
            client[CLIENT_DEDUP]
        )
    ) {
        return;
    }
    const bytes = encodeTelemetryEvent(
        ctx,
        nowMs,
        severity,
        kind,
        op,
        code,
        message,
        path,
        line,
        column,
        chainId,
        providerFlags
    );
    if (enqueueEntry(bytes, client[CLIENT_QUEUE], client[CLIENT_STORAGE])) {
        flushTelemetry(ctx, client);
    }
};

export const disposeTelemetryClient = (
    ctx: Window,
    client: TelemetryClient
): void => {
    client[CLIENT_READY] = false;
    clearTimer(ctx, CLIENT_RETRY_TIMER, client);
    clearTimer(ctx, CLIENT_IDLE_TIMER, client);
    closeActiveSocket(client);
    const handler = client[CLIENT_ONLINE_HANDLER];
    if (handler && typeof ctx.removeEventListener === 'function') {
        ctx.removeEventListener('online', handler);
    }
    client[CLIENT_ONLINE_HANDLER] = null;
    const storage = client[CLIENT_STORAGE];
    if (storage) storage[STORAGE_CLOSE]();
};
