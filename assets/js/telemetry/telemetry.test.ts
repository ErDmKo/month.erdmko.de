import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    bindArg,
    domDispose,
    noop,
    pipe,
    taskFork,
    trigger,
} from '@month/utils';
import type { DomScope } from '@month/utils';
import * as telemetryModule from '@month/gen/telemetry';
import {
    TELEMETRY_BATCH_EVENTS,
    TELEMETRY_EVENT_CHAIN_ID,
    TELEMETRY_EVENT_CODE,
    TELEMETRY_EVENT_COLUMN,
    TELEMETRY_EVENT_KIND,
    TELEMETRY_EVENT_LINE,
    TELEMETRY_EVENT_MESSAGE,
    TELEMETRY_EVENT_OP,
    TELEMETRY_EVENT_PATH,
    TELEMETRY_EVENT_PROVIDER_FLAGS,
    TELEMETRY_EVENT_SEVERITY,
    TELEMETRY_EVENT_TIMESTAMP_MS,
    TELEMETRY_KIND_UNCAUGHT_ERROR,
    TELEMETRY_KIND_UNHANDLED_REJECTION,
    TELEMETRY_KIND_UNSPECIFIED,
    TELEMETRY_KIND_WALLET_RPC,
    TELEMETRY_KIND_WEBRTC,
    TELEMETRY_KIND_WS,
    TELEMETRY_OP_AUTH_VERIFY,
    TELEMETRY_OP_PERSONAL_SIGN,
    TELEMETRY_OP_VOICE_SIGNALING,
    TELEMETRY_PROVIDER_FLAG_BRAVE,
    TELEMETRY_PROVIDER_FLAG_ETHEREUM,
    TELEMETRY_PROVIDER_FLAG_METAMASK,
    TELEMETRY_PROVIDER_FLAG_NONE,
    TELEMETRY_PROVIDER_FLAG_PHANTOM,
    TELEMETRY_SEVERITY_DEBUG,
    TELEMETRY_SEVERITY_ERROR,
    TELEMETRY_SEVERITY_FATAL,
    TELEMETRY_SEVERITY_INFO,
    TELEMETRY_SEVERITY_TRACE,
    TELEMETRY_SEVERITY_UNSPECIFIED,
    TELEMETRY_SEVERITY_WARN,
    decodeTelemetryBatch,
    decodeTelemetryEvent,
    encodeTelemetryBatch,
    encodeTelemetryEvent,
} from '@month/gen/telemetry';
import type {
    TelemetryEvent,
    TelemetryKind,
    TelemetryOp,
    TelemetrySeverity,
} from '@month/gen/telemetry';
import { createTestWindow } from '../test-window';
import {
    BACKOFF_DELAYS_MS,
    detectProviderFlags,
    EXTRACTED_CODE,
    EXTRACTED_MESSAGE,
    extractErrorInfo,
    initTelemetry,
    MAX_BATCH_EVENTS,
    MAX_CODE_LEN,
    MAX_MSG_LEN,
    MAX_QUEUE_EVENTS,
    TELEMETRY_STORAGE_KEY,
} from './index';
import type { TelemetryInput, TelemetryObs } from './index';

const ctx = createTestWindow();

