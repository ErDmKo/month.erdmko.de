// TODO: replace with @bufbuild/protobuf when all binary messages migrate to proto

// ── Varint helpers ────────────────────────────────────────────────────────────

const encodeVarint = (value: number): Uint8Array => {
    const bytes: number[] = [];
    let v = value >>> 0; // treat as uint32
    do {
        const byte = v & 0x7f;
        v >>>= 7;
        bytes.push(v !== 0 ? byte | 0x80 : byte);
    } while (v !== 0);
    return new Uint8Array(bytes);
};

const decodeVarint = (
    buf: Uint8Array,
    pos: number
): { value: number; bytesRead: number } | null => {
    let result = 0;
    let shift = 0;
    let bytesRead = 0;
    while (pos + bytesRead < buf.length) {
        const byte = buf[pos + bytesRead];
        bytesRead++;
        result |= (byte & 0x7f) << shift;
        shift += 7;
        if ((byte & 0x80) === 0) {
            return { value: result >>> 0, bytesRead };
        }
        if (shift >= 32) return null;
    }
    return null;
};

// ── Encode UploadChunk → Uint8Array ───────────────────────────────────────────
//
// message UploadChunk {
//   uint32 upload_id = 1;
//   uint32 index     = 2;
//   bytes  data      = 3;
// }

export const encodeUploadChunk = (
    uploadId: number,
    index: number,
    data: Uint8Array
): Uint8Array => {
    const parts: Uint8Array[] = [];

    // field 1: uint32 upload_id (tag = 1<<3|0 = 0x08)
    if (uploadId !== 0) {
        parts.push(encodeVarint(0x08));
        parts.push(encodeVarint(uploadId));
    }

    // field 2: uint32 index (tag = 2<<3|0 = 0x10)
    if (index !== 0) {
        parts.push(encodeVarint(0x10));
        parts.push(encodeVarint(index));
    }

    // field 3: bytes data (tag = 3<<3|2 = 0x1a)
    if (data.length > 0) {
        parts.push(encodeVarint(0x1a));
        parts.push(encodeVarint(data.length));
        parts.push(data);
    }

    const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
};

// ── Decode DownloadChunk ← Uint8Array ─────────────────────────────────────────
//
// message DownloadChunk {
//   string attachment_id = 1;
//   uint32 index         = 2;
//   bytes  data          = 3;
// }

export type DownloadChunk = {
    attachmentId: string;
    index: number;
    data: Uint8Array;
};

export const decodeDownloadChunk = (buf: Uint8Array): DownloadChunk | null => {
    const decoder = new TextDecoder();
    let attachmentId = '';
    let index = 0;
    let data = new Uint8Array(0);
    let pos = 0;

    while (pos < buf.length) {
        const tagResult = decodeVarint(buf, pos);
        if (!tagResult) return null;
        pos += tagResult.bytesRead;
        const tag = tagResult.value;
        const field = tag >>> 3;
        const wire = tag & 0x7;

        if (field === 1 && wire === 2) {
            // string attachment_id
            const lenResult = decodeVarint(buf, pos);
            if (!lenResult) return null;
            pos += lenResult.bytesRead;
            attachmentId = decoder.decode(
                buf.slice(pos, pos + lenResult.value)
            );
            pos += lenResult.value;
        } else if (field === 2 && wire === 0) {
            // uint32 index
            const v = decodeVarint(buf, pos);
            if (!v) return null;
            index = v.value;
            pos += v.bytesRead;
        } else if (field === 3 && wire === 2) {
            // bytes data
            const lenResult = decodeVarint(buf, pos);
            if (!lenResult) return null;
            pos += lenResult.bytesRead;
            data = buf.slice(pos, pos + lenResult.value);
            pos += lenResult.value;
        } else if (wire === 0) {
            // skip unknown varint
            const v = decodeVarint(buf, pos);
            if (!v) return null;
            pos += v.bytesRead;
        } else if (wire === 2) {
            // skip unknown length-delimited
            const v = decodeVarint(buf, pos);
            if (!v) return null;
            pos += v.bytesRead + v.value;
        } else {
            return null;
        }
    }

    return { attachmentId, index, data };
};

// ── Encode DownloadChunk (for testing the decoder) ────────────────────────────

export const encodeDownloadChunk = (
    attachmentId: string,
    index: number,
    data: Uint8Array
): Uint8Array => {
    const encoder = new TextEncoder();
    const idBytes = encoder.encode(attachmentId);
    const parts: Uint8Array[] = [];

    if (idBytes.length > 0) {
        parts.push(encodeVarint(0x0a)); // tag=1, wire=2
        parts.push(encodeVarint(idBytes.length));
        parts.push(idBytes);
    }
    if (index !== 0) {
        parts.push(encodeVarint(0x10)); // tag=2, wire=0
        parts.push(encodeVarint(index));
    }
    if (data.length > 0) {
        parts.push(encodeVarint(0x1a)); // tag=3, wire=2
        parts.push(encodeVarint(data.length));
        parts.push(data);
    }

    const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
};
