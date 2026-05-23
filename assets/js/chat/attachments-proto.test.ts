import * as assert from 'node:assert/strict';
import {
    encodeClientFrame,
    decodeClientFrame,
    encodeServerFrame,
    decodeServerFrame,
    CLIENT_FRAME_UPLOAD_CHUNK,
    SERVER_FRAME_DOWNLOAD_CHUNK,
    CLIENT_FRAME_PAYLOAD_VARIANT,
    CLIENT_FRAME_PAYLOAD_VALUE,
    SERVER_FRAME_PAYLOAD_VARIANT,
    SERVER_FRAME_PAYLOAD_VALUE,
    UPLOAD_CHUNK_UPLOAD_ID,
    UPLOAD_CHUNK_INDEX,
    UPLOAD_CHUNK_DATA,
    DOWNLOAD_CHUNK_ATTACHMENT_ID,
    DOWNLOAD_CHUNK_INDEX,
    DOWNLOAD_CHUNK_DATA,
} from './generated/chat';

const ctx = globalThis as unknown as Window;

const run = () => {
    // ── Test 1: UploadChunk round-trip via ClientFrame ─────────────────────────
    const uploadId = 7;
    const index = 3;
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);

    const encoded = encodeClientFrame(ctx, [
        CLIENT_FRAME_UPLOAD_CHUNK,
        [uploadId, index, data],
    ]);

    const decoded = decodeClientFrame(ctx, encoded);
    assert.ok(decoded !== null, 'decodeClientFrame returned null');
    assert.equal(decoded![CLIENT_FRAME_PAYLOAD_VARIANT], CLIENT_FRAME_UPLOAD_CHUNK, 'variant mismatch');
    assert.equal(decoded![CLIENT_FRAME_PAYLOAD_VALUE][UPLOAD_CHUNK_UPLOAD_ID], uploadId, 'uploadId mismatch');
    assert.equal(decoded![CLIENT_FRAME_PAYLOAD_VALUE][UPLOAD_CHUNK_INDEX], index, 'index mismatch');
    assert.deepEqual(decoded![CLIENT_FRAME_PAYLOAD_VALUE][UPLOAD_CHUNK_DATA], data, 'data mismatch');

    // ── Test 2: DownloadChunk round-trip via ServerFrame ───────────────────────
    const attachmentId = 42;
    const dlIndex = 1;
    const dlData = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

    const dlEncoded = encodeServerFrame(ctx, [
        SERVER_FRAME_DOWNLOAD_CHUNK,
        [attachmentId, dlIndex, dlData],
    ]);

    const dlDecoded = decodeServerFrame(ctx, dlEncoded);
    assert.ok(dlDecoded !== null, 'decodeServerFrame returned null');
    assert.equal(dlDecoded![SERVER_FRAME_PAYLOAD_VARIANT], SERVER_FRAME_DOWNLOAD_CHUNK, 'variant mismatch');
    assert.equal(dlDecoded![SERVER_FRAME_PAYLOAD_VALUE][DOWNLOAD_CHUNK_ATTACHMENT_ID], attachmentId, 'attachmentId mismatch');
    assert.equal(dlDecoded![SERVER_FRAME_PAYLOAD_VALUE][DOWNLOAD_CHUNK_INDEX], dlIndex, 'index mismatch');
    assert.deepEqual(dlDecoded![SERVER_FRAME_PAYLOAD_VALUE][DOWNLOAD_CHUNK_DATA], dlData, 'data mismatch');

    // ── Test 3: UploadChunk with index=0 and empty data ───────────────────────
    const minimalEncoded = encodeClientFrame(ctx, [
        CLIENT_FRAME_UPLOAD_CHUNK,
        [1, 0, new Uint8Array(0)],
    ]);
    const minimalDecoded = decodeClientFrame(ctx, minimalEncoded);
    assert.ok(minimalDecoded !== null, 'minimal decode returned null');
    assert.equal(minimalDecoded![CLIENT_FRAME_PAYLOAD_VARIANT], CLIENT_FRAME_UPLOAD_CHUNK, 'minimal variant mismatch');
    assert.equal(minimalDecoded![CLIENT_FRAME_PAYLOAD_VALUE][UPLOAD_CHUNK_INDEX], 0, 'minimal index should be 0');
    assert.equal(minimalDecoded![CLIENT_FRAME_PAYLOAD_VALUE][UPLOAD_CHUNK_DATA].length, 0, 'minimal data should be empty');

    console.log('attachments-proto: all 3 tests passed');
};

run();
