export const JOIN_TYPE = 0 as const;
export const MESSAGE_TYPE = 1 as const;
export const DELETE_TYPE = 2 as const;
export const DOWNLOAD_REQUEST_TYPE = 3 as const;
export const UPLOAD_START_TYPE = 4 as const;
export const UPLOAD_END_TYPE = 5 as const;
export const UPLOAD_CHUNK_TYPE = 6 as const;
export const MAX_MESSAGE_LEN = 200;
export const MAX_NICKNAME_LEN = 32;
export const MAX_UPLOAD_SIZE = 5 * 1024 * 1024;

import { ObserverInstance, ObserverState } from '../utils';
import {
    encodeUploadChunk,
    DecodedDownloadChunk,
    DOWNLOAD_CHUNK_ATTACHMENT_ID,
    DOWNLOAD_CHUNK_INDEX,
    DOWNLOAD_CHUNK_DATA,
} from './attachments-proto';

type OutgoingType =
    | typeof JOIN_TYPE
    | typeof MESSAGE_TYPE
    | typeof DELETE_TYPE
    | typeof DOWNLOAD_REQUEST_TYPE
    | typeof UPLOAD_START_TYPE
    | typeof UPLOAD_END_TYPE
    | typeof UPLOAD_CHUNK_TYPE;

// ── Outgoing commands (client → server) ───────────────────────────────────────

export type SendCommand =
    | readonly [type: typeof JOIN_TYPE, requestId: string, nickname: string]
    | readonly [type: typeof MESSAGE_TYPE, requestId: string, body: string]
    | readonly [type: typeof DELETE_TYPE, requestId: string, messageId: number]
    | readonly [
          type: typeof DOWNLOAD_REQUEST_TYPE,
          requestId: string,
          attachmentId: number,
      ]
    | readonly [
          type: typeof UPLOAD_START_TYPE,
          requestId: string,
          messageId: number,
          filename: string,
          size: number,
          mimeType: string,
      ]
    | readonly [
          type: typeof UPLOAD_END_TYPE,
          requestId: string,
          uploadId: number,
      ]
    | readonly [
          type: typeof UPLOAD_CHUNK_TYPE,
          uploadId: number,
          index: number,
          data: Uint8Array,
      ];

// SendCommand field indices (shared slot 0 = type)
export const SEND_TYPE = 0 as const;
export const SEND_REQUEST_ID = 1 as const;

// JOIN: [type, requestId, nickname]
export const JOIN_NICKNAME = 2 as const;

// MESSAGE: [type, requestId, body]
export const MESSAGE_BODY = 2 as const;

// DELETE: [type, requestId, messageId]
export const DELETE_MESSAGE_ID = 2 as const;

// DOWNLOAD_REQUEST: [type, requestId, attachmentId]
export const DOWNLOAD_REQUEST_ATTACHMENT_ID = 2 as const;

// UPLOAD_START: [type, requestId, messageId, filename, size, mimeType]
export const UPLOAD_START_MESSAGE_ID = 2 as const;
export const UPLOAD_START_FILENAME = 3 as const;
export const UPLOAD_START_SIZE = 4 as const;
export const UPLOAD_START_MIME_TYPE = 5 as const;

// UPLOAD_END: [type, requestId, uploadId]
export const UPLOAD_END_UPLOAD_ID = 2 as const;

// UPLOAD_CHUNK: [type, uploadId, index, data]
export const UPLOAD_CHUNK_UPLOAD_ID = 1 as const;
export const UPLOAD_CHUNK_INDEX = 2 as const;
export const UPLOAD_CHUNK_DATA = 3 as const;

export type OutgoingWsEvent =
    | { type: 'join'; requestId: string; nickname: string }
    | { type: 'message'; requestId: string; body: string }
    | { type: 'delete'; requestId: string; messageId: number }
    | {
          type: 'upload_start';
          requestId: string;
          messageId: number;
          filename: string;
          size: number;
          mimeType: string;
      }
    | { type: 'upload_end'; requestId: string; uploadId: number }
    | { type: 'download_request'; requestId: string; attachmentId: number };

// ── Incoming wire types (server → client, JSON) ───────────────────────────────

export type AttachmentMeta = {
    id: number;
    messageId: number;
    filename: string;
    size: number;
    mimeType: string;
};

type IncomingWsFrame =
    | { type: 'joined'; requestId: string; self: { senderId: string } }
    | {
          type: 'history';
          items: {
              id: number;
              senderId?: string;
              senderName: string;
              body: string;
              createdAt?: string;
          }[];
      }
    | {
          type: 'message';
          item: {
              id: number;
              senderId?: string;
              senderName: string;
              body: string;
              createdAt?: string;
          };
      }
    | { type: 'deleted'; messageId: number }
    | { type: 'error'; requestId?: string; code?: string; message?: string }
    | { type: 'upload_ready'; requestId: string; uploadId: number }
    | { type: 'upload_done'; requestId: string; attachment: AttachmentMeta }
    | {
          type: 'download_start';
          requestId: string;
          attachmentId: number;
          filename: string;
          size: number;
          mimeType: string;
          totalChunks: number;
      }
    | { type: 'download_end'; requestId: string };

