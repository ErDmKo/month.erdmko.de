import { ObserverState, ObserverInstance } from '../../utils';
import type { ReadonlyTupleOf } from '../../utils';
import { decodeServerFrame } from '@month/gen/chat';
import type { ClientFramePayload, ServerFramePayload } from '@month/gen/chat';
import {
    TELEMETRY_KIND_WS,
    TELEMETRY_OP_WS_DECODE,
    TELEMETRY_SEVERITY_ERROR,
} from '@month/gen/telemetry';
import { emitChatTelemetry } from '../telemetry';

// ── Bidirectional socket handle ───────────────────────────────────────────────

export const CHAT_SOCKET_OUTGOING = 0 as const;
export const CHAT_SOCKET_INCOMING = 1 as const;

export type BaseChatSocket = ReadonlyTupleOf<{
    [CHAT_SOCKET_OUTGOING]: ObserverInstance<any>;
    [CHAT_SOCKET_INCOMING]: ObserverState<ServerFramePayload>;
}>;

export type ChatSocket = ReadonlyTupleOf<{
    [CHAT_SOCKET_OUTGOING]: ObserverInstance<ClientFramePayload>;
    [CHAT_SOCKET_INCOMING]: ObserverState<ServerFramePayload>;
}>;

// ── Main binary frame parser ──────────────────────────────────────────────────

export const parseBinaryFrame = (
    ctx: Window,
    buf: Uint8Array
): ServerFramePayload | null => {
    if (buf.length === 0) return null;
    const frame = decodeServerFrame(ctx, buf);
    if (!frame) {
        emitChatTelemetry(
            ctx,
            TELEMETRY_SEVERITY_ERROR,
            TELEMETRY_KIND_WS,
            TELEMETRY_OP_WS_DECODE,
            `Malformed ServerFrame (${buf.length}B)`,
            'MALFORMED_FRAME'
        );
    }
    return frame;
};
