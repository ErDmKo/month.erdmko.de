// Proto frame logger — enabled when localStorage.debug includes 'ws'
// Usage: localStorage.setItem('debug', 'ws')
//
// Logs outgoing ClientFrame and incoming ServerFrame variants with their
// decoded field values in a compact, readable format.

import { createLogger } from './logger';
import type { ReadonlyTupleOf } from './tuple';

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
    8: 'voice_join',
    9: 'voice_leave',
    10: 'voice_offer',
    11: 'voice_ice',
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
    11: 'voice_state',
    12: 'voice_answer',
    13: 'voice_ice',
    14: 'voice_error',
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

const LOGGER_VARIANT = 0 as const;
const LOGGER_VALUE = 1 as const;

export type FramePayload = ReadonlyTupleOf<{
    [LOGGER_VARIANT]: number;
    [LOGGER_VALUE]: readonly unknown[];
}>;

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
