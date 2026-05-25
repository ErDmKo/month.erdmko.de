import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { chatMessageTemplate } from './messages/template';
import { MAX_MESSAGE_LEN } from './chat-ui/message-form-handler';
import { serializeCommand, validateOutgoingCommand } from './protocol/outgoing';
import {
    CLIENT_FRAME_JOIN,
    CLIENT_FRAME_MESSAGE,
    CLIENT_FRAME_DELETE,
    CLIENT_FRAME_PAYLOAD_VARIANT,
    CLIENT_FRAME_PAYLOAD_VALUE,
    CLIENT_JOIN_REQUEST_ID,
    CLIENT_JOIN_NICKNAME,
    CLIENT_MESSAGE_REQUEST_ID,
    CLIENT_MESSAGE_BODY,
    CLIENT_DELETE_REQUEST_ID,
    CLIENT_DELETE_MESSAGE_ID,
    decodeClientFrame,
} from '@month/gen/chat';

const ctx = {
    TextEncoder,
    TextDecoder,
    Uint8Array,
} as unknown as Window;

test('join encode/decode round-trip', () => {
    const buf = new Uint8Array(
        serializeCommand(ctx, [CLIENT_FRAME_JOIN, ['join-1', 'alice']])
    );
    const frame = decodeClientFrame(ctx, buf);
    assert.ok(frame !== null);
    assert.equal(frame![CLIENT_FRAME_PAYLOAD_VARIANT], CLIENT_FRAME_JOIN);
    assert.equal(
        frame![CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_JOIN_REQUEST_ID],
        'join-1'
    );
    assert.equal(
        frame![CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_JOIN_NICKNAME],
        'alice'
    );
});

test('message encode/decode round-trip', () => {
    const buf = new Uint8Array(
        serializeCommand(ctx, [CLIENT_FRAME_MESSAGE, ['msg-1', 'hello']])
    );
    const frame = decodeClientFrame(ctx, buf);
    assert.ok(frame !== null);
    assert.equal(frame![CLIENT_FRAME_PAYLOAD_VARIANT], CLIENT_FRAME_MESSAGE);
    assert.equal(
        frame![CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_MESSAGE_REQUEST_ID],
        'msg-1'
    );
    assert.equal(
        frame![CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_MESSAGE_BODY],
        'hello'
    );
});

test('delete encode/decode round-trip', () => {
    const buf = new Uint8Array(
        serializeCommand(ctx, [CLIENT_FRAME_DELETE, ['del-1', 42]])
    );
    const frame = decodeClientFrame(ctx, buf);
    assert.ok(frame !== null);
    assert.equal(frame![CLIENT_FRAME_PAYLOAD_VARIANT], CLIENT_FRAME_DELETE);
    assert.equal(
        frame![CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_DELETE_REQUEST_ID],
        'del-1'
    );
    assert.equal(
        frame![CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_DELETE_MESSAGE_ID],
        42
    );
});

test('validation rejects empty nickname', () => {
    assert.ok(
        validateOutgoingCommand([CLIENT_FRAME_JOIN, ['join-2', '  ']]) !== null
    );
});

test('validation rejects empty message', () => {
    assert.ok(
        validateOutgoingCommand([CLIENT_FRAME_MESSAGE, ['msg-2', '']]) !== null
    );
});

test('validation rejects oversized message', () => {
    assert.ok(
        validateOutgoingCommand([
            CLIENT_FRAME_MESSAGE,
            ['msg-3', 'x'.repeat(MAX_MESSAGE_LEN + 1)],
        ]) !== null
    );
});

test('validation accepts valid trimmed message', () => {
    assert.equal(
        validateOutgoingCommand([CLIENT_FRAME_MESSAGE, ['msg-4', ' ok ']]),
        null
    );
});

test('validation accepts valid delete', () => {
    assert.equal(
        validateOutgoingCommand([CLIENT_FRAME_DELETE, ['del-2', 100]]),
        null
    );
});

test('message template renders body as plain text (XSS guard)', () => {
    const xssPayload = '<img src=x onerror=alert(1) />';
    const struct = chatMessageTemplate(10, 'alice', xssPayload);
    assert.equal(struct[1].innerHTML, undefined);
    assert.equal(struct[4]?.[1]?.[1].innerText, xssPayload);
});
