import { test } from 'node:test';
import * as assert from 'node:assert/strict';
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
    CLIENT_QUEUE,
    CLIENT_WS,
    createIdbTelemetryStorage,
    createTelemetryClient,
    disposeTelemetryClient,
    MAX_BATCH_EVENTS,
    MAX_QUEUE_BYTES,
    MAX_QUEUE_EVENTS,
    QUEUE_ENTRIES,
    QUEUE_ENTRY_ID,
    queueEntryCount,
    queueTotalBytes,
    reportTelemetryEvent,
} from './index';

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

// ── TELEM-30: Fake IndexedDB + Fake WebSocket + Fake Timer harness ────────────

type FakeIdbBacking = {
    nextKey: number;
    records: Map<number, Uint8Array>;
};

const createFakeIdbBacking = (): FakeIdbBacking => ({
    nextKey: 1,
    records: new Map(),
});

const createFakeIdbFactory = (backing: FakeIdbBacking): IDBFactory => {
    const storeNames = new Set<string>(['q']);
    const db = {
        objectStoreNames: {
            contains: (name: string) => storeNames.has(name),
        },
        createObjectStore: (name: string) => {
            storeNames.add(name);
            return {};
        },
        transaction: () => {
            let pendingOps = 0;
            let completeScheduled = false;
            const scheduleComplete = () => {
                if (pendingOps === 0 && !completeScheduled) {
                    completeScheduled = true;
                    queueMicrotask(() => {
                        txObj.oncomplete?.();
                    });
                }
            };
            const txObj: {
                oncomplete: (() => void) | null;
                onerror: (() => void) | null;
                onabort: (() => void) | null;
                error: unknown;
                objectStore: () => unknown;
            } = {
                oncomplete: null,
                onerror: null,
                onabort: null,
                error: null,
                objectStore: () => ({
                    put: (value: Uint8Array, key: number) => {
                        pendingOps++;
                        const req: {
                            result: number;
                            onsuccess: (() => void) | null;
                        } = {
                            result: key,
                            onsuccess: null,
                        };
                        queueMicrotask(() => {
                            if (key >= backing.nextKey) {
                                backing.nextKey = key + 1;
                            }
                            backing.records.set(key, new Uint8Array(value));
                            req.onsuccess?.();
                            pendingOps--;
                            scheduleComplete();
                        });
                        return req;
                    },
                    add: (value: Uint8Array) => {
                        pendingOps++;
                        const req: {
                            result: number;
                            onsuccess: (() => void) | null;
                        } = {
                            result: 0,
                            onsuccess: null,
                        };
                        queueMicrotask(() => {
                            const id = backing.nextKey++;
                            backing.records.set(id, new Uint8Array(value));
                            req.result = id;
                            req.onsuccess?.();
                            pendingOps--;
                            scheduleComplete();
                        });
                        return req;
                    },
                    delete: (keyOrRange: number | { __upperBound: number }) => {
                        pendingOps++;
                        queueMicrotask(() => {
                            if (typeof keyOrRange === 'number') {
                                backing.records.delete(keyOrRange);
                            } else if (
                                keyOrRange &&
                                typeof keyOrRange.__upperBound === 'number'
                            ) {
                                for (const k of [...backing.records.keys()]) {
                                    if (k <= keyOrRange.__upperBound) {
                                        backing.records.delete(k);
                                    }
                                }
                            }
                            pendingOps--;
                            scheduleComplete();
                        });
                        return {};
                    },
                    openCursor: () => {
                        const keys = [...backing.records.keys()].sort(
                            (a, b) => a - b
                        );
                        let idx = 0;
                        const req: {
                            result: unknown;
                            onsuccess: (() => void) | null;
                            onerror: (() => void) | null;
                        } = {
                            result: null,
                            onsuccess: null,
                            onerror: null,
                        };
                        const step = () => {
                            queueMicrotask(() => {
                                while (
                                    idx < keys.length &&
                                    !backing.records.has(keys[idx])
                                ) {
                                    idx++;
                                }
                                if (idx >= keys.length) {
                                    req.result = null;
                                    req.onsuccess?.();
                                    return;
                                }
                                const k = keys[idx++];
                                req.result = {
                                    key: k,
                                    value: backing.records.get(k)!,
                                    continue: step,
                                };
                                req.onsuccess?.();
                            });
                        };
                        step();
                        return req;
                    },
                }),
            };
            return txObj;
        },
        close: () => {},
    };

    return {
        open: () => {
            const req: {
                result: unknown;
                error: unknown;
                onupgradeneeded: (() => void) | null;
                onsuccess: (() => void) | null;
                onerror: (() => void) | null;
                onblocked: (() => void) | null;
            } = {
                result: db,
                error: null,
                onupgradeneeded: null,
                onsuccess: null,
                onerror: null,
                onblocked: null,
            };
            queueMicrotask(() => {
                req.onupgradeneeded?.();
                req.onsuccess?.();
            });
            return req;
        },
    } as unknown as IDBFactory;
};

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
    backing?: FakeIdbBacking | null;
    failIdbOpen?: boolean;
    online?: boolean;
}) => {
    let nowMs = 1_794_614_400_000;
    let online = options?.online ?? true;
    let nextTimerId = 1;
    const timers = new Map<number, TimerTask>();
    const sockets: FakeSocketRecord[] = [];
    const listeners = new Map<string, Set<() => void>>();

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

    const idbProp = options?.failIdbOpen
        ? ({
              open: () => {
                  const req: {
                      error: Error;
                      onupgradeneeded: (() => void) | null;
                      onsuccess: (() => void) | null;
                      onerror: (() => void) | null;
                      onblocked: (() => void) | null;
                  } = {
                      error: new Error('SecurityError'),
                      onupgradeneeded: null,
                      onsuccess: null,
                      onerror: null,
                      onblocked: null,
                  };
                  queueMicrotask(() => req.onerror?.());
                  return req;
              },
          } as unknown as IDBFactory)
        : options?.backing === null
          ? undefined
          : createFakeIdbFactory(options?.backing ?? createFakeIdbBacking());

    const mockCtx = {
        TextEncoder,
        TextDecoder,
        Uint8Array,
        ArrayBuffer,
        Date: { now: () => nowMs },
        location: { protocol: 'https:', host: 'erdmko.dev' },
        navigator: {
            get onLine() {
                return online;
            },
        },
        indexedDB: idbProp,
        IDBKeyRange: {
            upperBound: (n: number) => ({ __upperBound: n }),
        },
        WebSocket: MockWebSocket,
        setTimeout: (fn: () => void, delayMs = 0) => {
            const id = nextTimerId++;
            timers.set(id, { id, delayMs, fn });
            return id;
        },
        clearTimeout: (id: number) => {
            timers.delete(id);
        },
        addEventListener: (event: string, fn: () => void) => {
            let set = listeners.get(event);
            if (!set) {
                set = new Set();
                listeners.set(event, set);
            }
            set.add(fn);
        },
        removeEventListener: (event: string, fn: () => void) => {
            listeners.get(event)?.delete(fn);
        },
    } as unknown as Window;

    const flushMicrotasks = async (rounds = 6) => {
        for (let i = 0; i < rounds; i++) {
            await new Promise<void>((r) => queueMicrotask(r));
        }
    };

    return {
        ctx: mockCtx,
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
        runNextTimer: () => {
            const first = timers.values().next().value as TimerTask | undefined;
            if (!first) return null;
            timers.delete(first.id);
            first.fn();
            return first.delayMs;
        },
        flushMicrotasks,
    };
};