// Canonical protobuf wire fixture shared with server/src/generated/mod.rs
const EXPECTED_BATCH_WIRE_BYTES = new Uint8Array([
    0x0a,
    0x36, // field 1 (events), length = 54 bytes
    0x08,
    0xfb,
    0xa8,
    0xea,
    0xba,
    0x9d,
    0x34, // field 1 (timestamp_ms) = 1794614400123
    0x10,
    0x11, // field 2 (severity) = ERROR (17)
    0x18,
    0x03, // field 3 (kind) = WALLET_RPC (3)
    0x20,
    0x04, // field 4 (op) = PERSONAL_SIGN (4)
    0x2a,
    0x06,
    0x2d,
    0x33,
    0x32,
    0x30,
    0x30,
    0x30, // field 5 (code) = "-32000"
    0x32,
    0x11,
    0x63,
    0x68,
    0x65,
    0x63,
    0x6b,
    0x73,
    0x75,
    0x6d,
    0x20,
    0x6d,
    0x69,
    0x73,
    0x6d,
    0x61,
    0x74,
    0x63,
    0x68, // field 6 (message) = "checksum mismatch"
    0x3a,
    0x05,
    0x2f,
    0x63,
    0x68,
    0x61,
    0x74, // field 7 (path) = "/chat"
    0x50,
    0xa7,
    0xed,
    0xa8,
    0x05, // field 10 (chain_id) = 11155111
    0x58,
    0x05, // field 11 (provider_flags) = ETHEREUM | PHANTOM (5)
]);

test('telemetry enum constants match OpenTelemetry severity numbers and numeric literals', () => {
    const sev: TelemetrySeverity = TELEMETRY_SEVERITY_ERROR;
    const kind: TelemetryKind = TELEMETRY_KIND_WALLET_RPC;
    const op: TelemetryOp = TELEMETRY_OP_PERSONAL_SIGN;

    assert.equal(TELEMETRY_SEVERITY_UNSPECIFIED, 0);
    assert.equal(TELEMETRY_SEVERITY_TRACE, 1);
    assert.equal(TELEMETRY_SEVERITY_DEBUG, 5);
    assert.equal(TELEMETRY_SEVERITY_INFO, 9);
    assert.equal(TELEMETRY_SEVERITY_WARN, 13);
    assert.equal(sev, 17);
    assert.equal(TELEMETRY_SEVERITY_FATAL, 21);

    assert.equal(TELEMETRY_KIND_UNSPECIFIED, 0);
    assert.equal(TELEMETRY_KIND_UNCAUGHT_ERROR, 1);
    assert.equal(TELEMETRY_KIND_UNHANDLED_REJECTION, 2);
    assert.equal(kind, 3);
    assert.equal(TELEMETRY_KIND_WS, 5);
    assert.equal(TELEMETRY_KIND_WEBRTC, 6);

    assert.equal(op, 4);
    assert.equal(TELEMETRY_OP_AUTH_VERIFY, 8);
    assert.equal(TELEMETRY_OP_VOICE_SIGNALING, 20);

    assert.equal(TELEMETRY_PROVIDER_FLAG_NONE, 0);
    assert.equal(
        TELEMETRY_PROVIDER_FLAG_ETHEREUM |
            TELEMETRY_PROVIDER_FLAG_METAMASK |
            TELEMETRY_PROVIDER_FLAG_PHANTOM |
            TELEMETRY_PROVIDER_FLAG_BRAVE,
        1 | 2 | 4 | 32
    );
});

test('TelemetryEvent and TelemetryBatch match exact Rust prost wire bytes', () => {
    const timestampMs = 1_794_614_400_123;
    const flags =
        TELEMETRY_PROVIDER_FLAG_ETHEREUM | TELEMETRY_PROVIDER_FLAG_PHANTOM;
    const eventTuple: TelemetryEvent = [
        timestampMs,
        TELEMETRY_SEVERITY_ERROR,
        TELEMETRY_KIND_WALLET_RPC,
        TELEMETRY_OP_PERSONAL_SIGN,
        '-32000',
        'checksum mismatch',
        '/chat',
        0,
        0,
        11_155_111,
        flags,
    ];

    const batchBytes = encodeTelemetryBatch(ctx, [eventTuple]);
    assert.deepEqual(batchBytes, EXPECTED_BATCH_WIRE_BYTES);

    const decodedBatch = decodeTelemetryBatch(ctx, batchBytes);
    assert.ok(decodedBatch !== null);
    assert.equal(decodedBatch[TELEMETRY_BATCH_EVENTS].length, 1);

    const ev = decodedBatch[TELEMETRY_BATCH_EVENTS][0];
    assert.equal(ev[TELEMETRY_EVENT_TIMESTAMP_MS], timestampMs);
    assert.equal(ev[TELEMETRY_EVENT_SEVERITY], TELEMETRY_SEVERITY_ERROR);
    assert.equal(ev[TELEMETRY_EVENT_KIND], TELEMETRY_KIND_WALLET_RPC);
    assert.equal(ev[TELEMETRY_EVENT_OP], TELEMETRY_OP_PERSONAL_SIGN);
    assert.equal(ev[TELEMETRY_EVENT_CODE], '-32000');
    assert.equal(ev[TELEMETRY_EVENT_MESSAGE], 'checksum mismatch');
    assert.equal(ev[TELEMETRY_EVENT_PATH], '/chat');
    assert.equal(ev[TELEMETRY_EVENT_LINE], 0);
    assert.equal(ev[TELEMETRY_EVENT_COLUMN], 0);
    assert.equal(ev[TELEMETRY_EVENT_CHAIN_ID], 11_155_111);
    assert.equal(ev[TELEMETRY_EVENT_PROVIDER_FLAGS], 5);
});

