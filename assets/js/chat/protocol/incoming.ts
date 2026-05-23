import { ObserverState, ObserverInstance } from '../../utils';
import { logIncomingFrame } from '../../utils/ws-logger';
import { decodeServerFrame } from '../generated/chat';
import type { ClientFramePayload, ServerFramePayload } from '../generated/chat';

// ── Bidirectional socket handle ───────────────────────────────────────────────

export const CHAT_SOCKET_OUTGOING = 0 as const;
export const CHAT_SOCKET_INCOMING = 1 as const;

export type BaseChatSocket = readonly [
    outgoing: ObserverInstance<any>,
    incoming: ObserverState<ServerFramePayload>,
];

export type ChatSocket = readonly [
    outgoing: ObserverInstance<ClientFramePayload>,
    incoming: ObserverState<ServerFramePayload>,
];

// ── Main binary frame parser ──────────────────────────────────────────────────

export const parseBinaryFrame = (
    ctx: Window,
    buf: Uint8Array,
): ServerFramePayload | null => {
    if (buf.length === 0) return null;
    const frame = decodeServerFrame(ctx, buf);
    if (!frame) return null;
    logIncomingFrame(frame);
    return frame;
};
