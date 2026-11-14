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
    TELEMETRY_ACK_ACK_ID,
    TELEMETRY_BATCH_ACK_ID,
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
    decodeTelemetryAck,
    decodeTelemetryBatch,
    decodeTelemetryEvent,
    encodeTelemetryAck,
    encodeTelemetryBatch,
    encodeTelemetryEvent,
} from '@month/gen/telemetry';
import type {
    TelemetryEvent,
    TelemetryKind,
    TelemetryOp,
    TelemetrySeverity,
} from '@month/gen/telemetry';
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

const ctx = {
    TextEncoder,
    TextDecoder,
    Uint8Array,
} as unknown as Window;

// Canonical protobuf wire fixture shared with server/src/generated/mod.rs
const EXPECTED_BATCH_WIRE_BYTES = new Uint8Array([
    0x08,
    0x07, // field 1 (ack_id) = 7
    0x12,
    0x36, // field 2 (events), length = 54 bytes
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

    const batchBytes = encodeTelemetryBatch(ctx, 7, [eventTuple]);
    assert.deepEqual(batchBytes, EXPECTED_BATCH_WIRE_BYTES);

    const decodedBatch = decodeTelemetryBatch(ctx, batchBytes);
    assert.ok(decodedBatch !== null);
    assert.equal(decodedBatch[TELEMETRY_BATCH_ACK_ID], 7);
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

test('TelemetryEvent roundtrips line/column and TelemetryAck roundtrips ack_id', () => {
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

    const ackBytes = encodeTelemetryAck(ctx, 4096);
    assert.deepEqual(ackBytes, new Uint8Array([0x08, 0x80, 0x20]));
    const decodedAck = decodeTelemetryAck(ctx, ackBytes);
    assert.ok(decodedAck !== null);
    assert.equal(decodedAck[TELEMETRY_ACK_ACK_ID], 4096);
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

// ── TELEM-30: Observer + Task + localStorage + Fake WebSocket harness ────────

type FakeSocketRecord = {
    url: string;
    readyState: number;
    binaryType: string;
    sent: Uint8Array[];
    closed: boolean;
    onopen: (() => void) | null;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onerror: (() => void) | null;
    onclose: (() => void) | null;
    open: () => void;
    receive: (buf: Uint8Array) => void;
    drop: () => void;
    close: () => void;
};

type TimerTask = {
    id: number;
    delayMs: number;
    fn: () => void;
};

const createMockTelemetryEnv = (options?: {
    storageMap?: Map<string, string> | null;
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
    const sockets: FakeSocketRecord[] = [];
    const listeners = new Map<string, Set<(ev?: unknown) => void>>();
    const storageMap =
        options?.storageMap === undefined
            ? new Map<string, string>()
            : options.storageMap;

    class MockWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        url: string;
        readyState = 0;
        binaryType = 'blob';
        sent: Uint8Array[] = [];
        closed = false;
        onopen: (() => void) | null = null;
        onmessage: ((ev: { data: unknown }) => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: (() => void) | null = null;

        constructor(url: string) {
            this.url = url;
            sockets.push(this as unknown as FakeSocketRecord);
        }
        send(data: Uint8Array) {
            this.sent.push(new Uint8Array(data));
        }
        open() {
            this.readyState = 1;
            this.onopen?.();
        }
        receive(buf: Uint8Array) {
            this.onmessage?.({
                data: buf.buffer.slice(
                    buf.byteOffset,
                    buf.byteOffset + buf.byteLength
                ),
            });
        }
        drop() {
            this.readyState = 3;
            this.closed = true;
            this.onerror?.();
            this.onclose?.();
        }
        close() {
            this.readyState = 3;
            this.closed = true;
            this.onclose?.();
        }
    }

    const storageObj =
        storageMap === null
            ? undefined
            : {
                  getItem: (key: string) => storageMap.get(key) ?? null,
                  setItem: (key: string, val: string) => {
                      if (options?.throwStorageWrite) {
                          throw new Error('QuotaExceededError');
                      }
                      storageMap.set(key, val);
                  },
                  removeItem: (key: string) => {
                      storageMap.delete(key);
                  },
              };

    const mockCtx: Record<string, unknown> = {
        JSON,
        TextEncoder,
        TextDecoder,
        Uint8Array,
        ArrayBuffer,
        Date: { now: () => nowMs },
        location: {
            protocol: 'https:',
            host: 'erdmko.dev',
            pathname: options?.pathname ?? '/chat',
        },
        navigator: {
            get onLine() {
                return online;
            },
        },
        ethereum: options?.ethereum,
        WebSocket: MockWebSocket,
        setTimeout: (fn: () => void, delayMs = 0) => {
            const id = nextTimerId++;
            timers.set(id, { id, delayMs, fn });
            return id;
        },
        clearTimeout: (id: number) => {
            timers.delete(id);
        },
        addEventListener: (event: string, fn: (ev?: unknown) => void) => {
            let set = listeners.get(event);
            if (!set) {
                set = new Set();
                listeners.set(event, set);
            }
            set.add(fn);
        },
        removeEventListener: (event: string, fn: (ev?: unknown) => void) => {
            listeners.get(event)?.delete(fn);
        },
    };

    if (options?.throwStorageGetter) {
        Object.defineProperty(mockCtx, 'localStorage', {
            get() {
                throw new Error('SecurityError');
            },
        });
    } else if (storageObj !== undefined) {
        mockCtx['localStorage'] = storageObj;
    }

    return {
        ctx: mockCtx as unknown as Window,
        storageMap,
        sockets,
        timers,
        advanceTime: (deltaMs: number) => {
            nowMs += deltaMs;
        },
        setOnline: (next: boolean) => {
            online = next;
            if (next) {
                for (const fn of listeners.get('online') ?? []) fn();
            }
        },
        dispatchWindowEvent: (type: string, ev: unknown) => {
            for (const fn of listeners.get(type) ?? []) fn(ev);
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
    idleMs = 1000,
    dedupMs = 5000
): TelemetryObs => {
    let obs!: TelemetryObs;
    pipe(
        initTelemetry(
            envCtx,
            () => chainId,
            scope,
            TELEMETRY_STORAGE_KEY,
            idleMs,
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

test('clean page load with empty localStorage opens zero WebSockets', () => {
    const env = createMockTelemetryEnv({ online: true });
    const scope: DomScope = [];
    mountTelemetry(env.ctx, scope);

    assert.equal(env.sockets.length, 0);
    assert.equal(Boolean(env.storageMap?.get(TELEMETRY_STORAGE_KEY)), false);
    domDispose(scope);
});

test('offline enqueue persists Protobuf TelemetryBatch in localStorage across reload, survives WS drop before ACK, and purges only on TelemetryAck', () => {
    const sharedStorage = new Map<string, string>();
    const env1 = createMockTelemetryEnv({
        storageMap: sharedStorage,
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

    assert.equal(env1.sockets.length, 0);
    assert.equal(Boolean(sharedStorage.get(TELEMETRY_STORAGE_KEY)), true);
    domDispose(scope1);

    // Simulate page reload while still offline -> hydrates 2 records, still 0 sockets
    const env2 = createMockTelemetryEnv({
        storageMap: sharedStorage,
        online: false,
    });
    const scope2: DomScope = [];
    mountTelemetry(env2.ctx, scope2, 1);
    assert.equal(env2.sockets.length, 0);

    // Connectivity returns -> opens wss://erdmko.dev/ws/telemetry and sends batch
    env2.setOnline(true);
    assert.equal(env2.sockets.length, 1);
    assert.equal(env2.sockets[0].url, 'wss://erdmko.dev/ws/telemetry');

    env2.sockets[0].open();
    assert.equal(env2.sockets[0].sent.length, 1);
    const sentBatch1 = decodeTelemetryBatch(env2.ctx, env2.sockets[0].sent[0]);
    assert.ok(sentBatch1 !== null);
    assert.equal(sentBatch1[TELEMETRY_BATCH_ACK_ID], 2);
    assert.equal(sentBatch1[TELEMETRY_BATCH_EVENTS].length, 2);
    assert.equal(
        sentBatch1[TELEMETRY_BATCH_EVENTS][0][TELEMETRY_EVENT_CODE],
        '-32000'
    );
    assert.equal(
        sentBatch1[TELEMETRY_BATCH_EVENTS][0][TELEMETRY_EVENT_PROVIDER_FLAGS],
        TELEMETRY_PROVIDER_FLAG_ETHEREUM | TELEMETRY_PROVIDER_FLAG_PHANTOM
    );

    // Socket drops mid-flight BEFORE TelemetryAck -> localStorage stays intact + backoff scheduled
    env2.sockets[0].drop();
    assert.equal(Boolean(sharedStorage.get(TELEMETRY_STORAGE_KEY)), true);
    const delay = env2.runNextTimer();
    assert.equal(delay, BACKOFF_DELAYS_MS[0]);

    // Reconnected socket re-sends batch and receives TelemetryAck(2) -> purges localStorage
    assert.equal(env2.sockets.length, 2);
    env2.sockets[1].open();
    assert.equal(env2.sockets[1].sent.length, 1);
    env2.sockets[1].receive(encodeTelemetryAck(env2.ctx, 2));

    assert.equal(Boolean(sharedStorage.get(TELEMETRY_STORAGE_KEY)), false);
    domDispose(scope2);
});

test('multi-batch drain, idle WebSocket teardown, and lazy re-open on later error', () => {
    const env = createMockTelemetryEnv({ online: true });
    const scope: DomScope = [];
    const obs = mountTelemetry(env.ctx, scope, 0, 250, 5000);

    const totalEvents = MAX_BATCH_EVENTS * 2 + 4;
    for (let i = 0; i < totalEvents; i++) {
        emit(obs, [
            TELEMETRY_SEVERITY_WARN,
            TELEMETRY_KIND_WS,
            0,
            `msg ${i}`,
            `E_${i}`,
        ]);
    }

    assert.equal(env.sockets.length, 1);
    env.sockets[0].open();
    assert.equal(env.sockets[0].sent.length, 1);

    const batch1 = decodeTelemetryBatch(env.ctx, env.sockets[0].sent[0])!;
    assert.equal(batch1[TELEMETRY_BATCH_EVENTS].length, MAX_BATCH_EVENTS);
    assert.equal(batch1[TELEMETRY_BATCH_ACK_ID], MAX_BATCH_EVENTS);

    env.sockets[0].receive(encodeTelemetryAck(env.ctx, MAX_BATCH_EVENTS));
    assert.equal(env.sockets[0].sent.length, 2);

    const batch2 = decodeTelemetryBatch(env.ctx, env.sockets[0].sent[1])!;
    assert.equal(batch2[TELEMETRY_BATCH_EVENTS].length, MAX_BATCH_EVENTS);
    assert.equal(batch2[TELEMETRY_BATCH_ACK_ID], MAX_BATCH_EVENTS * 2);

    env.sockets[0].receive(encodeTelemetryAck(env.ctx, MAX_BATCH_EVENTS * 2));
    assert.equal(env.sockets[0].sent.length, 3);

    const batch3 = decodeTelemetryBatch(env.ctx, env.sockets[0].sent[2])!;
    assert.equal(batch3[TELEMETRY_BATCH_EVENTS].length, 4);
    assert.equal(batch3[TELEMETRY_BATCH_ACK_ID], totalEvents);

    // Acking final batch empties queue & storage, and arms 250ms idle close timer
    env.sockets[0].receive(encodeTelemetryAck(env.ctx, totalEvents));
    assert.equal(Boolean(env.storageMap?.get(TELEMETRY_STORAGE_KEY)), false);
    assert.equal(env.sockets[0].closed, false);

    const idleDelay = env.runNextTimer();
    assert.equal(idleDelay, 250);
    assert.equal(env.sockets[0].closed, true);

    // Subsequent error lazily opens a brand-new WebSocket
    emit(obs, [
        TELEMETRY_SEVERITY_ERROR,
        TELEMETRY_KIND_UNCAUGHT_ERROR,
        0,
        new ReferenceError('x is not defined'),
    ]);
    assert.equal(env.sockets.length, 2);
    domDispose(scope);
});

test('queue cap evicts oldest entries at 64 and truncates oversized code/message fields', () => {
    const sharedStorage = new Map<string, string>();
    const env = createMockTelemetryEnv({
        storageMap: sharedStorage,
        online: false,
    });
    const scope: DomScope = [];
    const obs = mountTelemetry(env.ctx, scope, 0, 1000, 0);

    for (let i = 1; i <= 70; i++) {
        emit(obs, [
            TELEMETRY_SEVERITY_WARN,
            TELEMETRY_KIND_WS,
            0,
            `${'x'.repeat(400)}-${i}`,
            `${'C'.repeat(80)}_${i}`,
        ]);
    }

    env.setOnline(true);
    env.sockets[0].open();
    const firstSent = decodeTelemetryBatch(env.ctx, env.sockets[0].sent[0])!;
    assert.equal(firstSent[TELEMETRY_BATCH_EVENTS].length, MAX_BATCH_EVENTS);
    // First 6 entries (1..6) were evicted; oldest remaining entry is #7 (ack_id of first 10 = 16)
    assert.equal(firstSent[TELEMETRY_BATCH_ACK_ID], 6 + MAX_BATCH_EVENTS);
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

test('missing or throwing localStorage falls back to in-memory queue and deduplicates bursts', () => {
    for (const opts of [
        { storageMap: null },
        { throwStorageGetter: true },
        { throwStorageWrite: true },
    ] as const) {
        const env = createMockTelemetryEnv({ ...opts, online: true });
        const scope: DomScope = [];
        const obs = mountTelemetry(env.ctx, scope, 1, 1000, 5000);

        const rejectedInput: TelemetryInput = [
            TELEMETRY_SEVERITY_WARN,
            TELEMETRY_KIND_WALLET_RPC,
            TELEMETRY_OP_PERSONAL_SIGN,
            { code: 4001, message: 'User rejected the request.' },
        ];
        emit(obs, rejectedInput);
        emit(obs, rejectedInput);

        assert.equal(env.sockets.length, 1);
        env.sockets[0].open();
        assert.equal(env.sockets[0].sent.length, 1);
        const batch = decodeTelemetryBatch(env.ctx, env.sockets[0].sent[0])!;
        assert.equal(batch[TELEMETRY_BATCH_EVENTS].length, 1);

        env.sockets[0].receive(encodeTelemetryAck(env.ctx, 1));

        // After 5001ms cooldown, identical error is recorded again
        env.advanceTime(5001);
        emit(obs, rejectedInput);
        assert.equal(env.sockets[0].sent.length, 2);
        domDispose(scope);
    }
});

test('global error & unhandledrejection hooks, extractErrorInfo, and detectProviderFlags work via validate', () => {
    const env = createMockTelemetryEnv({
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

    env.dispatchWindowEvent('error', {
        message: 'Uncaught TypeError: boom',
        lineno: 42,
        colno: 9,
        error: new TypeError('boom'),
    });
    env.dispatchWindowEvent('unhandledrejection', {
        reason: { code: 'E_ASYNC', data: { message: 'nested failure' } },
    });

    assert.equal(env.sockets.length, 1);
    env.sockets[0].open();
    const sent = decodeTelemetryBatch(env.ctx, env.sockets[0].sent[0])!;
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