test('clean page load with empty IndexedDB opens zero WebSockets', async () => {
    const backing = createFakeIdbBacking();
    const env = createMockTelemetryEnv({ backing, online: true });
    const client = createTelemetryClient(env.ctx, createIdbTelemetryStorage());
    await env.flushMicrotasks();

    assert.equal(env.sockets.length, 0);
    assert.equal(queueEntryCount(client[CLIENT_QUEUE]), 0);
    disposeTelemetryClient(env.ctx, client);
});

test('offline enqueue persists in IndexedDB across reload, survives WS drop before ACK, and purges only on TelemetryAck', async () => {
    const backing = createFakeIdbBacking();
    const env1 = createMockTelemetryEnv({ backing, online: false });
    const client1 = createTelemetryClient(
        env1.ctx,
        createIdbTelemetryStorage()
    );

    // Enqueue 2 events while offline (1st even before hydration finishes!)
    reportTelemetryEvent(
        env1.ctx,
        TELEMETRY_SEVERITY_ERROR,
        TELEMETRY_KIND_WALLET_RPC,
        TELEMETRY_OP_PERSONAL_SIGN,
        '-32000',
        'checksum mismatch',
        '/chat',
        0,
        0,
        1,
        TELEMETRY_PROVIDER_FLAG_ETHEREUM | TELEMETRY_PROVIDER_FLAG_PHANTOM,
        client1
    );
    await env1.flushMicrotasks();
    reportTelemetryEvent(
        env1.ctx,
        TELEMETRY_SEVERITY_WARN,
        TELEMETRY_KIND_WEBRTC,
        TELEMETRY_OP_VOICE_SIGNALING,
        'VOICE_ROOM_FULL',
        'room full',
        '/chat/general',
        0,
        0,
        0,
        0,
        client1
    );
    await env1.flushMicrotasks();

    assert.equal(env1.sockets.length, 0);
    assert.equal(backing.records.size, 2);
    disposeTelemetryClient(env1.ctx, client1);

    // Simulate page reload while still offline -> hydrates 2 records, still 0 sockets
    const env2 = createMockTelemetryEnv({ backing, online: false });
    const client2 = createTelemetryClient(
        env2.ctx,
        createIdbTelemetryStorage()
    );
    await env2.flushMicrotasks();
    assert.equal(queueEntryCount(client2[CLIENT_QUEUE]), 2);
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

    // Socket drops mid-flight BEFORE TelemetryAck -> records stay in IndexedDB + backoff scheduled
    env2.sockets[0].drop();
    await env2.flushMicrotasks();
    assert.equal(backing.records.size, 2);
    assert.equal(queueEntryCount(client2[CLIENT_QUEUE]), 2);
    const delay = env2.runNextTimer();
    assert.equal(delay, BACKOFF_DELAYS_MS[0]);

    // Reconnected socket re-sends batch and receives TelemetryAck(2) -> purges IndexedDB
    assert.equal(env2.sockets.length, 2);
    env2.sockets[1].open();
    assert.equal(env2.sockets[1].sent.length, 1);
    env2.sockets[1].receive(encodeTelemetryAck(env2.ctx, 2));
    await env2.flushMicrotasks();

    assert.equal(queueEntryCount(client2[CLIENT_QUEUE]), 0);
    assert.equal(backing.records.size, 0);
    disposeTelemetryClient(env2.ctx, client2);
});