test('TelemetryEvent roundtrips line and column fields', () => {
    const now = Date.now();
    const rawEvent = encodeTelemetryEvent(
        ctx,
        now,
        TELEMETRY_SEVERITY_FATAL,
        TELEMETRY_KIND_UNCAUGHT_ERROR,
        0,
        'TypeError',
        'Cannot read properties of null',
        '/chat/general',
        142,
        19,
        0,
        0
    );
    const decodedEvent = decodeTelemetryEvent(ctx, rawEvent);
    assert.ok(decodedEvent !== null);
    assert.equal(decodedEvent[TELEMETRY_EVENT_TIMESTAMP_MS], now);
    assert.equal(
        decodedEvent[TELEMETRY_EVENT_SEVERITY],
        TELEMETRY_SEVERITY_FATAL
    );
    assert.equal(
        decodedEvent[TELEMETRY_EVENT_KIND],
        TELEMETRY_KIND_UNCAUGHT_ERROR
    );
    assert.equal(decodedEvent[TELEMETRY_EVENT_LINE], 142);
    assert.equal(decodedEvent[TELEMETRY_EVENT_COLUMN], 19);
    assert.equal(decodedEvent[TELEMETRY_EVENT_CODE], 'TypeError');
});

test('generated telemetry module exports only numbers and codec functions with zero enum strings', () => {
    const values = Object.values(telemetryModule);
    assert.ok(values.length > 0);
    for (const val of values) {
        assert.ok(
            typeof val === 'number' || typeof val === 'function',
            `unexpected export type: ${typeof val}`
        );
        if (typeof val === 'function') {
            assert.equal(
                /TELEMETRY_(SEVERITY|KIND|OP|PROVIDER_FLAG)_/.test(
                    val.toString()
                ),
                false
            );
        }
    }
});

// ── TELEM-30: happy-dom Window + localStorage + Fake fetch harness ───────────

type PendingFetch = {
    url: string;
    init: RequestInit;
    body: Uint8Array;
    respond: (status: number) => void;
    fail: (err?: unknown) => void;
};

type TimerTask = {
    id: number;
    delayMs: number;
    fn: () => void;
};

