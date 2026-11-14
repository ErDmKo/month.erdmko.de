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
