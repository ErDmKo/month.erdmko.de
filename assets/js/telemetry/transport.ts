import {
    bindArg,
    identity,
    isBoolean,
    isFunction,
    isNumber,
    isString,
    nullable,
    objectStruct,
    observer,
    on,
    trigger,
    validate,
} from '@month/utils';
import type { DomScope, Task } from '@month/utils';
import {
    TELEMETRY_ACK_ACK_ID,
    TELEMETRY_KIND_UNCAUGHT_ERROR,
    TELEMETRY_KIND_UNHANDLED_REJECTION,
    TELEMETRY_OP_UNSPECIFIED,
    TELEMETRY_SEVERITY_ERROR,
    decodeTelemetryAck,
} from '@month/gen/telemetry';
import { createDedupState, DEDUP_WINDOW_MS } from './dedup';
import { encodeAcceptedTelemetry } from './error';
import type { TelemetryInput, TelemetryObs } from './error';
import {
    ackQueueEntries,
    assembleNextBatch,
    BATCH_ACK_ID,
    BATCH_FRAME,
    createTelemetryQueue,
    enqueueBytes,
    hydrateQueue,
    persistQueue,
    queueHasEntries,
    TELEMETRY_STORAGE_KEY,
} from './queue';

declare global {
    interface Window {
        WebSocket: typeof WebSocket;
        ArrayBuffer: typeof ArrayBuffer;
    }
}

export const IDLE_CLOSE_MS = 10000;
export const BACKOFF_DELAYS_MS = [1000, 2000, 5000, 15000] as const;

const WS_CONNECTING_STATE = 0;
const WS_OPEN_STATE = 1;

const WIN_NAVIGATOR = 0 as const;
const NAV_ON_LINE = 0 as const;

const navigatorOnlineStruct = objectStruct([
    'navigator',
    objectStruct(['onLine', isBoolean]),
]);

const WIN_ADD_EVENT = 0 as const;
const WIN_REMOVE_EVENT = 1 as const;

const windowEventsStruct = objectStruct(
    ['addEventListener', isFunction<Window['addEventListener']>],
    ['removeEventListener', isFunction<Window['removeEventListener']>, nullable]
);

const MSG_EVENT_DATA = 0 as const;
const messageEventStruct = objectStruct(['data', identity, nullable]);

const ERROR_EVENT_MSG = 0 as const;
const ERROR_EVENT_LINE = 1 as const;
const ERROR_EVENT_COL = 2 as const;
const ERROR_EVENT_ERR = 3 as const;

const errorEventStruct = objectStruct(
    ['message', isString, nullable],
    ['lineno', isNumber, nullable],
    ['colno', isNumber, nullable],
    ['error', identity, nullable]
);

const REJECTION_REASON = 0 as const;
const rejectionEventStruct = objectStruct(['reason', identity, nullable]);

const zeroChainId = (): number => 0;

export const isNavigatorOnline = (ctx: Window): boolean => {
    const parsed = validate(ctx, navigatorOnlineStruct);
    return parsed ? parsed[WIN_NAVIGATOR][NAV_ON_LINE] : true;
};

const toFrameBytes = (ctx: Window, raw: unknown): Uint8Array | null => {
    if (raw instanceof ctx.Uint8Array) return raw;
    if (ctx.ArrayBuffer && raw instanceof ctx.ArrayBuffer) {
        return new ctx.Uint8Array(raw);
    }
    return null;
};

const handleWindowError = (telemetryObs: TelemetryObs, ev: Event): void => {
    const parsed = validate(ev, errorEventStruct);
    if (!parsed) return;
    const errVal =
        parsed[ERROR_EVENT_ERR] ?? parsed[ERROR_EVENT_MSG] ?? 'Uncaught error';
    telemetryObs(
        bindArg(
            [
                TELEMETRY_SEVERITY_ERROR,
                TELEMETRY_KIND_UNCAUGHT_ERROR,
                TELEMETRY_OP_UNSPECIFIED,
                errVal,
                '',
                parsed[ERROR_EVENT_LINE] ?? 0,
                parsed[ERROR_EVENT_COL] ?? 0,
            ] as const,
            trigger
        )
    );
};

const handleUnhandledRejection = (
    telemetryObs: TelemetryObs,
    ev: Event
): void => {
    const parsed = validate(ev, rejectionEventStruct);
    telemetryObs(
        bindArg(
            [
                TELEMETRY_SEVERITY_ERROR,
                TELEMETRY_KIND_UNHANDLED_REJECTION,
                TELEMETRY_OP_UNSPECIFIED,
                parsed ? parsed[REJECTION_REASON] : ev,
            ] as const,
            trigger
        )
    );
};