const createTelemetryTestEnv = (options?: {
    initialStorage?: string;
    throwStorageGetter?: boolean;
    throwStorageWrite?: boolean;
    online?: boolean;
    pathname?: string;
    ethereum?: Record<string, unknown>;
}) => {
    let nowMs = 1_794_614_400_000;
    let online = options?.online ?? true;
    let nextTimerId = 1;
    const timers = new Map<number, TimerTask>();
    const requests: PendingFetch[] = [];

    const mockFetch = (
        url: string,
        init: RequestInit = {}
    ): Promise<Response> => {
        let resolveRes!: (res: Response) => void;
        let rejectRes!: (err: unknown) => void;
        const promise = new Promise<Response>((res, rej) => {
            resolveRes = res;
            rejectRes = rej;
        });
        let settledStatus: number | null = null;
        let settledErr: { err: unknown } | null = null;
        const onSuccessCbs: Array<(res: Response) => void> = [];
        const onErrorCbs: Array<(err: unknown) => void> = [];

        const syncThenable = {
            then(
                onFulfilled?: (res: Response) => unknown,
                onRejected?: (err: unknown) => unknown
            ) {
                if (settledStatus !== null) {
                    onFulfilled?.({ status: settledStatus } as Response);
                } else if (settledErr !== null) {
                    onRejected?.(settledErr.err);
                } else {
                    if (onFulfilled) onSuccessCbs.push(onFulfilled);
                    if (onRejected) onErrorCbs.push(onRejected);
                }
                return promise;
            },
        };

        requests.push({
            url,
            init,
            body: new Uint8Array(init.body as unknown as Uint8Array),
            respond: (status: number) => {
                settledStatus = status;
                const res = { status } as Response;
                resolveRes(res);
                for (const cb of onSuccessCbs) cb(res);
            },
            fail: (err: unknown = new TypeError('Failed to fetch')) => {
                settledErr = { err };
                promise.catch(noop);
                rejectRes(err);
                for (const cb of onErrorCbs) cb(err);
            },
        });

        return syncThenable as unknown as Promise<Response>;
    };

    const win = createTestWindow({
        url: `https://erdmko.dev${options?.pathname ?? '/chat'}`,
        overrides: {
            Date: Object.assign(Date, { now: () => nowMs }),
            ethereum: options?.ethereum,
            fetch: mockFetch,
            setTimeout: (fn: () => void, delayMs = 0) => {
                const id = nextTimerId++;
                timers.set(id, { id, delayMs, fn });
                return id;
            },
            clearTimeout: (id: number) => {
                timers.delete(id);
            },
        },
    });

    Object.defineProperty(win.navigator, 'onLine', {
        get: () => online,
        configurable: true,
    });

    if (options?.initialStorage !== undefined) {
        win.localStorage.setItem(TELEMETRY_STORAGE_KEY, options.initialStorage);
    }

    if (options?.throwStorageGetter) {
        Object.defineProperty(win, 'localStorage', {
            get() {
                throw new Error('SecurityError');
            },
            configurable: true,
        });
    } else if (options?.throwStorageWrite) {
        win.localStorage.setItem = () => {
            throw new Error('QuotaExceededError');
        };
    }

    return {
        ctx: win,
        requests,
        timers,
        advanceTime: (deltaMs: number) => {
            nowMs += deltaMs;
        },
        setOnline: (next: boolean) => {
            online = next;
            if (next) {
                win.dispatchEvent(new win.Event('online'));
            }
        },
        dispatchWindowEvent: (
            type: string,
            fields: Record<string, unknown>
        ) => {
            const ev = Object.assign(new win.Event(type), fields);
            win.dispatchEvent(ev);
        },
        runNextTimer: () => {
            const first = timers.values().next().value as TimerTask | undefined;
            if (!first) return null;
            timers.delete(first.id);
            first.fn();
            return first.delayMs;
        },
    };
};

const mountTelemetry = (
    envCtx: Window,
    scope: DomScope,
    chainId = 0,
    dedupMs = 5000
): TelemetryObs => {
    let obs!: TelemetryObs;
    pipe(
        initTelemetry(
            envCtx,
            () => chainId,
            scope,
            undefined,
            TELEMETRY_STORAGE_KEY,
            dedupMs
        ),
        taskFork((resolved: TelemetryObs) => {
            obs = resolved;
        }, noop)
    );
    return obs;
};

const emit = (obs: TelemetryObs, input: TelemetryInput): void => {
    obs(bindArg(input, trigger));
};

