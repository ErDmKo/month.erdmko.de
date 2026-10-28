import {
    bindArg,
    isBoolean,
    isFunction,
    isNumber,
    isObject,
    isString,
    nullable,
    objectStruct,
    pipe,
    taskCatch,
    taskChain,
    taskMap,
    trim,
    validate,
} from '@month/utils';
import type { ReadonlyTupleOf, Task } from '@month/utils';

declare global {
    interface Window {
        fetch: typeof fetch;
        JSON: typeof JSON;
    }
}

export const NONCE_CHALLENGE_NONCE = 0 as const;
export const NONCE_CHALLENGE_WALLET = 1 as const;
export const NONCE_CHALLENGE_EXPIRES_AT = 2 as const;

export type NonceChallenge = ReadonlyTupleOf<{
    [NONCE_CHALLENGE_NONCE]: string;
    [NONCE_CHALLENGE_WALLET]: string;
    [NONCE_CHALLENGE_EXPIRES_AT]: number;
}>;

export const SESSION_STATUS_WALLET = 0 as const;
export const SESSION_STATUS_NICKNAME = 1 as const;
export const SESSION_STATUS_ACCESS_UNTIL = 2 as const;
export const SESSION_STATUS_HAS_ACTIVE_ACCESS = 3 as const;

export type SessionStatus = ReadonlyTupleOf<{
    [SESSION_STATUS_WALLET]: string;
    [SESSION_STATUS_NICKNAME]: string | null;
    [SESSION_STATUS_ACCESS_UNTIL]: number;
    [SESSION_STATUS_HAS_ACTIVE_ACCESS]: boolean;
}>;

const WIN_FETCH = 0 as const;
const API_ERROR_MESSAGE = 0 as const;
const RESPONSE_RES = 0 as const;
const RESPONSE_TEXT = 1 as const;

type ResponseWithText = ReadonlyTupleOf<{
    [RESPONSE_RES]: Response;
    [RESPONSE_TEXT]: string;
}>;

const windowFetchStruct = objectStruct(['fetch', isFunction<typeof fetch>]);
const apiErrorStruct = objectStruct(['message', isString, trim]);

const noncePayloadStruct = objectStruct(
    ['nonce', isString, trim],
    ['walletAddress', isString, trim],
    ['expiresAt', isNumber]
);

const sessionPayloadStruct = objectStruct(
    ['walletAddress', isString, trim],
    ['nickname', isString, trim, nullable],
    ['accessUntil', isNumber],
    ['hasActiveAccess', isBoolean]
);

const parseJsonObject = (
    ctx: Window,
    rawText: string
): Record<string, unknown> => {
    if (!rawText) return {};
    return isObject(ctx.JSON.parse(rawText)) ?? {};
};

const rawFetchTask =
    (ctx: Window, url: string, init: RequestInit): Task<Response> =>
    (resolve, reject) => {
        const winFetch = validate(ctx, windowFetchStruct);
        if (!winFetch) {
            reject(new Error('Fetch API is not available.'));
            return;
        }
        winFetch[WIN_FETCH](url, init).then(resolve, reject);
    };

const readResponseTextTask =
    (res: Response): Task<ResponseWithText> =>
    (resolve, reject) => {
        res.text().then((rawText: string) => resolve([res, rawText]), reject);
    };

const parseOkResponse = (
    ctx: Window,
    resWithText: ResponseWithText
): Record<string, unknown> => {
    const res = resWithText[RESPONSE_RES];
    const data = parseJsonObject(ctx, resWithText[RESPONSE_TEXT]);
    if (!res.ok) {
        const apiErr = validate(data, apiErrorStruct);
        const msg = apiErr
            ? apiErr[API_ERROR_MESSAGE]
            : `Request failed with status ${res.status}`;
        throw new Error(msg);
    }
    return data;
};

const fetchTask = (
    ctx: Window,
    url: string,
    init: RequestInit
): Task<Record<string, unknown>> =>
    pipe(
        rawFetchTask(ctx, url, init),
        taskChain(readResponseTextTask),
        taskMap(bindArg(ctx, parseOkResponse))
    );

const postJsonTask = (
    ctx: Window,
    url: string,
    payload: Record<string, unknown>
): Task<Record<string, unknown>> =>
    fetchTask(ctx, url, {
        ['method']: 'POST',
        ['headers']: { ['Content-Type']: 'application/json' },
        ['credentials']: 'same-origin',
        ['body']: ctx.JSON.stringify(payload),
    });

const parseNonceChallenge = (data: Record<string, unknown>): NonceChallenge => {
    const parsed = validate(data, noncePayloadStruct);
    if (!parsed) {
        throw new Error('Invalid nonce challenge response.');
    }
    return parsed;
};

const parseSessionStatus = (data: Record<string, unknown>): SessionStatus => {
    const parsed = validate(data, sessionPayloadStruct);
    if (!parsed) {
        throw new Error('Invalid session status response.');
    }
    return parsed;
};

export const fetchNonceTask = (
    ctx: Window,
    walletAddress: string
): Task<NonceChallenge> =>
    pipe(
        postJsonTask(ctx, '/auth/nonce', {
            ['walletAddress']: walletAddress,
        }),
        taskMap(parseNonceChallenge)
    );

export const verifySiweTask = (
    ctx: Window,
    message: string,
    signature: string
): Task<SessionStatus> =>
    pipe(
        postJsonTask(ctx, '/auth/verify', {
            ['message']: message,
            ['signature']: signature,
        }),
        taskMap(parseSessionStatus)
    );

export const claimPaymentTask = (
    ctx: Window,
    txHash: string,
    nickname: string
): Task<SessionStatus> => {
    const trimmedNick = nickname.trim();
    const payload: Record<string, unknown> = trimmedNick
        ? { ['txHash']: txHash, ['nickname']: trimmedNick }
        : { ['txHash']: txHash };
    return pipe(
        postJsonTask(ctx, '/auth/claim-payment', payload),
        taskMap(parseSessionStatus)
    );
};

export const updateNicknameTask = (
    ctx: Window,
    nickname: string
): Task<SessionStatus> =>
    pipe(
        postJsonTask(ctx, '/auth/nickname', {
            ['nickname']: nickname.trim(),
        }),
        taskMap(parseSessionStatus)
    );

export const fetchSessionTask = (ctx: Window): Task<SessionStatus | null> =>
    pipe(
        fetchTask(ctx, '/auth/session', {
            ['method']: 'GET',
            ['credentials']: 'same-origin',
        }),
        taskMap(parseSessionStatus),
        taskCatch(() => null)
    );
