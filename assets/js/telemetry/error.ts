import {
    isNumber,
    isString,
    nullable,
    objectStruct,
    trim,
    validate,
} from '@month/utils';
import type { ReadonlyTupleOf } from '@month/utils';
import { encodeTelemetryEvent } from '@month/gen/telemetry';

export const MAX_CODE_LEN = 64;
export const MAX_PATH_LEN = 128;
export const MAX_MSG_LEN = 256;

export const EXTRACTED_CODE = 0 as const;
export const EXTRACTED_MESSAGE = 1 as const;

export type ExtractedError = ReadonlyTupleOf<{
    [EXTRACTED_CODE]: string;
    [EXTRACTED_MESSAGE]: string;
}>;

export const TELEM_INPUT_SEVERITY = 0 as const;
export const TELEM_INPUT_KIND = 1 as const;
export const TELEM_INPUT_OP = 2 as const;
export const TELEM_INPUT_ERROR = 3 as const;
export const TELEM_INPUT_CODE = 4 as const;
export const TELEM_INPUT_LINE = 5 as const;
export const TELEM_INPUT_COL = 6 as const;
export const TELEM_INPUT_CHAIN_ID = 7 as const;
export const TELEM_INPUT_PROVIDER_FLAGS = 8 as const;

export type TelemetryShortInput = ReadonlyTupleOf<{
    [TELEM_INPUT_SEVERITY]: number;
    [TELEM_INPUT_KIND]: number;
    [TELEM_INPUT_OP]: number;
    [TELEM_INPUT_ERROR]: unknown;
}>;

export type TelemetryCodeInput = ReadonlyTupleOf<{
    [TELEM_INPUT_SEVERITY]: number;
    [TELEM_INPUT_KIND]: number;
    [TELEM_INPUT_OP]: number;
    [TELEM_INPUT_ERROR]: unknown;
    [TELEM_INPUT_CODE]: string;
}>;

export type TelemetryLocInput = ReadonlyTupleOf<{
    [TELEM_INPUT_SEVERITY]: number;
    [TELEM_INPUT_KIND]: number;
    [TELEM_INPUT_OP]: number;
    [TELEM_INPUT_ERROR]: unknown;
    [TELEM_INPUT_CODE]: string;
    [TELEM_INPUT_LINE]: number;
    [TELEM_INPUT_COL]: number;
}>;

export type TelemetryFullInput = ReadonlyTupleOf<{
    [TELEM_INPUT_SEVERITY]: number;
    [TELEM_INPUT_KIND]: number;
    [TELEM_INPUT_OP]: number;
    [TELEM_INPUT_ERROR]: unknown;
    [TELEM_INPUT_CODE]: string;
    [TELEM_INPUT_LINE]: number;
    [TELEM_INPUT_COL]: number;
    [TELEM_INPUT_CHAIN_ID]: number;
    [TELEM_INPUT_PROVIDER_FLAGS]: number;
}>;

export type TelemetryInput =
    | TelemetryShortInput
    | TelemetryCodeInput
    | TelemetryLocInput
    | TelemetryFullInput;

const ERR_NUM_CODE = 0 as const;
const ERR_STR_CODE = 1 as const;
const ERR_NAME = 2 as const;
const ERR_MESSAGE = 3 as const;
const ERR_REASON = 4 as const;
const ERR_DATA = 5 as const;
const ERR_DATA_MESSAGE = 0 as const;

const errorInfoStruct = objectStruct(
    ['code', isNumber, nullable],
    ['code', isString, trim, nullable],
    ['name', isString, trim, nullable],
    ['message', isString, trim, nullable],
    ['reason', isString, trim, nullable],
    ['data', objectStruct(['message', isString, trim]), nullable]
);

const stringifyFallback = (
    ctx: Window,
    val: unknown,
    fallback: string
): string => {
    try {
        return ctx.JSON.stringify(val) || fallback || String(val);
    } catch {
        return fallback;
    }
};

export const extractErrorInfo = (
    ctx: Window,
    err: unknown,
    fallback = ''
): ExtractedError => {
    const direct = validate(err, isString, trim);
    if (direct) return ['', direct];
    const parsed = validate(err, errorInfoStruct);
    if (parsed) {
        const rawCode =
            parsed[ERR_NUM_CODE] !== null
                ? String(parsed[ERR_NUM_CODE])
                : (parsed[ERR_STR_CODE] ??
                  (parsed[ERR_NAME] && parsed[ERR_NAME] !== 'Error'
                      ? parsed[ERR_NAME]
                      : ''));
        const data = parsed[ERR_DATA];
        const rawMsg =
            parsed[ERR_MESSAGE] ??
            parsed[ERR_REASON] ??
            (data ? data[ERR_DATA_MESSAGE] : null) ??
            stringifyFallback(ctx, err, fallback);
        return [rawCode, rawMsg];
    }
    return ['', err == null ? fallback : String(err)];
};

export const encodeTelemetryInput = (
    ctx: Window,
    input: TelemetryInput
): Uint8Array => {
    const extracted = extractErrorInfo(ctx, input[TELEM_INPUT_ERROR]);
    const explicitCode =
        input.length > TELEM_INPUT_CODE ? input[TELEM_INPUT_CODE] : '';
    const code = (explicitCode || extracted[EXTRACTED_CODE]).slice(
        0,
        MAX_CODE_LEN
    );
    const msg = extracted[EXTRACTED_MESSAGE].slice(0, MAX_MSG_LEN);
    const line = input.length > TELEM_INPUT_LINE ? input[TELEM_INPUT_LINE] : 0;
    const col = input.length > TELEM_INPUT_COL ? input[TELEM_INPUT_COL] : 0;
    const chainId =
        input.length > TELEM_INPUT_CHAIN_ID ? input[TELEM_INPUT_CHAIN_ID] : 0;
    const providerFlags =
        input.length > TELEM_INPUT_PROVIDER_FLAGS
            ? input[TELEM_INPUT_PROVIDER_FLAGS]
            : 0;
    return encodeTelemetryEvent(
        ctx,
        ctx.Date.now(),
        input[TELEM_INPUT_SEVERITY],
        input[TELEM_INPUT_KIND],
        input[TELEM_INPUT_OP],
        code,
        msg,
        ctx.location.pathname.slice(0, MAX_PATH_LEN),
        line,
        col,
        chainId,
        providerFlags
    );
};
