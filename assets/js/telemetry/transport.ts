import {
    bindArgs,
    identity,
    isNumber,
    isString,
    nullable,
    objectStruct,
    pipe,
    taskFork,
    taskMap,
    validate,
} from '@month/utils';
import type { Task, TupleOf } from '@month/utils';
import {
    TELEMETRY_KIND_UNCAUGHT_ERROR,
    TELEMETRY_KIND_UNHANDLED_REJECTION,
    TELEMETRY_OP_UNSPECIFIED,
    TELEMETRY_SEVERITY_ERROR,
} from '@month/gen/telemetry';
import { encodeTelemetryInput } from './error';
import type { TelemetryInput } from './error';
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
} from './queue';
import type { TelemetryQueue } from './queue';

export const BACKOFF_DELAYS_MS = [1000, 2000, 5000, 15000] as const;

const PROTO_CONTENT_TYPE = 'application/x-protobuf';

export const TELEM_STATE_QUEUE = 0 as const;
export const TELEM_STATE_IN_FLIGHT = 1 as const;
export const TELEM_STATE_RETRY_ATTEMPT = 2 as const;
export const TELEM_STATE_RETRY_TIMER = 3 as const;

export type TelemetryState = TupleOf<{
    [TELEM_STATE_QUEUE]: TelemetryQueue;
    [TELEM_STATE_IN_FLIGHT]: boolean;
    [TELEM_STATE_RETRY_ATTEMPT]: number;
    [TELEM_STATE_RETRY_TIMER]: number | null;
}>;

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

export const isNavigatorOnline = (ctx: Window): boolean => ctx.navigator.onLine;

const getResponseStatus = (res: Response): number => res.status;

const rawPostTelemetryTask =
    (ctx: Window, body: Uint8Array): Task<Response> =>
    (resolve, reject) => {
        ctx.fetch('/telemetry', {
            ['method']: 'POST',
            ['headers']: { ['Content-Type']: PROTO_CONTENT_TYPE },
            ['credentials']: 'same-origin',
            ['keepalive']: true,
            ['body']: body as unknown as BodyInit,
        }).then(resolve, reject);
    };

const postTelemetryTask = (ctx: Window, body: Uint8Array): Task<number> =>
    pipe(rawPostTelemetryTask(ctx, body), taskMap(getResponseStatus));

export const createTelemetryState = (ctx: Window): TelemetryState => {
    const queue = createTelemetryQueue();
    hydrateQueue(ctx, queue);
    return [queue, false, 0, null];
};

const clearRetry = (ctx: Window, state: TelemetryState): void => {
    const timer = state[TELEM_STATE_RETRY_TIMER];
    if (timer !== null) {
        ctx.clearTimeout(timer);
        state[TELEM_STATE_RETRY_TIMER] = null;
    }
};

const runRetryTimer = (ctx: Window, state: TelemetryState): void => {
    state[TELEM_STATE_RETRY_TIMER] = null;
    flushTelemetry(ctx, state);
};

const scheduleRetry = (ctx: Window, state: TelemetryState): void => {
    if (
        state[TELEM_STATE_RETRY_TIMER] !== null ||
        !queueHasEntries(state[TELEM_STATE_QUEUE]) ||
        !isNavigatorOnline(ctx)
    ) {
        return;
    }
    const attempt = state[TELEM_STATE_RETRY_ATTEMPT];
    const delayMs =
        BACKOFF_DELAYS_MS[Math.min(attempt, BACKOFF_DELAYS_MS.length - 1)];
    state[TELEM_STATE_RETRY_ATTEMPT] = attempt + 1;
    state[TELEM_STATE_RETRY_TIMER] = ctx.setTimeout(
        bindArgs([ctx, state], runRetryTimer),
        delayMs
    );
};

const handleFlushStatus = (
    ctx: Window,
    lastItem: Uint8Array,
    state: TelemetryState,
    status: number
): void => {
    state[TELEM_STATE_IN_FLIGHT] = false;
    if (status === 429 || status >= 500) {
        scheduleRetry(ctx, state);
        return;
    }
    state[TELEM_STATE_RETRY_ATTEMPT] = 0;
    const queue = state[TELEM_STATE_QUEUE];
    dropThroughItem(lastItem, queue);
    persistQueue(ctx, queue);
    flushTelemetry(ctx, state);
};

const handleFlushError = (ctx: Window, state: TelemetryState): void => {
    state[TELEM_STATE_IN_FLIGHT] = false;
    scheduleRetry(ctx, state);
};

export const flushTelemetry = (ctx: Window, state: TelemetryState): void => {
    const queue = state[TELEM_STATE_QUEUE];
    if (
        state[TELEM_STATE_IN_FLIGHT] ||
        !queueHasEntries(queue) ||
        !isNavigatorOnline(ctx)
    ) {
        return;
    }
    const batch = assembleNextBatch(ctx, queue);
    if (!batch) return;

    clearRetry(ctx, state);
    state[TELEM_STATE_IN_FLIGHT] = true;

    pipe(
        postTelemetryTask(ctx, batch[BATCH_BODY]),
        taskFork(
            bindArgs([ctx, batch[BATCH_LAST], state], handleFlushStatus),
            bindArgs([ctx, state], handleFlushError)
        )
    );
};

export const recordTelemetry = (
    ctx: Window,
    input: TelemetryInput,
    state: TelemetryState
): void => {
    const queue = state[TELEM_STATE_QUEUE];
    if (enqueueBytes(encodeTelemetryInput(ctx, input), queue)) {
        persistQueue(ctx, queue);
        flushTelemetry(ctx, state);
    }
};

const handleOnline = (ctx: Window, state: TelemetryState): void => {
    state[TELEM_STATE_RETRY_ATTEMPT] = 0;
    clearRetry(ctx, state);
    flushTelemetry(ctx, state);
};

const handleWindowError = (
    ctx: Window,
    state: TelemetryState,
    ev: Event
): void => {
    const parsed = validate(ev, errorEventStruct);
    if (!parsed) return;
    const errVal =
        parsed[ERROR_EVENT_ERR] ?? parsed[ERROR_EVENT_MSG] ?? 'Uncaught error';
    recordTelemetry(
        ctx,
        [
            TELEMETRY_SEVERITY_ERROR,
            TELEMETRY_KIND_UNCAUGHT_ERROR,
            TELEMETRY_OP_UNSPECIFIED,
            errVal,
            '',
            parsed[ERROR_EVENT_LINE] ?? 0,
            parsed[ERROR_EVENT_COL] ?? 0,
        ],
        state
    );
};

const handleUnhandledRejection = (
    ctx: Window,
    state: TelemetryState,
    ev: Event
): void => {
    const parsed = validate(ev, rejectionEventStruct);
    recordTelemetry(
        ctx,
        [
            TELEMETRY_SEVERITY_ERROR,
            TELEMETRY_KIND_UNHANDLED_REJECTION,
            TELEMETRY_OP_UNSPECIFIED,
            parsed ? parsed[REJECTION_REASON] : ev,
        ],
        state
    );
};

export const initTelemetry = (ctx: Window): TelemetryState => {
    const state = createTelemetryState(ctx);
    ctx.addEventListener('online', bindArgs([ctx, state], handleOnline));
    ctx.addEventListener('error', bindArgs([ctx, state], handleWindowError));
    ctx.addEventListener(
        'unhandledrejection',
        bindArgs([ctx, state], handleUnhandledRejection)
    );
    flushTelemetry(ctx, state);
    return state;
};
