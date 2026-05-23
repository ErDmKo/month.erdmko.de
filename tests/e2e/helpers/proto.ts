/**
 * Binary protobuf helpers for e2e tests.
 *
 * The server expects raw protobuf-encoded `ClientFrame` / `ServerFrame` messages
 * for chunk data, but uses JSON text frames for all control messages.
 *
 * These helpers are direct TypeScript ports of the encode/decode functions in
 * `server/src/pages/chat/tests/helpers.rs`.
 */

function writeVarint(buf: number[], value: number): void {
    let v = value >>> 0;
    while (true) {
        const byte = v & 0x7f;
        v >>>= 7;
        if (v === 0) {
            buf.push(byte);
            break;
        }
        buf.push(byte | 0x80);
    }
}

function readVarint(buf: Buffer, pos: { value: number }): number {
    let result = 0;
    let shift = 0;
    while (pos.value < buf.length) {
        const b = buf[pos.value++];
        result |= (b & 0x7f) << shift;
        shift += 7;
        if ((b & 0x80) === 0) break;
    }
    return result >>> 0;
}

/**
 * Encode a protobuf `UploadChunk` message wrapped in a `ClientFrame`.
 *
 * Wire layout (field numbers match `contracts/chat/chat.proto`):
 *   ClientFrame.upload_chunk (field 1, length-delimited)
 *   UploadChunk.upload_id    (field 1, varint)
 *   UploadChunk.index        (field 2, varint)
 *   UploadChunk.data         (field 3, length-delimited)
 *
 * For compatibility with the existing Rust integration tests (which encode the
 * `UploadChunk` fields directly without the outer `ClientFrame` wrapper) this
 * function encodes only the inner `UploadChunk` fields — matching the format
 * `encode_upload_chunk_frame` in `helpers.rs`.
 */
export function encodeUploadChunk(uploadId: number, index: number, data: Uint8Array): Buffer {
    const inner: number[] = [];
    // field 1: upload_id (varint)
    writeVarint(inner, (1 << 3) | 0);
    writeVarint(inner, uploadId);
    // field 2: index (varint)
    writeVarint(inner, (2 << 3) | 0);
    writeVarint(inner, index);
    // field 3: data (length-delimited)
    writeVarint(inner, (3 << 3) | 2);
    writeVarint(inner, data.length);
    for (const b of data) inner.push(b);

    return Buffer.from(inner);
}

/**
 * Extract the raw `data` bytes from a binary `DownloadChunk` frame sent by
 * the server.  The frame is a raw `DownloadChunk` protobuf message where
 * field 3 carries the chunk bytes.
 *
 * Matches `extract_download_data` in `helpers.rs`.
 */
export function extractDownloadChunk(buf: Buffer): Buffer {
    const pos = { value: 0 };
    while (pos.value < buf.length) {
        const tw = readVarint(buf, pos);
        const field = (tw >>> 3) as number;
        const wire = tw & 0x7;
        if (field === 3 && wire === 2) {
            const len = readVarint(buf, pos);
            return buf.subarray(pos.value, pos.value + len) as Buffer;
        } else if (wire === 0) {
            readVarint(buf, pos);
        } else if (wire === 2) {
            const len = readVarint(buf, pos);
            pos.value += len;
        } else {
            break;
        }
    }
    return Buffer.alloc(0);
}