// ── Internal event tuples (WsEvent) ───────────────────────────────────────────

export const WS_JOINED = 0 as const;
export const WS_HISTORY = 1 as const;
export const WS_MESSAGE = 2 as const;
export const WS_DELETED = 3 as const;
export const WS_ERROR = 4 as const;
export const WS_UPLOAD_READY = 5 as const;
export const WS_UPLOAD_DONE = 6 as const;
export const WS_DOWNLOAD_START = 7 as const;
export const WS_DOWNLOAD_END = 8 as const;
export const WS_DOWNLOAD_CHUNK = 9 as const;

// ── WsEvent field indices ─────────────────────────────────────────────────────

export const WS_EVENT_TYPE = 0 as const;

// WS_JOINED: [type, requestId, senderId]
export const WS_JOINED_REQUEST_ID = 1 as const;
export const WS_JOINED_SENDER_ID = 2 as const;

// WS_HISTORY: [type, items]
export const WS_HISTORY_ITEMS = 1 as const;

// WS_MESSAGE: [type, item]
export const WS_MESSAGE_ITEM = 1 as const;

// WS_DELETED: [type, messageId]
export const WS_DELETED_MESSAGE_ID = 1 as const;

// WS_ERROR: [type, requestId, code, message]
export const WS_ERROR_REQUEST_ID = 1 as const;
export const WS_ERROR_CODE = 2 as const;
export const WS_ERROR_MESSAGE = 3 as const;

// WS_UPLOAD_READY: [type, requestId, uploadId]
export const WS_UPLOAD_READY_REQUEST_ID = 1 as const;
export const WS_UPLOAD_READY_UPLOAD_ID = 2 as const;

// WS_UPLOAD_DONE: [type, requestId, attachment]
export const WS_UPLOAD_DONE_REQUEST_ID = 1 as const;
export const WS_UPLOAD_DONE_ATTACHMENT = 2 as const;

// WS_DOWNLOAD_START: [type, requestId, meta]
export const WS_DOWNLOAD_START_REQUEST_ID = 1 as const;
export const WS_DOWNLOAD_START_META = 2 as const;

// WS_DOWNLOAD_END: [type, requestId]
export const WS_DOWNLOAD_END_REQUEST_ID = 1 as const;

// WS_DOWNLOAD_CHUNK: [type, attachmentId, index, data]
export const WS_DOWNLOAD_CHUNK_ATTACHMENT_ID = 1 as const;
export const WS_DOWNLOAD_CHUNK_INDEX = 2 as const;
export const WS_DOWNLOAD_CHUNK_DATA = 3 as const;

export type WsMessageItem = {
    id: number;
    senderId?: string;
    senderName: string;
    body: string;
    createdAt?: string;
};
export type DownloadStartPayload = Omit<
    Extract<IncomingWsFrame, { type: 'download_start' }>,
    'type' | 'requestId'
>;

export type WsEvent =
    | readonly [type: typeof WS_JOINED, requestId: string, senderId: string]
    | readonly [type: typeof WS_HISTORY, items: WsMessageItem[]]
    | readonly [type: typeof WS_MESSAGE, item: WsMessageItem]
    | readonly [type: typeof WS_DELETED, messageId: number]
    | readonly [
          type: typeof WS_ERROR,
          requestId: string | undefined,
          code: string,
          message: string,
      ]
    | readonly [
          type: typeof WS_UPLOAD_READY,
          requestId: string,
          uploadId: number,
      ]
    | readonly [
          type: typeof WS_UPLOAD_DONE,
          requestId: string,
          attachment: AttachmentMeta,
      ]
    | readonly [
          type: typeof WS_DOWNLOAD_START,
          requestId: string,
          meta: DownloadStartPayload,
      ]
    | readonly [type: typeof WS_DOWNLOAD_END, requestId: string]
    | readonly [
          type: typeof WS_DOWNLOAD_CHUNK,
          attachmentId: number,
          index: number,
          data: Uint8Array,
      ];

// ── Bidirectional socket handle ───────────────────────────────────────────────

export const CHAT_SOCKET_OUTGOING = 0 as const;
export const CHAT_SOCKET_INCOMING = 1 as const;

export type ChatSocket = readonly [
    outgoing: ObserverInstance<SendCommand>,
    incoming: ObserverState<WsEvent>,
];

// ── Parsers ───────────────────────────────────────────────────────────────────

export const parseTextFrame = (raw: string): WsEvent | null => {
    let frame: IncomingWsFrame;
    try {
        frame = JSON.parse(raw);
    } catch (_e) {
        return null;
    }
    switch (frame.type) {
        case 'joined':
            return [WS_JOINED, frame.requestId, frame.self.senderId];
        case 'history':
            return [WS_HISTORY, frame.items];
        case 'message':
            return [WS_MESSAGE, frame.item];
        case 'deleted':
            return [WS_DELETED, frame.messageId];
        case 'error':
            return [
                WS_ERROR,
                frame.requestId,
                frame.code ?? 'UNKNOWN',
                frame.message ?? '',
            ];
        case 'upload_ready':
            return [WS_UPLOAD_READY, frame.requestId, frame.uploadId];
        case 'upload_done':
            return [WS_UPLOAD_DONE, frame.requestId, frame.attachment];
        case 'download_start': {
            const { type: _t, requestId, ...meta } = frame;
            return [WS_DOWNLOAD_START, requestId, meta];
        }
        case 'download_end':
            return [WS_DOWNLOAD_END, frame.requestId];
        default:
            return null;
    }
};

