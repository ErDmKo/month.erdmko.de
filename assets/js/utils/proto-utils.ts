// Shared protobuf wire-format primitives.
// Used by hand-written parsers and generated encode/decode functions.

declare global {
    interface Window {
        Uint8Array: typeof Uint8Array;
        TextDecoder: typeof TextDecoder;
        TextEncoder: typeof TextEncoder;
    }
}

// ── Wire types ────────────────────────────────────────────────────────────────

export const WIRE_VARINT = 0 as const;
export const WIRE_LEN = 2 as const;

// ── Tag helpers ───────────────────────────────────────────────────────────────

export const makeTag = (fieldNumber: number, wireType: number): number =>
    (fieldNumber << 3) | wireType;

// ── Varint ────────────────────────────────────────────────────────────────────

export const VARINT_VALUE = 0 as const;
export const VARINT_BYTES_READ = 1 as const;

export const encodeVarint = (ctx: Window, value: number): Uint8Array => {
    const bytes: number[] = [];
    let v = value > 0 ? Math.floor(value) : 0;
    do {
        const byte = v % 128;
        v = (v - byte) / 128;
        bytes.push(v > 0 ? byte | 0x80 : byte);
    } while (v > 0);
    return new ctx.Uint8Array(bytes);
};

export const decodeVarint = (
    buf: Uint8Array,
    pos: number
): readonly [value: number, bytesRead: number] | null => {
    let result = 0;
    let mult = 1;
    let bytesRead = 0;
    while (pos + bytesRead < buf.length) {
        const byte = buf[pos + bytesRead];
        bytesRead++;
        result += (byte & 0x7f) * mult;
        if ((byte & 0x80) === 0) return [result, bytesRead];
        mult *= 128;
        if (bytesRead >= 10) return null;
    }
    return null;
};

// ── Buffer assembly ───────────────────────────────────────────────────────────

export const concatBytes = (ctx: Window, parts: Uint8Array[]): Uint8Array => {
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new ctx.Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
};

// ── Field encoders ────────────────────────────────────────────────────────────

// uint32 field (wire type 0)
export const encodeUint32Field = (
    ctx: Window,
    fieldNumber: number,
    value: number
): Uint8Array[] => {
    if (value === 0) return [];
    return [
        encodeVarint(ctx, makeTag(fieldNumber, WIRE_VARINT)),
        encodeVarint(ctx, value),
    ];
};

// bool field (wire type 0)
export const encodeBoolField = (
    ctx: Window,
    fieldNumber: number,
    value: boolean
): Uint8Array[] => {
    if (!value) return [];
    return [
        encodeVarint(ctx, makeTag(fieldNumber, WIRE_VARINT)),
        encodeVarint(ctx, 1),
    ];
};

let utf8Encoder: TextEncoder | undefined;
let utf8Decoder: TextDecoder | undefined;

// string field (wire type 2)
export const encodeStringField = (
    ctx: Window,
    fieldNumber: number,
    value: string
): Uint8Array[] => {
    if (!value) return [];
    const bytes = (utf8Encoder ??= new ctx.TextEncoder()).encode(value);
    return [
        encodeVarint(ctx, makeTag(fieldNumber, WIRE_LEN)),
        encodeVarint(ctx, bytes.length),
        bytes,
    ];
};

// bytes field (wire type 2)
export const encodeBytesField = (
    ctx: Window,
    fieldNumber: number,
    value: Uint8Array
): Uint8Array[] => {
    if (value.length === 0) return [];
    return [
        encodeVarint(ctx, makeTag(fieldNumber, WIRE_LEN)),
        encodeVarint(ctx, value.length),
        value,
    ];
};

// nested message field (wire type 2)
export const encodeMessageField = <T extends readonly unknown[]>(
    ctx: Window,
    fieldNumber: number,
    value: T | null,
    encoder: (ctx: Window, ...args: any[]) => Uint8Array
): Uint8Array => {
    if (value === null) return new ctx.Uint8Array(0);
    const encoded = encoder(ctx, ...value);
    return concatBytes(ctx, [
        encodeVarint(ctx, makeTag(fieldNumber, WIRE_LEN)),
        encodeVarint(ctx, encoded.length),
        encoded,
    ]);
};

// repeated nested message field
export const encodeRepeatedMessage = <T extends readonly unknown[]>(
    ctx: Window,
    fieldNumber: number,
    values: readonly T[],
    encoder: (ctx: Window, ...args: any[]) => Uint8Array
): Uint8Array[] => {
    const out: Uint8Array[] = [];
    for (const value of values) {
        const encoded = encodeMessageField(ctx, fieldNumber, value, encoder);
        if (encoded.length > 0) out.push(encoded);
    }
    return out;
};

// ── Field skip ────────────────────────────────────────────────────────────────

// Returns number of bytes to advance past an unknown field, or null on error.
export const skipField = (
    buf: Uint8Array,
    pos: number,
    wire: number
): number | null => {
    if (wire === WIRE_VARINT) {
        const v = decodeVarint(buf, pos);
        return v ? v[VARINT_BYTES_READ] : null;
    }
    if (wire === WIRE_LEN) {
        const v = decodeVarint(buf, pos);
        return v ? v[VARINT_BYTES_READ] + v[VARINT_VALUE] : null;
    }
    return null;
};

// ── Reader ────────────────────────────────────────────────────────────────────

export const READER_BUF = 0 as const;
export const READER_POS = 1 as const;
export const READER_WIRE = 2 as const;

export type Reader = [buf: Uint8Array, pos: number, wire: number];

