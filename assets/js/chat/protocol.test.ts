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
} from './generated/chat';
import {
    decodeClientFrame,
} from './generated/chat';

const ctx = {
    TextEncoder,
    TextDecoder,
    Uint8Array,
} as unknown as Window;

const run = () => {
    // ── JOIN ──────────────────────────────────────────────────────────────────
    const joinBuf = new Uint8Array(serializeCommand(ctx, [CLIENT_FRAME_JOIN, ['join-1', 'alice']]));
    const joinFrame = decodeClientFrame(ctx, joinBuf);
    assert.ok(joinFrame !== null, 'join should decode');
    assert.equal(joinFrame![CLIENT_FRAME_PAYLOAD_VARIANT], CLIENT_FRAME_JOIN, 'join variant mismatch');
    assert.equal(joinFrame![CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_JOIN_REQUEST_ID], 'join-1', 'join requestId mismatch');
    assert.equal(joinFrame![CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_JOIN_NICKNAME], 'alice', 'join nickname mismatch');

    // ── MESSAGE ───────────────────────────────────────────────────────────────
    const msgBuf = new Uint8Array(serializeCommand(ctx, [CLIENT_FRAME_MESSAGE, ['msg-1', 'hello']]));
    const msgFrame = decodeClientFrame(ctx, msgBuf);
    assert.ok(msgFrame !== null, 'message should decode');
    assert.equal(msgFrame![CLIENT_FRAME_PAYLOAD_VARIANT], CLIENT_FRAME_MESSAGE, 'message variant mismatch');
    assert.equal(msgFrame![CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_MESSAGE_REQUEST_ID], 'msg-1', 'message requestId mismatch');
    assert.equal(msgFrame![CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_MESSAGE_BODY], 'hello', 'message body mismatch');

    // ── DELETE ────────────────────────────────────────────────────────────────
    const delBuf = new Uint8Array(serializeCommand(ctx, [CLIENT_FRAME_DELETE, ['del-1', 42]]));
    const delFrame = decodeClientFrame(ctx, delBuf);
    assert.ok(delFrame !== null, 'delete should decode');
    assert.equal(delFrame![CLIENT_FRAME_PAYLOAD_VARIANT], CLIENT_FRAME_DELETE, 'delete variant mismatch');
    assert.equal(delFrame![CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_DELETE_REQUEST_ID], 'del-1', 'delete requestId mismatch');
    assert.equal(delFrame![CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_DELETE_MESSAGE_ID], 42, 'delete messageId mismatch');

    // ── Validation ────────────────────────────────────────────────────────────
    assert.ok(
        validateOutgoingCommand([CLIENT_FRAME_JOIN, ['join-2', '  ']]) !== null,
        'empty nickname should be invalid'
    );
    assert.ok(
        validateOutgoingCommand([CLIENT_FRAME_MESSAGE, ['msg-2', '']]) !== null,
        'empty message should be invalid'
    );
    assert.ok(
        validateOutgoingCommand([CLIENT_FRAME_MESSAGE, ['msg-3', 'x'.repeat(MAX_MESSAGE_LEN + 1)]]) !== null,
        'oversized message should be invalid'
    );
    assert.equal(
        validateOutgoingCommand([CLIENT_FRAME_MESSAGE, ['msg-4', ' ok ']]),
        null,
        'valid trimmed message should pass'
    );
    assert.equal(
        validateOutgoingCommand([CLIENT_FRAME_DELETE, ['del-2', 100]]),
        null,
        'valid delete should pass'
    );

    // ── XSS guard: message template ───────────────────────────────────────────
    const xssPayload = '<img src=x onerror=alert(1) />';
    const struct = chatMessageTemplate(10, 'alice', xssPayload);
    assert.equal(struct[1].innerHTML, undefined, 'message template should not set innerHTML');
    assert.equal(struct[4]?.[1]?.[1].innerText, xssPayload, 'message body should be rendered as plain text');
};

run();