test('clean page load with empty localStorage sends zero fetch requests', () => {
    const env = createTelemetryTestEnv({ online: true });
    const scope: DomScope = [];
    mountTelemetry(env.ctx, scope);

    assert.equal(env.requests.length, 0);
    assert.equal(
        Boolean(env.ctx.localStorage.getItem(TELEMETRY_STORAGE_KEY)),
        false
    );
    domDispose(scope);
});

test('offline enqueue persists Protobuf events in localStorage across reload, survives network/503 failure, and purges on 204', () => {
    const env1 = createTelemetryTestEnv({
        online: false,
        ethereum: { isPhantom: true },
    });
    const scope1: DomScope = [];
    const obs1 = mountTelemetry(env1.ctx, scope1, 1);

    emit(obs1, [
        TELEMETRY_SEVERITY_ERROR,
        TELEMETRY_KIND_WALLET_RPC,
        TELEMETRY_OP_PERSONAL_SIGN,
        { code: -32000, message: 'checksum mismatch' },
    ]);
    emit(obs1, [
        TELEMETRY_SEVERITY_WARN,
        TELEMETRY_KIND_WEBRTC,
        TELEMETRY_OP_VOICE_SIGNALING,
        'room full',
        'VOICE_ROOM_FULL',
    ]);

    assert.equal(env1.requests.length, 0);
    const persistedHex = env1.ctx.localStorage.getItem(TELEMETRY_STORAGE_KEY);
    assert.ok(persistedHex);
    domDispose(scope1);

    // Simulate page reload while still offline -> hydrates 2 records, still 0 requests
    const env2 = createTelemetryTestEnv({
        initialStorage: persistedHex,
        online: false,
    });
    const scope2: DomScope = [];
    mountTelemetry(env2.ctx, scope2, 1);
    assert.equal(env2.requests.length, 0);

    // Connectivity returns -> POST /telemetry with keepalive + application/x-protobuf
    env2.setOnline(true);
    assert.equal(env2.requests.length, 1);
    assert.equal(env2.requests[0].url, '/telemetry');
    assert.equal(env2.requests[0].init.method, 'POST');
    assert.equal(env2.requests[0].init.keepalive, true);

    const sentBatch1 = decodeTelemetryBatch(env2.ctx, env2.requests[0].body);
    assert.ok(sentBatch1 !== null);
    assert.equal(sentBatch1[TELEMETRY_BATCH_EVENTS].length, 2);
    assert.equal(
        sentBatch1[TELEMETRY_BATCH_EVENTS][0][TELEMETRY_EVENT_CODE],
        '-32000'
    );
    assert.equal(
        sentBatch1[TELEMETRY_BATCH_EVENTS][0][TELEMETRY_EVENT_PROVIDER_FLAGS],
        TELEMETRY_PROVIDER_FLAG_ETHEREUM | TELEMETRY_PROVIDER_FLAG_PHANTOM
    );

    // Network drop mid-flight -> localStorage stays intact + backoff[0] scheduled
    env2.requests[0].fail();
    assert.equal(
        Boolean(env2.ctx.localStorage.getItem(TELEMETRY_STORAGE_KEY)),
        true
    );
    assert.equal(env2.runNextTimer(), BACKOFF_DELAYS_MS[0]);

    // Retry receives 503 -> localStorage still intact + backoff[1] scheduled
    assert.equal(env2.requests.length, 2);
    env2.requests[1].respond(503);
    assert.equal(
        Boolean(env2.ctx.localStorage.getItem(TELEMETRY_STORAGE_KEY)),
        true
    );
    assert.equal(env2.runNextTimer(), BACKOFF_DELAYS_MS[1]);

    // Third attempt receives 204 No Content -> purges localStorage
    assert.equal(env2.requests.length, 3);
    env2.requests[2].respond(204);
    assert.equal(
        Boolean(env2.ctx.localStorage.getItem(TELEMETRY_STORAGE_KEY)),
        false
    );
    domDispose(scope2);
});

