import * as assert from 'node:assert/strict';
import { chatMessageTemplate } from './template';
import {
    DELETE_TYPE,
    JOIN_TYPE,
    MAX_MESSAGE_LEN,
    MESSAGE_TYPE,
    OutgoingWsEvent,
    serializeCommand,
    validateOutgoingCommand,
} from './protocol';

const ctx = null as unknown as Window;

const asJson = (
    result: OutgoingWsEvent | ArrayBuffer | null
): OutgoingWsEvent => {
    assert.ok(result !== null, 'serialize result should not be null');
    assert.ok(
        !(result instanceof ArrayBuffer),
        'expected JSON frame, got binary'
    );
    return result;
};

const run = () => {
    const joinSerialized = asJson(
        serializeCommand(ctx, [JOIN_TYPE, 'join-1', 'alice'])
    );
    assert.equal(joinSerialized.type, 'join', 'join type mismatch');
    assert.equal(joinSerialized.requestId, 'join-1', 'join requestId mismatch');
    if (joinSerialized.type !== 'join') {
        throw new Error('join payload shape mismatch');
    }
    assert.equal(joinSerialized.nickname, 'alice', 'join nickname mismatch');

    const messageSerialized = asJson(
        serializeCommand(ctx, [MESSAGE_TYPE, 'msg-1', 'hello'])
    );
    assert.equal(messageSerialized.type, 'message', 'message type mismatch');
    assert.equal(
        messageSerialized.requestId,
        'msg-1',
        'message requestId mismatch'
    );
    if (messageSerialized.type !== 'message') {
        throw new Error('message payload shape mismatch');
    }
    assert.equal(messageSerialized.body, 'hello', 'message body mismatch');

    const deleteSerialized = asJson(
        serializeCommand(ctx, [DELETE_TYPE, 'del-1', 42])
    );
    assert.equal(deleteSerialized.type, 'delete', 'delete type mismatch');
    if (deleteSerialized.type !== 'delete') {
        throw new Error('delete payload shape mismatch');
    }
    assert.equal(deleteSerialized.messageId, 42, 'delete messageId mismatch');

    assert.ok(
        validateOutgoingCommand([JOIN_TYPE, 'join-2', '  ']) !== null,
        'empty nickname should be invalid'
    );
    assert.ok(
        validateOutgoingCommand([MESSAGE_TYPE, 'msg-2', '']) !== null,
        'empty message should be invalid'
    );
    assert.ok(
        validateOutgoingCommand([
            MESSAGE_TYPE,
            'msg-3',
            'x'.repeat(MAX_MESSAGE_LEN + 1),
        ]) !== null,
        'oversized message should be invalid'
    );
    assert.equal(
        validateOutgoingCommand([MESSAGE_TYPE, 'msg-4', ' ok ']),
        null,
        'valid trimmed message should pass'
    );
    assert.equal(
        validateOutgoingCommand([DELETE_TYPE, 'del-2', 100]),
        null,
        'valid delete should pass'
    );

    const xssPayload = '<img src=x onerror=alert(1) />';
    const struct = chatMessageTemplate(10, 'alice', xssPayload);
    assert.equal(
        struct[1].innerHTML,
        undefined,
        'message template should not set innerHTML'
    );
    assert.equal(
        struct[4]?.[1]?.[1].innerText,
        xssPayload,
        'message body should be rendered as plain text'
    );
};

run();