export const readerCreate = (_ctx: Window, buf: Uint8Array): Reader => [
    buf,
    0,
    0,
];

export const readerAtEnd = (r: Reader): boolean =>
    r[READER_POS] >= r[READER_BUF].length;

// Reads the next tag, stores wire type in r[READER_WIRE], returns field number.
// Returns 0 on error.
export const readerTag = (r: Reader): number => {
    const varint = decodeVarint(r[READER_BUF], r[READER_POS]);
    if (!varint) return 0;
    r[READER_POS] += varint[VARINT_BYTES_READ];
    r[READER_WIRE] = varint[VARINT_VALUE] & 0x7;
    return varint[VARINT_VALUE] >>> 3;
};

// Returns 0 on error.
export const readerVarint = (r: Reader): number => {
    const varint = decodeVarint(r[READER_BUF], r[READER_POS]);
    if (!varint) return 0;
    r[READER_POS] += varint[VARINT_BYTES_READ];
    return varint[VARINT_VALUE];
};

const readerSlice = (r: Reader): Uint8Array | null => {
    const len = decodeVarint(r[READER_BUF], r[READER_POS]);
    if (!len) return null;
    const start = r[READER_POS] + len[VARINT_BYTES_READ];
    const end = start + len[VARINT_VALUE];
    r[READER_POS] = end;
    return r[READER_BUF].subarray(start, end);
};

// Returns '' on error.
export const readerString = (ctx: Window, r: Reader): string => {
    const slice = readerSlice(r);
    return slice ? (utf8Decoder ??= new ctx.TextDecoder()).decode(slice) : '';
};

// Returns empty Uint8Array on error.
export const readerBytes = (r: Reader): Uint8Array =>
    readerSlice(r) ?? r[READER_BUF].subarray(0, 0);

// Reads a length-delimited slice and passes it to decode. Returns null on error.
export const readerMessage = <T>(
    ctx: Window,
    r: Reader,
    decode: (ctx: Window, buf: Uint8Array) => T | null
): T | null => {
    const slice = readerSlice(r);
    return slice ? decode(ctx, slice) : null;
};

// Skips the current field using the wire type stored by readerTag. Returns false on error.
export const readerSkip = (r: Reader): boolean => {
    const skip = skipField(r[READER_BUF], r[READER_POS], r[READER_WIRE]);
    if (skip === null) return false;
    r[READER_POS] += skip;
    return true;
};

// ── High-level table-driven message & oneof decoders ─────────────────────────

export const PROTO_VARINT = 0 as const;
export const PROTO_BOOL = 1 as const;
export const PROTO_STRING = 2 as const;
export const PROTO_BYTES = 3 as const;

export type ProtoSeqSpec =
    | typeof PROTO_VARINT
    | typeof PROTO_BOOL
    | typeof PROTO_STRING
    | typeof PROTO_BYTES
    | ((ctx: Window, buf: Uint8Array) => unknown)
    | readonly [(ctx: Window, buf: Uint8Array) => unknown];

export const encodeOneofFrame = (
    ctx: Window,
    payload: readonly [number, readonly unknown[]],
    encoders: ReadonlyArray<
        ((ctx: Window, ...args: any[]) => Uint8Array) | undefined
    >
): Uint8Array => {
    const variant = payload[0];
    const enc = encoders[variant];
    return enc
        ? encodeMessageField(ctx, variant, payload[1], enc)
        : new ctx.Uint8Array(0);
};

// Decode a message whose field numbers are sequential 1..N (field k -> tuple index k - 1).
export const decodeSeqMessage = <T>(
    ctx: Window,
    buf: Uint8Array,
    fields: unknown[],
    specs: ReadonlyArray<ProtoSeqSpec>
): T | null => {
    const r = readerCreate(ctx, buf);
    while (!readerAtEnd(r)) {
        const field = readerTag(r);
        if (!field) return null;
        const idx = field - 1;
        const spec = specs[idx];
        if (spec === undefined) {
            if (!readerSkip(r)) return null;
        } else if (typeof spec === 'function') {
            fields[idx] = readerMessage(ctx, r, spec);
        } else if (typeof spec === 'object') {
            (fields[idx] as unknown[]).push(readerMessage(ctx, r, spec[0]));
        } else if (spec === PROTO_VARINT) {
            fields[idx] = readerVarint(r);
        } else if (spec === PROTO_BOOL) {
            fields[idx] = readerVarint(r) !== 0;
        } else if (spec === PROTO_STRING) {
            fields[idx] = readerString(ctx, r);
        } else {
            fields[idx] = readerBytes(r);
        }
    }
    return fields as unknown as T;
};

// Decode a oneof wrapper message (all fields are len-delimited nested messages).
// decoders: sparse array indexed by field number; each entry is [variant, decodeFn].
export const decodeOneofFrame = (
    ctx: Window,
    buf: Uint8Array,
    decoders: ReadonlyArray<
        | readonly [
              variant: number,
              decode: (ctx: Window, slice: Uint8Array) => unknown,
          ]
        | undefined
    >
): readonly [number, unknown] | null => {
    const r = readerCreate(ctx, buf);
    while (!readerAtEnd(r)) {
        const field = readerTag(r);
        if (!field) return null;
        if (r[READER_WIRE] !== WIRE_LEN) {
            if (!readerSkip(r)) return null;
            continue;
        }
        const entry = decoders[field];
        if (entry) {
            const value = readerMessage(
                ctx,
                r,
                entry[1] as (ctx: Window, buf: Uint8Array) => unknown
            );
            if (!value) return null;
            return [entry[0], value];
        }
        if (!readerSkip(r)) return null;
    }
    return null;
};
