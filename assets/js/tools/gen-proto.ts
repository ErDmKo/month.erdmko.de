// Generator: contracts/*.descriptor.json → assets/js/chat/generated/<package>.ts
//
// Usage (via Bazel or directly):
//   node gen-proto.js <descriptor.json> <output.ts> <relative-path-to-proto-utils>
//
// Each generated file exports:
//   - A tuple type per message
//   - Field index constants (SCREAMING_SNAKE_CASE)
//   - encode<MessageName>(ctx, ...fields): Uint8Array
//   - decode<MessageName>(ctx, buf): <Type> | null
//   - For oneof wrapper messages: encodeClientFrame / decodeServerFrame etc.

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Descriptor types (mirrors build.rs JSON output) ──────────────────────────

type ProtoFieldType =
    | 'uint32' | 'int32' | 'int64' | 'uint64'
    | 'bool' | 'string' | 'bytes'
    | 'double' | 'float'
    | 'message' | 'unknown';

type FieldDescriptor = {
    name: string;
    number: number;
    type: ProtoFieldType;
    repeated?: boolean;
    message_type?: string; // set when type === 'message'
};

type OneofVariant = {
    name: string;       // e.g. "join"
    number: number;     // protobuf field number
    message_type: string; // e.g. "ClientJoin"
};

type OneofDescriptor = {
    name: string;          // e.g. "payload"
    variants: OneofVariant[];
};

type MessageDescriptor = {
    name: string;
    fields: FieldDescriptor[];
    oneofs?: OneofDescriptor[];
};

type PackageDescriptor = {
    package: string;
    messages: MessageDescriptor[];
};

// ── Type mappings ─────────────────────────────────────────────────────────────

const protoTypeToTs = (t: ProtoFieldType, messageType?: string): string => {
    switch (t) {
        case 'uint32':
        case 'int32':
        case 'int64':
        case 'uint64':
        case 'float':
        case 'double': return 'number';
        case 'bool':   return 'boolean';
        case 'string': return 'string';
        case 'bytes':  return 'Uint8Array';
        case 'message': return messageType ?? 'unknown';
        default:       return 'unknown';
    }
};

const protoTypeWire = (t: ProtoFieldType): string => {
    switch (t) {
        case 'uint32':
        case 'int32':
        case 'int64':
        case 'uint64':
        case 'bool':
        case 'float':
        case 'double': return 'WIRE_VARINT';
        default:       return 'WIRE_LEN';
    }
};

const encodeHelper = (t: ProtoFieldType): string => {
    switch (t) {
        case 'uint32':
        case 'int32':
        case 'int64':
        case 'uint64': return 'encodeUint32Field';
        case 'string': return 'encodeStringField';
        case 'bytes':  return 'encodeBytesField';
        default:       return 'encodeUint32Field';
    }
};

// ── Name helpers ──────────────────────────────────────────────────────────────

const toScreamingSnake = (s: string): string =>
    s.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();

const fieldConstName = (msgName: string, fieldName: string): string =>
    `${toScreamingSnake(msgName)}_${fieldName.toUpperCase()}`;

const toCamel = (s: string): string =>
    s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

// ── Generate a plain message (no oneof) ───────────────────────────────────────

