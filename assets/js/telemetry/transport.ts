import {
    bindArg,
    identity,
    isNumber,
    isString,
    nullable,
    objectStruct,
    observer,
    on,
    pipe,
    taskFork,
    trigger,
    validate,
} from '@month/utils';
import type { DomScope, Task } from '@month/utils';
import {
    TELEMETRY_KIND_UNCAUGHT_ERROR,
    TELEMETRY_KIND_UNHANDLED_REJECTION,
    TELEMETRY_OP_UNSPECIFIED,
    TELEMETRY_SEVERITY_ERROR,
} from '@month/gen/telemetry';
import { createDedupState, DEDUP_WINDOW_MS } from './dedup';
import { encodeAcceptedTelemetry } from './error';
import type { TelemetryInput, TelemetryObs } from './error';
import {
    assembleNextBatch,
    BATCH_BODY,
    BATCH_LAST,
    createTelemetryQueue,
    dropThroughItem,
    enqueueBytes,
    hydrateQueue,
    persistQueue,
    queueHasEntries,
    TELEMETRY_STORAGE_KEY,
} from './queue';

export const BACKOFF_DELAYS_MS = [1000, 2000, 5000, 15000] as const;

const PROTO_CONTENT_TYPE = 'application/x-protobuf';

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

export const isNavigatorOnline = (ctx: Window): boolean => ctx.navigator.onLine;

const postTelemetryTask =
    (ctx: Window, body: Uint8Array): Task<number> =>
    (resolve, reject) => {
        ctx.fetch('/telemetry', {
            ['method']: 'POST',
            ['headers']: { ['Content-Type']: PROTO_CONTENT_TYPE },
            ['credentials']: 'same-origin',
            ['keepalive']: true,
            ['body']: body as unknown as BodyInit,
        }).then((res: Response) => resolve(res.status), reject);
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
        telemetryObs: TelemetryObs = observer<TelemetryInput>(),
        storageKey: string = TELEMETRY_STORAGE_KEY,
        dedupWindowMs: number = DEDUP_WINDOW_MS
    ): Task<TelemetryObs> =>
    (resolve) => {
        const queue = createTelemetryQueue();
        hydrateQueue(ctx, storageKey, queue);

        const dedup = createDedupState();

        let inFlight = false;
        let retryAttempt = 0;
        let retryTimer: number | null = null;
        let active = true;

        const clearRetry = (): void => {
            if (retryTimer !== null) {
                ctx.clearTimeout(retryTimer);
                retryTimer = null;
            }
        };

        const scheduleRetry = (): void => {
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

        const flush = (): void => {
            if (
                !active ||
                inFlight ||
                !queueHasEntries(queue) ||
                !isNavigatorOnline(ctx)
            ) {
                return;
            }
            const batch = assembleNextBatch(ctx, queue);
            if (!batch) return;

            clearRetry();
            inFlight = true;
            const lastItem = batch[BATCH_LAST];

            pipe(
                postTelemetryTask(ctx, batch[BATCH_BODY]),
                taskFork(
                    (status: number) => {
                        inFlight = false;
                        if (status === 429 || status >= 500) {
                            scheduleRetry();
                            return;
                        }
                        retryAttempt = 0;
                        dropThroughItem(lastItem, queue);
                        persistQueue(ctx, storageKey, queue);
                        flush();
                    },
                    () => {
                        inFlight = false;
                        scheduleRetry();
                    }
                )
            );
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

        const onOnline = (): void => {
            if (!active) return;
            retryAttempt = 0;
            clearRetry();
            flush();
        };
        const onError = bindArg(telemetryObs, handleWindowError);
        const onRejection = bindArg(telemetryObs, handleUnhandledRejection);

        ctx.addEventListener('online', onOnline);
        ctx.addEventListener('error', onError);
        ctx.addEventListener('unhandledrejection', onRejection);

        scope.push(() => {
            active = false;
            clearRetry();
            ctx.removeEventListener('online', onOnline);
            ctx.removeEventListener('error', onError);
            ctx.removeEventListener('unhandledrejection', onRejection);
        });

        flush();
        resolve(telemetryObs);
    };
