import * as assert from 'node:assert/strict';
import {
    decodeDownloadChunk,
    encodeDownloadChunk,
    encodeUploadChunk,
} from './attachments-proto';

const run = () => {
    // ── Test 1: encodeUploadChunk round-trip via Rust-compatible format ────────
    // Encode a chunk and verify the raw bytes match expected protobuf layout.
    const uploadId = 7;
    const index = 3;
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);

    const encoded = encodeUploadChunk(uploadId, index, data);

    // Expected: field1 tag=0x08, value=7; field2 tag=0x10, value=3; field3 tag=0x1a, len=5, data
    const expected = new Uint8Array([
        0x08, 0x07, 0x10, 0x03, 0x1a, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05,
    ]);
    assert.deepEqual(encoded, expected, 'encodeUploadChunk bytes mismatch');

    // ── Test 2: encodeDownloadChunk → decodeDownloadChunk round-trip ──────────
    const attachmentId = 'attach-42';
    const dlIndex = 1;
    const dlData = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

    const dlEncoded = encodeDownloadChunk(attachmentId, dlIndex, dlData);
    const decoded = decodeDownloadChunk(dlEncoded);

    assert.ok(decoded !== null, 'decodeDownloadChunk returned null');
    assert.equal(decoded.attachmentId, attachmentId, 'attachmentId mismatch');
    assert.equal(decoded.index, dlIndex, 'index mismatch');
    assert.deepEqual(decoded.data, dlData, 'data mismatch');

    // ── Test 3: decodeDownloadChunk handles zero/default fields ───────────────
    // Encode with index=0 and empty data — proto omits default values.
    const minimalEncoded = encodeDownloadChunk('id-1', 0, new Uint8Array(0));
    const minimalDecoded = decodeDownloadChunk(minimalEncoded);

    assert.ok(minimalDecoded !== null, 'minimal decode returned null');
    assert.equal(
        minimalDecoded.attachmentId,
        'id-1',
        'minimal attachmentId mismatch'
    );
    assert.equal(minimalDecoded.index, 0, 'minimal index should be 0');
    assert.equal(minimalDecoded.data.length, 0, 'minimal data should be empty');

    console.log('attachments-proto: all 3 tests passed');
};

run();
