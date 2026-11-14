import {
    isNumber,
    isObject,
    isString,
    nullable,
    objectStruct,
    trim,
    validate,
} from '@month/utils';
import type { ReadonlyTupleOf } from '@month/utils';
import {
    TELEMETRY_KIND_UNCAUGHT_ERROR,
    TELEMETRY_KIND_UNHANDLED_REJECTION,
    TELEMETRY_OP_UNSPECIFIED,
    TELEMETRY_PROVIDER_FLAG_ETHEREUM,
    TELEMETRY_PROVIDER_FLAG_NONE,
    TELEMETRY_SEVERITY_ERROR,
} from '@month/gen/telemetry';
import { createTelemetryClient, reportTelemetryEvent } from '@month/telemetry';
import type { TelemetryClient, TelemetryStorage } from '@month/telemetry';

const MAX_CODE_LEN = 64;
const MAX_PATH_LEN = 128;
const MAX_MSG_LEN = 256;

const PROVIDER_FLAGS: ReadonlyArray<readonly [string, number]> = [
    ['isMetaMask', 2],
    ['isPhantom', 4],
    ['isCoinbaseWallet', 8],
    ['isRabby', 16],
    ['isBraveWallet', 32],
];

const clientsByWindow = new WeakMap<object, TelemetryClient>();
const chainIdsByWindow = new WeakMap<object, number>();

const ERR_NUM_CODE = 0 as const;
const ERR_STR_CODE = 1 as const;
const ERR_NAME = 2 as const;
const ERR_MSG = 3 as const;
const ERR_DATA = 4 as const;
const DATA_MSG = 0 as const;

const errorInfoStruct = objectStruct(
    ['code', isNumber, nullable],
    ['code', isString, trim, nullable],
    ['name', isString, trim, nullable],
    ['message', isString, trim, nullable],
    ['data', objectStruct(['message', isString, trim]), nullable]
);

const ERROR_EVENT_MSG = 0 as const;
const ERROR_EVENT_LINE = 1 as const;
const ERROR_EVENT_COL = 2 as const;

const windowErrorEventStruct = objectStruct(
    ['message', isString, nullable],
    ['lineno', isNumber, nullable],
    ['colno', isNumber, nullable]
);

const EXTRACTED_CODE = 0 as const;
const EXTRACTED_MSG = 1 as const;
type ExtractedError = ReadonlyTupleOf<{
    [EXTRACTED_CODE]: string;
    [EXTRACTED_MSG]: string;
}>;

const WIN_ETH_OBJ = 0 as const;
const ethereumObjStruct = objectStruct(['ethereum', isObject]);

export const detectProviderFlags = (ctx: Window): number => {
    const parsed = validate(ctx, ethereumObjStruct);
    if (!parsed) return TELEMETRY_PROVIDER_FLAG_NONE;
    const eth = parsed[WIN_ETH_OBJ];
    let flags: number = TELEMETRY_PROVIDER_FLAG_ETHEREUM;
    for (const [key, bit] of PROVIDER_FLAGS) {
        if (eth[key] === true) flags |= bit;
    }
    return flags;
};

export const setActiveTelemetryChainId = (
    ctx: Window,
    chainId: number
): void => {
    if (chainId > 0) chainIdsByWindow.set(ctx, Math.floor(chainId));
};

export const extractTelemetryError = (err: unknown): ExtractedError => {
    const parsed = validate(err, errorInfoStruct);
    if (parsed) {
        const rawCode =
            parsed[ERR_NUM_CODE] !== null
                ? String(parsed[ERR_NUM_CODE])
                : parsed[ERR_STR_CODE] ||
                  (parsed[ERR_NAME] && parsed[ERR_NAME] !== 'Error'
                      ? parsed[ERR_NAME]
                      : '');
        const rawMsg =
            parsed[ERR_MSG] ||
            (parsed[ERR_DATA] ? parsed[ERR_DATA][DATA_MSG] : '') ||
            String(err);
        return [rawCode.slice(0, MAX_CODE_LEN), rawMsg.slice(0, MAX_MSG_LEN)];
    }
    return ['', String(err ?? '').slice(0, MAX_MSG_LEN)];
};

export const emitChatTelemetry = (
    ctx: Window,
    severity: number,
    kind: number,
    op: number,
    err: unknown,
    explicitCode = '',
    line = 0,
    column = 0
): void => {
    const client = clientsByWindow.get(ctx);
    if (!client) return;
    const extracted = extractTelemetryError(err);
    reportTelemetryEvent(
        ctx,
        severity,
        kind,
        op,
        (explicitCode || extracted[EXTRACTED_CODE]).slice(0, MAX_CODE_LEN),
        extracted[EXTRACTED_MSG],
        (ctx.location?.pathname ?? '').slice(0, MAX_PATH_LEN),
        line > 0 ? Math.floor(line) : 0,
        column > 0 ? Math.floor(column) : 0,
        chainIdsByWindow.get(ctx) ?? 0,
        detectProviderFlags(ctx),
        client
    );
};

export const initChatTelemetry = (
    ctx: Window,
    storage: TelemetryStorage | null = null
): TelemetryClient => {
    const existing = clientsByWindow.get(ctx);
    if (existing) return existing;

    const client = createTelemetryClient(ctx, storage);
    clientsByWindow.set(ctx, client);

    if (typeof ctx.addEventListener === 'function') {
        ctx.addEventListener('error', (ev: Event) => {
            const parsed = validate(ev, windowErrorEventStruct);
            const errObj = (ev as ErrorEvent).error;
            emitChatTelemetry(
                ctx,
                TELEMETRY_SEVERITY_ERROR,
                TELEMETRY_KIND_UNCAUGHT_ERROR,
                TELEMETRY_OP_UNSPECIFIED,
                errObj ?? (parsed ? parsed[ERROR_EVENT_MSG] : 'Uncaught error'),
                '',
                parsed ? (parsed[ERROR_EVENT_LINE] ?? 0) : 0,
                parsed ? (parsed[ERROR_EVENT_COL] ?? 0) : 0
            );
        });

        ctx.addEventListener('unhandledrejection', (ev: Event) => {
            emitChatTelemetry(
                ctx,
                TELEMETRY_SEVERITY_ERROR,
                TELEMETRY_KIND_UNHANDLED_REJECTION,
                TELEMETRY_OP_UNSPECIFIED,
                (ev as PromiseRejectionEvent).reason
            );
        });
    }

    return client;
};