test('multi-batch sequential drain coalesces concurrent bursts while POST is in flight', () => {
    const env = createTelemetryTestEnv({ online: true });
    const scope: DomScope = [];
    const obs = mountTelemetry(env.ctx, scope, 0, 5000);

    const totalEvents = 1 + MAX_BATCH_EVENTS * 2 + 4;
    for (let i = 0; i < totalEvents; i++) {
        emit(obs, [
            TELEMETRY_SEVERITY_WARN,
            TELEMETRY_KIND_WS,
            0,
            `msg ${i}`,
            `E_${i}`,
        ]);
    }

    // First event dispatches immediately with keepalive; remaining 24 coalesce behind inFlight
    assert.equal(env.requests.length, 1);
    const batch1 = decodeTelemetryBatch(env.ctx, env.requests[0].body)!;
    assert.equal(batch1[TELEMETRY_BATCH_EVENTS].length, 1);

    env.requests[0].respond(204);
    assert.equal(env.requests.length, 2);
    const batch2 = decodeTelemetryBatch(env.ctx, env.requests[1].body)!;
    assert.equal(batch2[TELEMETRY_BATCH_EVENTS].length, MAX_BATCH_EVENTS);

    env.requests[1].respond(204);
    assert.equal(env.requests.length, 3);
    const batch3 = decodeTelemetryBatch(env.ctx, env.requests[2].body)!;
    assert.equal(batch3[TELEMETRY_BATCH_EVENTS].length, MAX_BATCH_EVENTS);

    env.requests[2].respond(204);
    assert.equal(env.requests.length, 4);
    const batch4 = decodeTelemetryBatch(env.ctx, env.requests[3].body)!;
    assert.equal(batch4[TELEMETRY_BATCH_EVENTS].length, 4);

    env.requests[3].respond(204);
    assert.equal(
        Boolean(env.ctx.localStorage.getItem(TELEMETRY_STORAGE_KEY)),
        false
    );
    assert.equal(env.timers.size, 0);

    // Subsequent error sends a fresh POST /telemetry immediately
    emit(obs, [
        TELEMETRY_SEVERITY_ERROR,
        TELEMETRY_KIND_UNCAUGHT_ERROR,
        0,
        new ReferenceError('x is not defined'),
    ]);
    assert.equal(env.requests.length, 5);
    domDispose(scope);
});

test('queue cap evicts oldest entries at 64 and truncates oversized code/message fields', () => {
    const env = createTelemetryTestEnv({ online: false });
    const scope: DomScope = [];
    const obs = mountTelemetry(env.ctx, scope, 0, 0);

    for (let i = 1; i <= MAX_QUEUE_EVENTS + 6; i++) {
        emit(obs, [
            TELEMETRY_SEVERITY_WARN,
            TELEMETRY_KIND_WS,
            0,
            `item-${i}-${'x'.repeat(400)}`,
            `${'C'.repeat(80)}_${i}`,
        ]);
    }

    env.setOnline(true);
    const firstSent = decodeTelemetryBatch(env.ctx, env.requests[0].body)!;
    assert.equal(firstSent[TELEMETRY_BATCH_EVENTS].length, MAX_BATCH_EVENTS);
    // First 6 entries (1..6) were evicted; oldest remaining entry starts with "item-7-"
    assert.ok(
        firstSent[TELEMETRY_BATCH_EVENTS][0][
            TELEMETRY_EVENT_MESSAGE
        ].startsWith('item-7-')
    );
    assert.equal(
        firstSent[TELEMETRY_BATCH_EVENTS][0][TELEMETRY_EVENT_CODE].length,
        MAX_CODE_LEN
    );
    assert.equal(
        firstSent[TELEMETRY_BATCH_EVENTS][0][TELEMETRY_EVENT_MESSAGE].length,
        MAX_MSG_LEN
    );
    domDispose(scope);
});

