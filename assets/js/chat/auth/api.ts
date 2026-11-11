import {
    bindArg,
    isFunction,
    objectStruct,
    pipe,
    taskCatch,
    taskChain,
    taskMap,
    validate,
} from '@month/utils';
import type { ReadonlyTupleOf, Task } from '@month/utils';
import {
    AUTH_PAYMENT_CONFIG_ACCESS_DURATION_SECS,
    AUTH_PAYMENT_CONFIG_CHAIN_ID,
    AUTH_PAYMENT_CONFIG_MIN_PAYMENT_WEI,
    AUTH_PAYMENT_CONFIG_RECIPIENT_ADDRESS,
    AUTH_SESSION_ACCESS_UNTIL,
    AUTH_SESSION_HAS_ACTIVE_ACCESS,
    AUTH_SESSION_NICKNAME,
    AUTH_SESSION_PAYMENT_CONFIG,
    AUTH_SESSION_WALLET_ADDRESS,
    CLAIM_PAYMENT_RESPONSE_ACTIVATED,
    CLAIM_PAYMENT_RESPONSE_PAYLOAD_VALUE,
    CLAIM_PAYMENT_RESPONSE_PAYLOAD_VARIANT,
    decodeAuthSession,
    decodeClaimPaymentResponse,
    decodeNonceResponse,
    decodePaymentClaimNotice,
    encodeClaimPaymentRequest,
    encodeNonceRequest,
    encodeSetNicknameRequest,
    encodeVerifySiweRequest,
    NONCE_RESPONSE_EXPIRES_AT,
    NONCE_RESPONSE_NONCE,
    NONCE_RESPONSE_PAYMENT_CONFIG,
    NONCE_RESPONSE_WALLET_ADDRESS,
    PAYMENT_CLAIM_NOTICE_MESSAGE,
} from '@month/gen/chat';
import type {
    AuthPaymentConfig,
    AuthSession,
    ClaimPaymentResponsePayload,
} from '@month/gen/chat';
import {
    DEFAULT_ACCESS_DURATION_SECS,
    DEFAULT_CHAIN_ID,
    DEFAULT_PAYMENT_VALUE_HEX,
    RECIPIENT_WALLET_ADDRESS,
} from './wallet';

declare global {
    interface Window {
        fetch: typeof fetch;
    }
}

export const PAYMENT_CONFIG_CHAIN_ID = 0 as const;
export const PAYMENT_CONFIG_RECIPIENT = 1 as const;
export const PAYMENT_CONFIG_MIN_WEI_HEX = 2 as const;
export const PAYMENT_CONFIG_DURATION_SECS = 3 as const;

export type PaymentConfig = ReadonlyTupleOf<{
    [PAYMENT_CONFIG_CHAIN_ID]: number;
    [PAYMENT_CONFIG_RECIPIENT]: string;
    [PAYMENT_CONFIG_MIN_WEI_HEX]: string;
    [PAYMENT_CONFIG_DURATION_SECS]: number;
}>;

const DEFAULT_PAYMENT_CONFIG: PaymentConfig = [
    DEFAULT_CHAIN_ID,
    RECIPIENT_WALLET_ADDRESS.toLowerCase(),
    DEFAULT_PAYMENT_VALUE_HEX,
    DEFAULT_ACCESS_DURATION_SECS,
];

const configByWindow = new WeakMap<object, PaymentConfig>();

export const getActivePaymentConfig = (ctx?: Window): PaymentConfig =>
    (ctx ? configByWindow.get(ctx) : undefined) ?? DEFAULT_PAYMENT_CONFIG;

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

const PROTO_CONTENT_TYPE = 'application/x-protobuf';
const WIN_FETCH = 0 as const;
const windowFetchStruct = objectStruct(['fetch', isFunction<typeof fetch>]);