const genMessage = (msg: MessageDescriptor): string => {
    const { name, fields } = msg;
    const lines: string[] = [];

    // ── Tuple type ────────────────────────────────────────────────────────────
    const tupleFields = fields
        .map(f => {
            const tsType = protoTypeToTs(f.type, f.message_type);
            const fieldType = f.repeated ? `${tsType}[]` : tsType;
            return `    ${toCamel(f.name)}: ${fieldType}`;
        })
        .join(',\n');
    lines.push(`export type ${name} = readonly [`);
    lines.push(tupleFields);
    lines.push(`];`);
    lines.push('');

    // ── Field index constants ─────────────────────────────────────────────────
    fields.forEach((f, i) => {
        lines.push(`export const ${fieldConstName(name, f.name)} = ${i} as const;`);
    });
    lines.push('');

    // ── encode ────────────────────────────────────────────────────────────────
    const encodeParams = fields
        .map(f => {
            const tsType = protoTypeToTs(f.type, f.message_type);
            const fieldType = f.repeated ? `readonly ${tsType}[]` : tsType;
            return `    ${toCamel(f.name)}: ${fieldType}`;
        })
        .join(',\n');
    lines.push(`export const encode${name} = (`);
    lines.push(`    ctx: Window,`);
    lines.push(encodeParams);
    lines.push(`): Uint8Array =>`);
    lines.push(`    concatBytes(ctx, [`);
    fields.forEach(f => {
        const camel = toCamel(f.name);
        if (f.type === 'message' && f.repeated) {
            // repeated message: encode each item as a length-delimited field
            lines.push(`        ...encodeRepeatedMessage(ctx, ${f.number}, ${camel}, encode${f.message_type!}),`);
        } else if (f.type === 'message') {
            // single message: encodeMessageField returns Uint8Array directly
            lines.push(`        encodeMessageField(ctx, ${f.number}, ${camel}, encode${f.message_type!}),`);
        } else {
            const helper = encodeHelper(f.type);
            lines.push(`        ...${helper}(ctx, ${f.number}, ${camel}),`);
        }
    });
    lines.push(`    ]);`);
    lines.push('');

    // ── decode ────────────────────────────────────────────────────────────────
    lines.push(`export const decode${name} = (`);
    lines.push(`    ctx: Window,`);
    lines.push(`    buf: Uint8Array,`);
    lines.push(`): ${name} | null => {`);
    lines.push(`    const reader = readerCreate(ctx, buf);`);

    // Pre-initialize fields array with proto3 defaults, indexed by tuple position (i)
    const defaultFor = (f: FieldDescriptor): string => {
        if (f.repeated) return '[]';
        switch (f.type) {
            case 'uint32': case 'int32': case 'int64': case 'uint64': return '0';
            case 'string': return "''";
            case 'bytes':  return 'new ctx.Uint8Array(0)';
            default:       return 'null';
        }
    };
    const defaults = fields.map(f => defaultFor(f)).join(', ');
    lines.push(`    const fields: unknown[] = [${defaults}];`);
    lines.push(`    while (!readerAtEnd(reader)) {`);
    lines.push(`        switch (readerTag(reader)) {`);
    fields.forEach(f => {
        const constName = fieldConstName(name, f.name);
        if (f.type === 'message') {
            if (f.repeated) {
                lines.push(`            case ${f.number}: ((fields[${constName}] ??= []) as unknown[]).push(readerMessage(ctx, reader, decode${f.message_type!})); break;`);
            } else {
                lines.push(`            case ${f.number}: fields[${constName}] = readerMessage(ctx, reader, decode${f.message_type!}); break;`);
            }
        } else if (f.type === 'uint32' || f.type === 'int32' || f.type === 'int64' || f.type === 'uint64') {
            lines.push(`            case ${f.number}: fields[${constName}] = readerVarint(reader); break;`);
        } else if (f.type === 'string') {
            lines.push(`            case ${f.number}: fields[${constName}] = readerString(reader); break;`);
        } else if (f.type === 'bytes') {
            lines.push(`            case ${f.number}: fields[${constName}] = readerBytes(reader); break;`);
        }
    });
    lines.push(`            default: if (!readerSkip(reader)) return null;`);
    lines.push(`        }`);
    lines.push(`    }`);
    lines.push(`    return fields as unknown as ${name};`);
    lines.push(`};`);

    return lines.join('\n');
};

// ── Generate a oneof wrapper message ─────────────────────────────────────────
// Produces:
//   const <NAME>_PAYLOAD_VARIANT = 0
//   const <NAME>_PAYLOAD_VALUE   = 1
//   type <Name>Payload = readonly [variant: <VariantConst>, value: <VariantType>]
//   encode<Name>(ctx, payload): Uint8Array
//   decode<Name>(ctx, buf): <Name>Payload | null

