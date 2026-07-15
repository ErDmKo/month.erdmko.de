// Proto frame logger — enabled when localStorage.debug includes 'ws'
// Usage: localStorage.setItem('debug', 'ws')
//
// Logs outgoing ClientFrame and incoming ServerFrame variants with their
// decoded field values in a compact, readable format.

import { createLogger } from './logger';

const wsLog = createLogger('ws');

// ── Variant name maps ─────────────────────────────────────────────────────────

const CLIENT_VARIANT_NAMES: Record<number, string> = {
    1: 'join',
    2: 'message',
    3: 'delete',
    4: 'upload_start',
    5: 'upload_end',
    6: 'download_request',
    7: 'upload_chunk',
};

const SERVER_VARIANT_NAMES: Record<number, string> = {
    1: 'joined',
    2: 'history',
    3: 'message',
    4: 'deleted',
    5: 'error',
    6: 'upload_ready',
    7: 'upload_done',
    8: 'download_start',
    9: 'download_end',
    10: 'download_chunk',
};

// ── Field formatting ──────────────────────────────────────────────────────────

const formatValue = (v: unknown): string => {
    if (v instanceof Uint8Array) return `<bytes len=${v.length}>`;
    if (Array.isArray(v)) return `[${v.length} items]`;
    if (typeof v === 'string' && v.length > 80) return `"${v.slice(0, 80)}…"`;
    if (typeof v === 'string') return `"${v}"`;
    return String(v);
};

const formatPayload = (value: readonly unknown[]): string =>
    value.map(formatValue).join(', ');

const expandableArgs = (value: readonly unknown[]): unknown[] =>
    value.filter(
        (v) =>
            Array.isArray(v) ||
            (typeof v === 'object' && v !== null && !(v instanceof Uint8Array))
    );

// ── Public API ────────────────────────────────────────────────────────────────

export type FramePayload = readonly [
    variant: number,
    value: readonly unknown[],
];

const LOGGER_VARIANT = 0 as const;
const LOGGER_VALUE = 1 as const;

export const logOutgoingFrame = (ctx: Window, payload: FramePayload): void => {
    const name =
        CLIENT_VARIANT_NAMES[payload[LOGGER_VARIANT]] ??
        `unknown(${payload[LOGGER_VARIANT]})`;
    const extra = expandableArgs(payload[LOGGER_VALUE]);
    wsLog(ctx, `→ ${name}(${formatPayload(payload[LOGGER_VALUE])})`, ...extra);
};

export const logIncomingFrame = (ctx: Window, payload: FramePayload): void => {
    const name =
        SERVER_VARIANT_NAMES[payload[LOGGER_VARIANT]] ??
        `unknown(${payload[LOGGER_VARIANT]})`;
    const extra = expandableArgs(payload[LOGGER_VALUE]);
    wsLog(ctx, `← ${name}(${formatPayload(payload[LOGGER_VALUE])})`, ...extra);
};
