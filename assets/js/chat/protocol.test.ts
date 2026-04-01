import * as assert from 'node:assert/strict';
import {
    JOIN_TYPE,
    MAX_MESSAGE_LEN,
    MESSAGE_TYPE,
    serializeCommand,
    validateOutgoingCommand,
} from './protocol';

const run = () => {
    const joinSerialized = serializeCommand([JOIN_TYPE, 'join-1', 'alice']);
    assert.notEqual(joinSerialized, null, 'join should serialize');
    assert.equal(joinSerialized.type, 'join', 'join type mismatch');
    assert.equal(joinSerialized.requestId, 'join-1', 'join requestId mismatch');
    if (joinSerialized.type !== 'join') {
        throw new Error('join payload shape mismatch');
    }
    assert.equal(joinSerialized.nickname, 'alice', 'join nickname mismatch');

    const messageSerialized = serializeCommand([MESSAGE_TYPE, 'msg-1', 'hello']);
    assert.notEqual(messageSerialized, null, 'message should serialize');
    assert.equal(messageSerialized.type, 'message', 'message type mismatch');
    assert.equal(messageSerialized.requestId, 'msg-1', 'message requestId mismatch');
    if (messageSerialized.type !== 'message') {
        throw new Error('message payload shape mismatch');
    }
    assert.equal(messageSerialized.body, 'hello', 'message body mismatch');

    assert.ok(
        validateOutgoingCommand([JOIN_TYPE, 'join-2', '  ']) !== null,
        'empty nickname should be invalid'
    );
    assert.ok(
        validateOutgoingCommand([MESSAGE_TYPE, 'msg-2', '']) !== null,
        'empty message should be invalid'
    );
    assert.ok(
        validateOutgoingCommand([MESSAGE_TYPE, 'msg-3', 'x'.repeat(MAX_MESSAGE_LEN + 1)]) !== null,
        'oversized message should be invalid'
    );
    assert.equal(
        validateOutgoingCommand([MESSAGE_TYPE, 'msg-4', ' ok ']),
        null,
        'valid trimmed message should pass'
    );
};

run();