export const applyPaymentConfig = (
    ctx: Window,
    cfg: AuthPaymentConfig | null | undefined
): PaymentConfig => {
    const prev = getActivePaymentConfig(ctx);
    if (!cfg) return prev;
    const next: PaymentConfig = [
        cfg[AUTH_PAYMENT_CONFIG_CHAIN_ID] || prev[PAYMENT_CONFIG_CHAIN_ID],
        (
            cfg[AUTH_PAYMENT_CONFIG_RECIPIENT_ADDRESS] ||
            prev[PAYMENT_CONFIG_RECIPIENT]
        ).toLowerCase(),
        (
            cfg[AUTH_PAYMENT_CONFIG_MIN_PAYMENT_WEI] ||
            prev[PAYMENT_CONFIG_MIN_WEI_HEX]
        ).toLowerCase(),
        cfg[AUTH_PAYMENT_CONFIG_ACCESS_DURATION_SECS] ||
            prev[PAYMENT_CONFIG_DURATION_SECS],
    ];
    configByWindow.set(ctx, next);
    return next;
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

const readProtoResponseTask =
    (ctx: Window, res: Response): Task<Uint8Array> =>
    (resolve, reject) => {
        res.arrayBuffer().then((buf: ArrayBuffer) => {
            const bytes = new ctx.Uint8Array(buf);
            if (!res.ok) {
                const notice = decodePaymentClaimNotice(ctx, bytes);
                const msg = notice
                    ? notice[PAYMENT_CLAIM_NOTICE_MESSAGE].trim()
                    : '';
                reject(
                    new Error(msg || `Request failed with status ${res.status}`)
                );
                return;
            }
            resolve(bytes);
        }, reject);
    };

const fetchProtoTask = (
    ctx: Window,
    url: string,
    init: RequestInit
): Task<Uint8Array> =>
    pipe(
        rawFetchTask(ctx, url, init),
        taskChain(bindArg(ctx, readProtoResponseTask))
    );

const postProtoTask = (
    ctx: Window,
    url: string,
    bodyBytes: Uint8Array
): Task<Uint8Array> =>
    fetchProtoTask(ctx, url, {
        ['method']: 'POST',
        ['headers']: { ['Content-Type']: PROTO_CONTENT_TYPE },
        ['credentials']: 'same-origin',
        ['body']: bodyBytes as unknown as BodyInit,
    });

export const authSessionToStatus = (
    ctx: Window,
    session: AuthSession
): SessionStatus | null => {
    applyPaymentConfig(ctx, session[AUTH_SESSION_PAYMENT_CONFIG]);
    const wallet = session[AUTH_SESSION_WALLET_ADDRESS].trim();
    if (!wallet) return null;
    const nick = session[AUTH_SESSION_NICKNAME].trim();
    return [
        wallet,
        nick || null,
        session[AUTH_SESSION_ACCESS_UNTIL],
        session[AUTH_SESSION_HAS_ACTIVE_ACCESS],
    ];
};

const parseNonceProto = (ctx: Window, bytes: Uint8Array): NonceChallenge => {
    const decoded = decodeNonceResponse(ctx, bytes);
    const nonce = decoded ? decoded[NONCE_RESPONSE_NONCE].trim() : '';
    const wallet = decoded ? decoded[NONCE_RESPONSE_WALLET_ADDRESS].trim() : '';
    const expiresAt = decoded ? decoded[NONCE_RESPONSE_EXPIRES_AT] : 0;
    if (!decoded || !nonce || !wallet || !expiresAt) {
        throw new Error('Invalid nonce challenge response.');
    }
    applyPaymentConfig(ctx, decoded[NONCE_RESPONSE_PAYMENT_CONFIG]);
    return [nonce, wallet, expiresAt];
};

const parseRequiredSessionProto = (
    ctx: Window,
    bytes: Uint8Array
): SessionStatus => {
    const decoded = decodeAuthSession(ctx, bytes);
    const status = decoded ? authSessionToStatus(ctx, decoded) : null;
    if (!status) {
        throw new Error('Invalid session status response.');
    }
    return status;
};

const parseOptionalSessionProto = (
    ctx: Window,
    bytes: Uint8Array
): SessionStatus | null => {
    const decoded = decodeAuthSession(ctx, bytes);
    return decoded ? authSessionToStatus(ctx, decoded) : null;
};

export const fetchNonceTask = (
    ctx: Window,
    walletAddress: string
): Task<NonceChallenge> =>
    pipe(
        postProtoTask(
            ctx,
            '/auth/nonce',
            encodeNonceRequest(ctx, walletAddress)
        ),
        taskMap(bindArg(ctx, parseNonceProto))
    );

export const verifySiweTask = (
    ctx: Window,
    message: string,
    signature: string
): Task<SessionStatus> =>
    pipe(
        postProtoTask(
            ctx,
            '/auth/verify',
            encodeVerifySiweRequest(ctx, message, signature)
        ),
        taskMap(bindArg(ctx, parseRequiredSessionProto))
    );

export const claimPaymentOutcomeMessage = (
    outcome: ClaimPaymentResponsePayload
): string => {
    if (
        outcome[CLAIM_PAYMENT_RESPONSE_PAYLOAD_VARIANT] ===
        CLAIM_PAYMENT_RESPONSE_ACTIVATED
    ) {
        return '';
    }
    return (
        outcome[CLAIM_PAYMENT_RESPONSE_PAYLOAD_VALUE][
            PAYMENT_CLAIM_NOTICE_MESSAGE
        ] || 'Payment claim failed.'
    );
};

const parseClaimPaymentProto = (
    ctx: Window,
    bytes: Uint8Array
): ClaimPaymentResponsePayload => {
    const decoded = decodeClaimPaymentResponse(ctx, bytes);
    if (!decoded) {
        throw new Error('Invalid payment claim response.');
    }
    return decoded;
};

export const claimPaymentProtoTask = (
    ctx: Window,
    txHash: string,
    nickname: string
): Task<ClaimPaymentResponsePayload> =>
    pipe(
        postProtoTask(
            ctx,
            '/auth/claim-payment',
            encodeClaimPaymentRequest(ctx, txHash.trim(), nickname.trim())
        ),
        taskMap(bindArg(ctx, parseClaimPaymentProto))
    );

const requireActivatedOutcome = (
    ctx: Window,
    outcome: ClaimPaymentResponsePayload
): SessionStatus => {
    if (
        outcome[CLAIM_PAYMENT_RESPONSE_PAYLOAD_VARIANT] ===
        CLAIM_PAYMENT_RESPONSE_ACTIVATED
    ) {
        const status = authSessionToStatus(
            ctx,
            outcome[CLAIM_PAYMENT_RESPONSE_PAYLOAD_VALUE]
        );
        if (status) return status;
    }
    throw new Error(claimPaymentOutcomeMessage(outcome));
};

export const claimPaymentTask = (
    ctx: Window,
    txHash: string,
    nickname: string
): Task<SessionStatus> =>
    pipe(
        claimPaymentProtoTask(ctx, txHash, nickname),
        taskMap(bindArg(ctx, requireActivatedOutcome))
    );

export const updateNicknameTask = (
    ctx: Window,
    nickname: string
): Task<SessionStatus> =>
    pipe(
        postProtoTask(
            ctx,
            '/auth/nickname',
            encodeSetNicknameRequest(ctx, nickname.trim())
        ),
        taskMap(bindArg(ctx, parseRequiredSessionProto))
    );

const returnNull = (): null => null;

export const fetchSessionTask = (ctx: Window): Task<SessionStatus | null> =>
    pipe(
        fetchProtoTask(ctx, '/auth/session', {
            ['method']: 'GET',
            ['credentials']: 'same-origin',
        }),
        taskMap(bindArg(ctx, parseOptionalSessionProto)),
        taskCatch(returnNull)
    );