test('multi-batch drain, idle WebSocket teardown, and lazy re-open on later error (default in-memory queue)', async () => {
    const backing = createFakeIdbBacking();
    const env = createMockTelemetryEnv({ backing, online: true });
    // Default storage = null: zero IndexedDB writes, synchronous in-memory queue
    const client = createTelemetryClient(env.ctx, null, 250, 5000);
    await env.flushMicrotasks();

    for (let i = 0; i < 20; i++) {
        reportTelemetryEvent(
            env.ctx,
            TELEMETRY_SEVERITY_WARN,
            TELEMETRY_KIND_WS,
            0,
            `E_${i}`,
            `msg ${i}`,
            '/chat',
            0,
            0,
            0,
            0,
            client
        );
    }
    await env.flushMicrotasks();

    assert.equal(env.sockets.length, 1);
    env.sockets[0].open();
    assert.equal(env.sockets[0].sent.length, 1);

    const firstBatch = decodeTelemetryBatch(env.ctx, env.sockets[0].sent[0])!;
    assert.equal(firstBatch[TELEMETRY_BATCH_EVENTS].length, MAX_BATCH_EVENTS);
    assert.equal(firstBatch[TELEMETRY_BATCH_ACK_ID], 16);

    // Acking 16 immediately flushes remaining 4 events on the same socket
    env.sockets[0].receive(encodeTelemetryAck(env.ctx, 16));
    await env.flushMicrotasks();
    assert.equal(env.sockets[0].sent.length, 2);

    const secondBatch = decodeTelemetryBatch(env.ctx, env.sockets[0].sent[1])!;
    assert.equal(secondBatch[TELEMETRY_BATCH_EVENTS].length, 4);
    assert.equal(secondBatch[TELEMETRY_BATCH_ACK_ID], 20);

    // Acking 20 empties queue and arms idle close timer (250ms)
    env.sockets[0].receive(encodeTelemetryAck(env.ctx, 20));
    await env.flushMicrotasks();
    assert.equal(queueEntryCount(client[CLIENT_QUEUE]), 0);
    assert.equal(env.sockets[0].closed, false);

    const idleDelay = env.runNextTimer();
    assert.equal(idleDelay, 250);
    assert.equal(env.sockets[0].closed, true);
    assert.equal(client[CLIENT_WS], null);

    // A subsequent error lazily opens a brand-new WebSocket
    reportTelemetryEvent(
        env.ctx,
        TELEMETRY_SEVERITY_ERROR,
        TELEMETRY_KIND_UNCAUGHT_ERROR,
        0,
        'ReferenceError',
        'x is not defined',
        '/chat',
        10,
        2,
        0,
        0,
        client
    );
    await env.flushMicrotasks();
    assert.equal(env.sockets.length, 2);
    assert.equal(backing.records.size, 0);
    disposeTelemetryClient(env.ctx, client);
});