test('throwing localStorage getter or setter falls back to in-memory queue and deduplicates bursts', () => {
    for (const opts of [
        { throwStorageGetter: true },
        { throwStorageWrite: true },
    ] as const) {
        const env = createTelemetryTestEnv({ ...opts, online: true });
        const scope: DomScope = [];
        const obs = mountTelemetry(env.ctx, scope, 1, 5000);

        const rejectedInput: TelemetryInput = [
            TELEMETRY_SEVERITY_WARN,
            TELEMETRY_KIND_WALLET_RPC,
            TELEMETRY_OP_PERSONAL_SIGN,
            { code: 4001, message: 'User rejected the request.' },
        ];
        emit(obs, rejectedInput);
        emit(obs, rejectedInput);

        assert.equal(env.requests.length, 1);
        const batch = decodeTelemetryBatch(env.ctx, env.requests[0].body)!;
        assert.equal(batch[TELEMETRY_BATCH_EVENTS].length, 1);

        env.requests[0].respond(204);

        // After 5001ms cooldown, identical error is recorded again
        env.advanceTime(5001);
        emit(obs, rejectedInput);
        assert.equal(env.requests.length, 2);
        domDispose(scope);
    }
});

test('global error & unhandledrejection hooks, extractErrorInfo, and detectProviderFlags work via validate', () => {
    const env = createTelemetryTestEnv({
        online: true,
        pathname: '/chat/general',
        ethereum: { isMetaMask: true, isRabby: true },
    });
    const scope: DomScope = [];
    mountTelemetry(env.ctx, scope, 11155111);

    assert.equal(
        detectProviderFlags(env.ctx),
        TELEMETRY_PROVIDER_FLAG_ETHEREUM |
            TELEMETRY_PROVIDER_FLAG_METAMASK |
            telemetryModule.TELEMETRY_PROVIDER_FLAG_RABBY
    );

    const extractedObj = extractErrorInfo(
        env.ctx,
        { code: -32603 },
        'fallback'
    );
    assert.equal(extractedObj[EXTRACTED_CODE], '-32603');
    assert.equal(extractedObj[EXTRACTED_MESSAGE], '{"code":-32603}');

    // Go offline briefly so both events batch into one POST
    env.setOnline(false);
    env.dispatchWindowEvent('error', {
        message: 'Uncaught TypeError: boom',
        lineno: 42,
        colno: 9,
        error: new TypeError('boom'),
    });
    env.dispatchWindowEvent('unhandledrejection', {
        reason: { code: 'E_ASYNC', data: { message: 'nested failure' } },
    });

    env.setOnline(true);
    assert.equal(env.requests.length, 1);
    const sent = decodeTelemetryBatch(env.ctx, env.requests[0].body)!;
    assert.equal(sent[TELEMETRY_BATCH_EVENTS].length, 2);

    const errEv = sent[TELEMETRY_BATCH_EVENTS][0];
    assert.equal(errEv[TELEMETRY_EVENT_KIND], TELEMETRY_KIND_UNCAUGHT_ERROR);
    assert.equal(errEv[TELEMETRY_EVENT_CODE], 'TypeError');
    assert.equal(errEv[TELEMETRY_EVENT_MESSAGE], 'boom');
    assert.equal(errEv[TELEMETRY_EVENT_LINE], 42);
    assert.equal(errEv[TELEMETRY_EVENT_COLUMN], 9);
    assert.equal(errEv[TELEMETRY_EVENT_PATH], '/chat/general');
    assert.equal(errEv[TELEMETRY_EVENT_CHAIN_ID], 11155111);

    const rejEv = sent[TELEMETRY_BATCH_EVENTS][1];
    assert.equal(
        rejEv[TELEMETRY_EVENT_KIND],
        TELEMETRY_KIND_UNHANDLED_REJECTION
    );
    assert.equal(rejEv[TELEMETRY_EVENT_CODE], 'E_ASYNC');
    assert.equal(rejEv[TELEMETRY_EVENT_MESSAGE], 'nested failure');

    domDispose(scope);
});