const genOneofWrapper = (msg: MessageDescriptor): string => {
    const { name, oneofs } = msg;
    if (!oneofs || oneofs.length === 0) return '';
    const oneof = oneofs[0]; // only one oneof per frame wrapper
    const lines: string[] = [];
    const snake = toScreamingSnake(name);
    const variantConst = `${snake}_PAYLOAD_VARIANT`;
    const valueConst   = `${snake}_PAYLOAD_VALUE`;

    // ── Variant name constants ─────────────────────────────────────────────────
    oneof.variants.forEach(v => {
        const constName = `${snake}_${v.name.toUpperCase()}`;
        lines.push(`export const ${constName} = ${v.number} as const;`);
    });
    lines.push('');

    // ── Tuple index constants ──────────────────────────────────────────────────
    lines.push(`export const ${variantConst} = 0 as const;`);
    lines.push(`export const ${valueConst}   = 1 as const;`);
    lines.push('');

    // ── Union payload type (tuple) ─────────────────────────────────────────────
    lines.push(`export type ${name}Payload =`);
    oneof.variants.forEach((v, i) => {
        const constName = `${snake}_${v.name.toUpperCase()}`;
        const sep = i < oneof.variants.length - 1 ? '' : ';';
        lines.push(`    | readonly [variant: typeof ${constName}, value: ${v.message_type}]${sep}`);
    });
    lines.push('');

    // ── encode ────────────────────────────────────────────────────────────────
    lines.push(`export const encode${name} = (`);
    lines.push(`    ctx: Window,`);
    lines.push(`    payload: ${name}Payload,`);
    lines.push(`): Uint8Array => {`);
    lines.push(`    switch (payload[${variantConst}]) {`);
    oneof.variants.forEach(v => {
        const constName = `${snake}_${v.name.toUpperCase()}`;
        lines.push(`        case ${constName}: return encodeMessageField(ctx, ${v.number}, payload[${valueConst}], encode${v.message_type});`);
    });
    lines.push(`        default: return new ctx.Uint8Array(0);`);
    lines.push(`    }`);
    lines.push(`};`);
    lines.push('');

    // ── decode ────────────────────────────────────────────────────────────────
    lines.push(`export const decode${name} = (`);
    lines.push(`    ctx: Window,`);
    lines.push(`    buf: Uint8Array,`);
    lines.push(`): ${name}Payload | null =>`);
    lines.push(`    decodeOneofFrame(ctx, buf, [`);
    const maxField = Math.max(...oneof.variants.map(v => v.number));
    for (let i = 0; i <= maxField; i++) {
        const v = oneof.variants.find(v => v.number === i);
        if (!v) { lines.push(`        undefined,`); continue; }
        const constName = `${snake}_${v.name.toUpperCase()}`;
        lines.push(`        [${constName}, decode${v.message_type}],`);
    }
    lines.push(`    ]) as unknown as ${name}Payload | null;`);

    return lines.join('\n');
};

// ── File generator ────────────────────────────────────────────────────────────

const genFile = (descriptor: PackageDescriptor, protoUtilsPath: string): string => {
    const header = [
        `// @generated from ${descriptor.package}.proto — do not edit by hand`,
        `// Re-generate: cargo build (server/build.rs) then bazel run //assets/js/tools:gen-proto`,
        ``,
        `import {`,
        `    encodeUint32Field,`,
        `    encodeStringField,`,
        `    encodeBytesField,`,
        `    encodeMessageField,`,
        `    encodeRepeatedMessage,`,
        `    concatBytes,`,
        `    readerCreate,`,
        `    readerAtEnd,`,
        `    readerTag,`,
        `    readerVarint,`,
        `    readerString,`,
        `    readerBytes,`,
        `    readerMessage,`,
        `    readerSkip,`,
        `    decodeOneofFrame,`,
        `} from '${protoUtilsPath}';`,
        ``,
        `declare global { interface Window { Uint8Array: typeof Uint8Array; } }`,
        ``,
    ].join('\n');

    const parts: string[] = [];
    for (const msg of descriptor.messages) {
        if (msg.oneofs && msg.oneofs.length > 0) {
            parts.push(genOneofWrapper(msg));
        } else {
            parts.push(genMessage(msg));
        }
    }

    return header + parts.join('\n') + '\n';
};

// ── Entry point ───────────────────────────────────────────────────────────────

const [,, descriptorPath, outputPath, protoUtilsRelPath] = process.argv;

if (!descriptorPath || !outputPath || !protoUtilsRelPath) {
    console.error('Usage: gen-proto <descriptor.json> <output.ts> <proto-utils-relative-path>');
    process.exit(1);
}

const descriptor: PackageDescriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
const code = genFile(descriptor, protoUtilsRelPath);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, code, 'utf8');
console.log(`generated ${outputPath}`);