export const initTelemetry =
    (
        ctx: Window,
        resolveChainId: (ctx: Window) => number = zeroChainId,
        scope: DomScope = [],
        storageKey: string = TELEMETRY_STORAGE_KEY,
        idleCloseMs: number = IDLE_CLOSE_MS,
        dedupWindowMs: number = DEDUP_WINDOW_MS
    ): Task<TelemetryObs> =>
    (resolve) => {
        const queue = createTelemetryQueue();
        hydrateQueue(ctx, storageKey, queue);

        const dedup = createDedupState();
        const telemetryObs = observer<TelemetryInput>();

        let ws: WebSocket | null = null;
        let inFlightAck = 0;
        let retryAttempt = 0;
        let retryTimer: number | null = null;
        let idleTimer: number | null = null;
        let active = true;

        const clearRetry = (): void => {
            if (retryTimer !== null) {
                ctx.clearTimeout(retryTimer);
                retryTimer = null;
            }
        };

        const clearIdle = (): void => {
            if (idleTimer !== null) {
                ctx.clearTimeout(idleTimer);
                idleTimer = null;
            }
        };

        const closeSocket = (): void => {
            const current = ws;
            ws = null;
            inFlightAck = 0;
            if (current) {
                current.onopen =
                    current.onmessage =
                    current.onerror =
                    current.onclose =
                        null;
                try {
                    current.close();
                } catch {
                    // ignore
                }
            }
        };

        const startIdle = (): void => {
            clearIdle();
            if (!ws || !active) return;
            idleTimer = ctx.setTimeout(() => {
                idleTimer = null;
                if (!queueHasEntries(queue) && inFlightAck === 0) {
                    closeSocket();
                }
            }, idleCloseMs);
        };

        const scheduleReconnect = (): void => {
            if (
                !active ||
                retryTimer !== null ||
                !queueHasEntries(queue) ||
                !isNavigatorOnline(ctx)
            ) {
                return;
            }
            const delayMs =
                BACKOFF_DELAYS_MS[
                    Math.min(retryAttempt, BACKOFF_DELAYS_MS.length - 1)
                ];
            retryAttempt += 1;
            retryTimer = ctx.setTimeout(() => {
                retryTimer = null;
                flush();
            }, delayMs);
        };

        const sendNext = (): void => {
            if (!ws || ws.readyState !== WS_OPEN_STATE || inFlightAck !== 0) {
                return;
            }
            const batch = assembleNextBatch(ctx, queue);
            if (!batch) {
                startIdle();
                return;
            }
            clearIdle();
            inFlightAck = batch[BATCH_ACK_ID];
            try {
                ws.send(batch[BATCH_FRAME] as Uint8Array<ArrayBuffer>);
            } catch {
                closeSocket();
                scheduleReconnect();
            }
        };

        const flush = (): void => {
            if (!active || !queueHasEntries(queue) || !isNavigatorOnline(ctx)) {
                return;
            }
            if (ws) {
                if (ws.readyState === WS_OPEN_STATE) {
                    sendNext();
                    return;
                }
                if (ws.readyState === WS_CONNECTING_STATE) return;
                closeSocket();
            }

            clearRetry();
            clearIdle();

            const proto = ctx.location.protocol === 'https:' ? 'wss:' : 'ws:';
            let sock: WebSocket;
            try {
                sock = new ctx.WebSocket(
                    `${proto}//${ctx.location.host}/ws/telemetry`
                );
            } catch {
                scheduleReconnect();
                return;
            }

            sock.binaryType = 'arraybuffer';
            ws = sock;
            inFlightAck = 0;

            sock.onopen = () => {
                if (ws === sock) sendNext();
            };

            sock.onmessage = (ev: MessageEvent) => {
                if (ws !== sock) return;
                const msg = validate(ev, messageEventStruct);
                const bytes = msg
                    ? toFrameBytes(ctx, msg[MSG_EVENT_DATA])
                    : null;
                const ack = bytes ? decodeTelemetryAck(ctx, bytes) : null;
                const ackId = ack ? ack[TELEMETRY_ACK_ACK_ID] : 0;
                if (ackId <= 0) return;

                retryAttempt = 0;
                if (ackId >= inFlightAck) inFlightAck = 0;
                ackQueueEntries(ackId, queue);
                persistQueue(ctx, storageKey, queue);
                if (queueHasEntries(queue)) {
                    sendNext();
                } else {
                    startIdle();
                }
            };

            sock.onclose = () => {
                if (ws !== sock) return;
                sock.onopen =
                    sock.onmessage =
                    sock.onerror =
                    sock.onclose =
                        null;
                ws = null;
                inFlightAck = 0;
                clearIdle();
                if (queueHasEntries(queue)) {
                    scheduleReconnect();
                }
            };
        };

        telemetryObs(
            bindArg((input: TelemetryInput) => {
                if (!active) return;
                const bytes = encodeAcceptedTelemetry(
                    ctx,
                    resolveChainId,
                    dedupWindowMs,
                    dedup,
                    input
                );
                if (bytes && enqueueBytes(bytes, queue)) {
                    persistQueue(ctx, storageKey, queue);
                    flush();
                }
            }, on)
        );

        const winEvents = validate(ctx, windowEventsStruct);
        if (winEvents) {
            const addEvent = winEvents[WIN_ADD_EVENT];
            const removeEvent = winEvents[WIN_REMOVE_EVENT];
            const onOnline = (): void => {
                if (!active) return;
                retryAttempt = 0;
                clearRetry();
                flush();
            };
            const onError = bindArg(telemetryObs, handleWindowError);
            const onRejection = bindArg(telemetryObs, handleUnhandledRejection);

            addEvent('online', onOnline);
            addEvent('error', onError);
            addEvent('unhandledrejection', onRejection);

            scope.push(() => {
                if (removeEvent) {
                    removeEvent('online', onOnline);
                    removeEvent('error', onError);
                    removeEvent('unhandledrejection', onRejection);
                }
            });
        }

        scope.push(() => {
            active = false;
            clearRetry();
            clearIdle();
            closeSocket();
        });

        flush();
        resolve(telemetryObs);
    };