export const parseBinaryFrame = (
    ctx: Window,
    buf: Uint8Array,
    decode: (ctx: Window, buf: Uint8Array) => DecodedDownloadChunk | null
): WsEvent | null => {
    const chunk = decode(ctx, buf);
    if (!chunk) return null;
    return [
        WS_DOWNLOAD_CHUNK,
        Number(chunk[DOWNLOAD_CHUNK_ATTACHMENT_ID]),
        chunk[DOWNLOAD_CHUNK_INDEX],
        chunk[DOWNLOAD_CHUNK_DATA],
    ];
};

// ── Serialization ─────────────────────────────────────────────────────────────

const isAllowedType = (eventType: number): eventType is OutgoingType => {
    return (
        eventType === JOIN_TYPE ||
        eventType === MESSAGE_TYPE ||
        eventType === DELETE_TYPE ||
        eventType === DOWNLOAD_REQUEST_TYPE ||
        eventType === UPLOAD_START_TYPE ||
        eventType === UPLOAD_END_TYPE ||
        eventType === UPLOAD_CHUNK_TYPE
    );
};

export const serializeCommand = (
    ctx: Window,
    command: SendCommand
): OutgoingWsEvent | ArrayBuffer | null => {
    const type = command[SEND_TYPE];
    if (!isAllowedType(type)) {
        return null;
    }
    if (type === JOIN_TYPE) {
        return {
            type: 'join',
            requestId: command[SEND_REQUEST_ID],
            nickname: command[JOIN_NICKNAME],
        };
    }
    if (type === MESSAGE_TYPE) {
        return {
            type: 'message',
            requestId: command[SEND_REQUEST_ID],
            body: command[MESSAGE_BODY],
        };
    }
    if (type === DELETE_TYPE) {
        return {
            type: 'delete',
            requestId: command[SEND_REQUEST_ID],
            messageId: command[DELETE_MESSAGE_ID],
        };
    }
    if (type === DOWNLOAD_REQUEST_TYPE) {
        return {
            type: 'download_request',
            requestId: command[SEND_REQUEST_ID],
            attachmentId: command[DOWNLOAD_REQUEST_ATTACHMENT_ID],
        };
    }
    if (type === UPLOAD_START_TYPE) {
        return {
            type: 'upload_start',
            requestId: command[SEND_REQUEST_ID],
            messageId: command[UPLOAD_START_MESSAGE_ID],
            filename: command[UPLOAD_START_FILENAME],
            size: command[UPLOAD_START_SIZE],
            mimeType: command[UPLOAD_START_MIME_TYPE],
        };
    }
    if (type === UPLOAD_END_TYPE) {
        return {
            type: 'upload_end',
            requestId: command[SEND_REQUEST_ID],
            uploadId: command[UPLOAD_END_UPLOAD_ID],
        };
    }
    // UPLOAD_CHUNK_TYPE
    return encodeUploadChunk(
        ctx,
        command[UPLOAD_CHUNK_UPLOAD_ID],
        command[UPLOAD_CHUNK_INDEX],
        command[UPLOAD_CHUNK_DATA]
    ).buffer as ArrayBuffer;
};

// ── Validation ────────────────────────────────────────────────────────────────

export const validateOutgoingCommand = (
    command: SendCommand
): string | null => {
    const type = command[SEND_TYPE];
    if (type === JOIN_TYPE) {
        const nickname = command[JOIN_NICKNAME].trim();
        if (nickname.length === 0 || nickname.length > MAX_NICKNAME_LEN) {
            return `Nickname must be between 1 and ${MAX_NICKNAME_LEN} characters.`;
        }
        return null;
    }
    if (type === DELETE_TYPE) {
        const messageId = command[DELETE_MESSAGE_ID];
        if (!Number.isInteger(messageId) || messageId <= 0) {
            return 'Message id must be a positive integer.';
        }
        return null;
    }
    if (type === DOWNLOAD_REQUEST_TYPE) {
        const attachmentId = command[DOWNLOAD_REQUEST_ATTACHMENT_ID];
        if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
            return 'Attachment id must be a positive integer.';
        }
        return null;
    }
    if (
        type === UPLOAD_START_TYPE ||
        type === UPLOAD_END_TYPE ||
        type === UPLOAD_CHUNK_TYPE
    ) {
        return null;
    }
    const body = command[MESSAGE_BODY].trim();
    if (body.length === 0 || body.length > MAX_MESSAGE_LEN) {
        return `Message must be between 1 and ${MAX_MESSAGE_LEN} characters.`;
    }
    return null;
};
