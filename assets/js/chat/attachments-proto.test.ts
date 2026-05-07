import * as assert from 'node:assert/strict';
import {
    decodeDownloadChunk,
    encodeDownloadChunk,
    encodeUploadChunk,
    DOWNLOAD_CHUNK_ATTACHMENT_ID,
    DOWNLOAD_CHUNK_INDEX,
    DOWNLOAD_CHUNK_DATA,
} from './attachments-proto';

const ctx = globalThis as unknown as Window;

const run = () => {
    // ── Test 1: encodeUploadChunk round-trip via Rust-compatible format ────────
    // Encode a chunk and verify the raw bytes match expected protobuf layout.
    const uploadId = 7;
    const index = 3;
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);

    const encoded = encodeUploadChunk(ctx, uploadId, index, data);

    // Expected: field1 tag=0x08, value=7; field2 tag=0x10, value=3; field3 tag=0x1a, len=5, data
    const expected = new Uint8Array([
        0x08, 0x07, 0x10, 0x03, 0x1a, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05,
    ]);
    assert.deepEqual(encoded, expected, 'encodeUploadChunk bytes mismatch');

    // ── Test 2: encodeDownloadChunk → decodeDownloadChunk round-trip ──────────
    const attachmentId = 'attach-42';
    const dlIndex = 1;
    const dlData = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

    const dlEncoded = encodeDownloadChunk(ctx, attachmentId, dlIndex, dlData);
    const decoded = decodeDownloadChunk(ctx, dlEncoded);

    assert.ok(decoded !== null, 'decodeDownloadChunk returned null');
    assert.equal(
        decoded[DOWNLOAD_CHUNK_ATTACHMENT_ID],
        attachmentId,
        'attachmentId mismatch'
    );
    assert.equal(decoded[DOWNLOAD_CHUNK_INDEX], dlIndex, 'index mismatch');
    assert.deepEqual(decoded[DOWNLOAD_CHUNK_DATA], dlData, 'data mismatch');

    // ── Test 3: decodeDownloadChunk handles zero/default fields ───────────────
    // Encode with index=0 and empty data — proto omits default values.
    const minimalEncoded = encodeDownloadChunk(
        ctx,
        'id-1',
        0,
        new Uint8Array(0)
    );
    const minimalDecoded = decodeDownloadChunk(ctx, minimalEncoded);

    assert.ok(minimalDecoded !== null, 'minimal decode returned null');
    assert.equal(
        minimalDecoded[DOWNLOAD_CHUNK_ATTACHMENT_ID],
        'id-1',
        'minimal attachmentId mismatch'
    );
    assert.equal(
        minimalDecoded[DOWNLOAD_CHUNK_INDEX],
        0,
        'minimal index should be 0'
    );
    assert.equal(
        minimalDecoded[DOWNLOAD_CHUNK_DATA].length,
        0,
        'minimal data should be empty'
    );

    console.log('attachments-proto: all 3 tests passed');
};

run();