test('queue cap evicts oldest entries by count (64) and bytes (32 KiB)', async () => {
    const backing = createFakeIdbBacking();
    const env = createMockTelemetryEnv({ backing, online: false });
    const client = createTelemetryClient(
        env.ctx,
        createIdbTelemetryStorage(),
        1000,
        0
    );
    await env.flushMicrotasks();

    for (let i = 1; i <= 70; i++) {
        reportTelemetryEvent(
            env.ctx,
            TELEMETRY_SEVERITY_WARN,
            TELEMETRY_KIND_WS,
            0,
            `C_${i}`,
            `event-${i}`,
            '/chat',
            0,
            0,
            0,
            0,
            client
        );
        if (i === 50) {
            await env.flushMicrotasks();
        }
    }
    await env.flushMicrotasks();

    assert.equal(queueEntryCount(client[CLIENT_QUEUE]), MAX_QUEUE_EVENTS);
    assert.equal(backing.records.size, MAX_QUEUE_EVENTS);
    assert.equal(client[CLIENT_QUEUE][QUEUE_ENTRIES][0][QUEUE_ENTRY_ID], 7);
    assert.equal(client[CLIENT_QUEUE][QUEUE_ENTRIES][63][QUEUE_ENTRY_ID], 70);

    // Enqueue 12 large (~4 KiB) events -> total queued bytes stay <= MAX_QUEUE_BYTES (32 KiB)
    const bigPayload = 'x'.repeat(4000);
    for (let i = 0; i < 12; i++) {
        reportTelemetryEvent(
            env.ctx,
            TELEMETRY_SEVERITY_ERROR,
            TELEMETRY_KIND_UNCAUGHT_ERROR,
            0,
            `BIG_${i}`,
            bigPayload,
            '/chat',
            0,
            0,
            0,
            0,
            client
        );
    }
    await env.flushMicrotasks(20);
    assert.ok(queueTotalBytes(client[CLIENT_QUEUE]) <= MAX_QUEUE_BYTES);
    assert.ok(queueEntryCount(client[CLIENT_QUEUE]) <= 8);
    disposeTelemetryClient(env.ctx, client);
});

test('missing or failing indexedDB falls back to in-memory queue and deduplicates bursts', async () => {
    for (const mode of [{ backing: null }, { failIdbOpen: true }] as const) {
        const env = createMockTelemetryEnv({ ...mode, online: true });
        const client = createTelemetryClient(
            env.ctx,
            createIdbTelemetryStorage(),
            1000,
            5000
        );
        await env.flushMicrotasks();

        // Duplicate errors within 5000ms are coalesced into 1 entry
        reportTelemetryEvent(
            env.ctx,
            TELEMETRY_SEVERITY_WARN,
            TELEMETRY_KIND_WALLET_RPC,
            TELEMETRY_OP_PERSONAL_SIGN,
            '4001',
            'User rejected the request.',
            '/chat',
            0,
            0,
            1,
            0,
            client
        );
        reportTelemetryEvent(
            env.ctx,
            TELEMETRY_SEVERITY_WARN,
            TELEMETRY_KIND_WALLET_RPC,
            TELEMETRY_OP_PERSONAL_SIGN,
            '4001',
            'User rejected the request.',
            '/chat',
            0,
            0,
            1,
            0,
            client
        );
        await env.flushMicrotasks();

        assert.equal(queueEntryCount(client[CLIENT_QUEUE]), 1);
        assert.equal(env.sockets.length, 1);
        env.sockets[0].open();
        assert.equal(env.sockets[0].sent.length, 1);
        env.sockets[0].receive(encodeTelemetryAck(env.ctx, 1));
        await env.flushMicrotasks();
        assert.equal(queueEntryCount(client[CLIENT_QUEUE]), 0);

        // After 5001ms cooldown, identical error is recorded again
        env.advanceTime(5001);
        reportTelemetryEvent(
            env.ctx,
            TELEMETRY_SEVERITY_WARN,
            TELEMETRY_KIND_WALLET_RPC,
            TELEMETRY_OP_PERSONAL_SIGN,
            '4001',
            'User rejected the request.',
            '/chat',
            0,
            0,
            1,
            0,
            client
        );
        await env.flushMicrotasks();
        assert.equal(env.sockets[0].sent.length, 2);
        disposeTelemetryClient(env.ctx, client);
    }
});
