export const JOIN_TYPE = 0 as const;
export const MESSAGE_TYPE = 1 as const;
export const DELETE_TYPE = 2 as const;
export const MAX_MESSAGE_LEN = 200;
export const MAX_NICKNAME_LEN = 32;
export const MAX_UPLOAD_SIZE = 5 * 1024 * 1024;

type OutgoingType = typeof JOIN_TYPE | typeof MESSAGE_TYPE | typeof DELETE_TYPE;

// ── Outgoing commands (client → server) ──────────────────────────────────────

export type SendCommand =
    | readonly [type: typeof JOIN_TYPE, requestId: string, nickname: string]
    | readonly [type: typeof MESSAGE_TYPE, requestId: string, body: string]
    | readonly [type: typeof DELETE_TYPE, requestId: string, messageId: number];

export type OutgoingWsEvent =
    | { type: 'join'; requestId: string; nickname: string }
    | { type: 'message'; requestId: string; body: string }
    | { type: 'delete'; requestId: string; messageId: number }
    | { type: 'upload_start'; requestId: string; messageId: number; filename: string; size: number; mimeType: string }
    | { type: 'upload_end'; requestId: string; uploadId: number }
    | { type: 'download_request'; requestId: string; attachmentId: number };

// ── Incoming server events (server → client) ──────────────────────────────────

export type AttachmentMeta = {
    id: number;
    messageId: number;
    filename: string;
    size: number;
    mimeType: string;
};

export type UploadDonePayload = {
    attachment: AttachmentMeta;
};

export type DownloadStartPayload = {
    attachmentId: number;
    filename: string;
    size: number;
    mimeType: string;
    totalChunks: number;
};

export type IncomingWsEvent =
    | { type: 'joined'; requestId: string; self: { senderId: string } }
    | { type: 'history'; items: { id: number; senderId?: string; senderName: string; body: string; createdAt?: string }[] }
    | { type: 'message'; item: { id: number; senderId?: string; senderName: string; body: string; createdAt?: string } }
    | { type: 'deleted'; messageId: number }
    | { type: 'error'; requestId?: string; code?: string; message?: string }
    | { type: 'upload_ready'; requestId: string; uploadId: number }
    | { type: 'upload_done'; requestId: string; attachment: AttachmentMeta }
    | { type: 'download_start'; requestId: string; attachmentId: number; filename: string; size: number; mimeType: string; totalChunks: number }
    | { type: 'download_end'; requestId: string };

// ── Serialization ─────────────────────────────────────────────────────────────

const isAllowedType = (eventType: number): eventType is OutgoingType => {
    return (
        eventType === JOIN_TYPE ||
        eventType === MESSAGE_TYPE ||
        eventType === DELETE_TYPE
    );
};

export const serializeCommand = (
    command: SendCommand
): OutgoingWsEvent | null => {
    const [type, requestId, payload] = command;
    if (!isAllowedType(type)) {
        return null;
    }
    if (type === JOIN_TYPE) {
        return { type: 'join', requestId, nickname: payload };
    }
    if (type === DELETE_TYPE) {
        return { type: 'delete', requestId, messageId: payload };
    }
    return { type: 'message', requestId, body: payload };
};

// ── Validation ────────────────────────────────────────────────────────────────

export const validateOutgoingCommand = (
    command: SendCommand
): string | null => {
    const [type, _requestId, payload] = command;
    if (type === JOIN_TYPE) {
        const nickname = payload.trim();
        if (nickname.length === 0 || nickname.length > MAX_NICKNAME_LEN) {
            return `Nickname must be between 1 and ${MAX_NICKNAME_LEN} characters.`;
        }
        return null;
    }
    if (type === DELETE_TYPE) {
        if (!Number.isInteger(payload) || payload <= 0) {
            return 'Message id must be a positive integer.';
        }
        return null;
    }
    const body = payload.trim();
    if (body.length === 0 || body.length > MAX_MESSAGE_LEN) {
        return `Message must be between 1 and ${MAX_MESSAGE_LEN} characters.`;
    }
    return null;
};
