import { ObserverState, ObserverInstance } from '../../utils';
import type { ReadonlyTupleOf } from '../../utils';
import { logIncomingFrame } from '../../utils/ws-logger';
import { decodeServerFrame } from '@month/gen/chat';
import type { ClientFramePayload, ServerFramePayload } from '@month/gen/chat';

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
    if (!frame) return null;
    logIncomingFrame(ctx, frame);
    return frame;
};
