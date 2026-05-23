// @generated from chat.proto — do not edit by hand
// Re-generate: cargo build (server/build.rs) then bazel run //assets/js/tools:gen-proto

import {
    encodeUint32Field,
    encodeStringField,
    encodeBytesField,
    encodeMessageField,
    encodeRepeatedMessage,
    concatBytes,
    readerCreate,
    readerAtEnd,
    readerTag,
    readerVarint,
    readerString,
    readerBytes,
    readerMessage,
    readerSkip,
    decodeOneofFrame,
} from '../../utils/proto-utils';

declare global { interface Window { Uint8Array: typeof Uint8Array; } }
export const CLIENT_FRAME_JOIN = 1 as const;
export const CLIENT_FRAME_MESSAGE = 2 as const;
export const CLIENT_FRAME_DELETE = 3 as const;
export const CLIENT_FRAME_UPLOAD_START = 4 as const;
export const CLIENT_FRAME_UPLOAD_END = 5 as const;
export const CLIENT_FRAME_DOWNLOAD_REQUEST = 6 as const;
export const CLIENT_FRAME_UPLOAD_CHUNK = 7 as const;

export const CLIENT_FRAME_PAYLOAD_VARIANT = 0 as const;
export const CLIENT_FRAME_PAYLOAD_VALUE   = 1 as const;

export type ClientFramePayload =
    | readonly [variant: typeof CLIENT_FRAME_JOIN, value: ClientJoin]
    | readonly [variant: typeof CLIENT_FRAME_MESSAGE, value: ClientMessage]
    | readonly [variant: typeof CLIENT_FRAME_DELETE, value: ClientDelete]
    | readonly [variant: typeof CLIENT_FRAME_UPLOAD_START, value: ClientUploadStart]
    | readonly [variant: typeof CLIENT_FRAME_UPLOAD_END, value: ClientUploadEnd]
    | readonly [variant: typeof CLIENT_FRAME_DOWNLOAD_REQUEST, value: ClientDownloadRequest]
    | readonly [variant: typeof CLIENT_FRAME_UPLOAD_CHUNK, value: UploadChunk];

export const encodeClientFrame = (
    ctx: Window,
    payload: ClientFramePayload,
): Uint8Array => {
    switch (payload[CLIENT_FRAME_PAYLOAD_VARIANT]) {
        case CLIENT_FRAME_JOIN: return encodeMessageField(ctx, 1, payload[CLIENT_FRAME_PAYLOAD_VALUE], encodeClientJoin);
        case CLIENT_FRAME_MESSAGE: return encodeMessageField(ctx, 2, payload[CLIENT_FRAME_PAYLOAD_VALUE], encodeClientMessage);
        case CLIENT_FRAME_DELETE: return encodeMessageField(ctx, 3, payload[CLIENT_FRAME_PAYLOAD_VALUE], encodeClientDelete);
        case CLIENT_FRAME_UPLOAD_START: return encodeMessageField(ctx, 4, payload[CLIENT_FRAME_PAYLOAD_VALUE], encodeClientUploadStart);
        case CLIENT_FRAME_UPLOAD_END: return encodeMessageField(ctx, 5, payload[CLIENT_FRAME_PAYLOAD_VALUE], encodeClientUploadEnd);
        case CLIENT_FRAME_DOWNLOAD_REQUEST: return encodeMessageField(ctx, 6, payload[CLIENT_FRAME_PAYLOAD_VALUE], encodeClientDownloadRequest);
        case CLIENT_FRAME_UPLOAD_CHUNK: return encodeMessageField(ctx, 7, payload[CLIENT_FRAME_PAYLOAD_VALUE], encodeUploadChunk);
        default: return new ctx.Uint8Array(0);
    }
};

export const decodeClientFrame = (
    ctx: Window,
    buf: Uint8Array,
): ClientFramePayload | null =>
    decodeOneofFrame(ctx, buf, [
        undefined,
        [CLIENT_FRAME_JOIN, decodeClientJoin],
        [CLIENT_FRAME_MESSAGE, decodeClientMessage],
        [CLIENT_FRAME_DELETE, decodeClientDelete],
        [CLIENT_FRAME_UPLOAD_START, decodeClientUploadStart],
        [CLIENT_FRAME_UPLOAD_END, decodeClientUploadEnd],
        [CLIENT_FRAME_DOWNLOAD_REQUEST, decodeClientDownloadRequest],
        [CLIENT_FRAME_UPLOAD_CHUNK, decodeUploadChunk],
    ]) as unknown as ClientFramePayload | null;
export const SERVER_FRAME_JOINED = 1 as const;
export const SERVER_FRAME_HISTORY = 2 as const;
export const SERVER_FRAME_MESSAGE = 3 as const;
export const SERVER_FRAME_DELETED = 4 as const;
export const SERVER_FRAME_ERROR = 5 as const;
export const SERVER_FRAME_UPLOAD_READY = 6 as const;
export const SERVER_FRAME_UPLOAD_DONE = 7 as const;
export const SERVER_FRAME_DOWNLOAD_START = 8 as const;
export const SERVER_FRAME_DOWNLOAD_END = 9 as const;
export const SERVER_FRAME_DOWNLOAD_CHUNK = 10 as const;

export const SERVER_FRAME_PAYLOAD_VARIANT = 0 as const;
export const SERVER_FRAME_PAYLOAD_VALUE   = 1 as const;

export type ServerFramePayload =
    | readonly [variant: typeof SERVER_FRAME_JOINED, value: ServerJoined]
    | readonly [variant: typeof SERVER_FRAME_HISTORY, value: ServerHistory]
    | readonly [variant: typeof SERVER_FRAME_MESSAGE, value: ServerMessage]
    | readonly [variant: typeof SERVER_FRAME_DELETED, value: ServerDeleted]
    | readonly [variant: typeof SERVER_FRAME_ERROR, value: ServerError]
    | readonly [variant: typeof SERVER_FRAME_UPLOAD_READY, value: ServerUploadReady]
    | readonly [variant: typeof SERVER_FRAME_UPLOAD_DONE, value: ServerUploadDone]
    | readonly [variant: typeof SERVER_FRAME_DOWNLOAD_START, value: ServerDownloadStart]
    | readonly [variant: typeof SERVER_FRAME_DOWNLOAD_END, value: ServerDownloadEnd]
    | readonly [variant: typeof SERVER_FRAME_DOWNLOAD_CHUNK, value: DownloadChunk];

export const encodeServerFrame = (
    ctx: Window,
    payload: ServerFramePayload,
): Uint8Array => {
    switch (payload[SERVER_FRAME_PAYLOAD_VARIANT]) {
        case SERVER_FRAME_JOINED: return encodeMessageField(ctx, 1, payload[SERVER_FRAME_PAYLOAD_VALUE], encodeServerJoined);
        case SERVER_FRAME_HISTORY: return encodeMessageField(ctx, 2, payload[SERVER_FRAME_PAYLOAD_VALUE], encodeServerHistory);
        case SERVER_FRAME_MESSAGE: return encodeMessageField(ctx, 3, payload[SERVER_FRAME_PAYLOAD_VALUE], encodeServerMessage);
        case SERVER_FRAME_DELETED: return encodeMessageField(ctx, 4, payload[SERVER_FRAME_PAYLOAD_VALUE], encodeServerDeleted);
        case SERVER_FRAME_ERROR: return encodeMessageField(ctx, 5, payload[SERVER_FRAME_PAYLOAD_VALUE], encodeServerError);
        case SERVER_FRAME_UPLOAD_READY: return encodeMessageField(ctx, 6, payload[SERVER_FRAME_PAYLOAD_VALUE], encodeServerUploadReady);
        case SERVER_FRAME_UPLOAD_DONE: return encodeMessageField(ctx, 7, payload[SERVER_FRAME_PAYLOAD_VALUE], encodeServerUploadDone);
        case SERVER_FRAME_DOWNLOAD_START: return encodeMessageField(ctx, 8, payload[SERVER_FRAME_PAYLOAD_VALUE], encodeServerDownloadStart);
        case SERVER_FRAME_DOWNLOAD_END: return encodeMessageField(ctx, 9, payload[SERVER_FRAME_PAYLOAD_VALUE], encodeServerDownloadEnd);
        case SERVER_FRAME_DOWNLOAD_CHUNK: return encodeMessageField(ctx, 10, payload[SERVER_FRAME_PAYLOAD_VALUE], encodeDownloadChunk);
        default: return new ctx.Uint8Array(0);
    }
};

export const decodeServerFrame = (
    ctx: Window,
    buf: Uint8Array,
): ServerFramePayload | null =>
    decodeOneofFrame(ctx, buf, [
        undefined,
        [SERVER_FRAME_JOINED, decodeServerJoined],
        [SERVER_FRAME_HISTORY, decodeServerHistory],
        [SERVER_FRAME_MESSAGE, decodeServerMessage],
        [SERVER_FRAME_DELETED, decodeServerDeleted],
        [SERVER_FRAME_ERROR, decodeServerError],
        [SERVER_FRAME_UPLOAD_READY, decodeServerUploadReady],
        [SERVER_FRAME_UPLOAD_DONE, decodeServerUploadDone],
        [SERVER_FRAME_DOWNLOAD_START, decodeServerDownloadStart],
        [SERVER_FRAME_DOWNLOAD_END, decodeServerDownloadEnd],
        [SERVER_FRAME_DOWNLOAD_CHUNK, decodeDownloadChunk],
    ]) as unknown as ServerFramePayload | null;
export type ClientJoin = readonly [
    requestId: string,
    nickname: string
];

export const CLIENT_JOIN_REQUEST_ID = 0 as const;
export const CLIENT_JOIN_NICKNAME = 1 as const;

export const encodeClientJoin = (
    ctx: Window,
    requestId: string,
    nickname: string
): Uint8Array =>
    concatBytes(ctx, [
        ...encodeStringField(ctx, 1, requestId),
        ...encodeStringField(ctx, 2, nickname),
    ]);

export const decodeClientJoin = (
    ctx: Window,
    buf: Uint8Array,
): ClientJoin | null => {
    const reader = readerCreate(ctx, buf);
    const fields: unknown[] = ['', ''];
    while (!readerAtEnd(reader)) {
        switch (readerTag(reader)) {
            case 1: fields[CLIENT_JOIN_REQUEST_ID] = readerString(reader); break;
            case 2: fields[CLIENT_JOIN_NICKNAME] = readerString(reader); break;
            default: if (!readerSkip(reader)) return null;
        }
    }
    return fields as unknown as ClientJoin;
};
export type ClientMessage = readonly [
    requestId: string,
    body: string
];

export const CLIENT_MESSAGE_REQUEST_ID = 0 as const;
export const CLIENT_MESSAGE_BODY = 1 as const;

export const encodeClientMessage = (
    ctx: Window,
    requestId: string,
    body: string
): Uint8Array =>
    concatBytes(ctx, [
        ...encodeStringField(ctx, 1, requestId),
        ...encodeStringField(ctx, 2, body),
    ]);

export const decodeClientMessage = (
    ctx: Window,
    buf: Uint8Array,
): ClientMessage | null => {
    const reader = readerCreate(ctx, buf);
    const fields: unknown[] = ['', ''];
    while (!readerAtEnd(reader)) {
        switch (readerTag(reader)) {
            case 1: fields[CLIENT_MESSAGE_REQUEST_ID] = readerString(reader); break;
            case 2: fields[CLIENT_MESSAGE_BODY] = readerString(reader); break;
            default: if (!readerSkip(reader)) return null;
        }
    }
    return fields as unknown as ClientMessage;
};
export type ClientDelete = readonly [
    requestId: string,
    messageId: number
];

export const CLIENT_DELETE_REQUEST_ID = 0 as const;
export const CLIENT_DELETE_MESSAGE_ID = 1 as const;

export const encodeClientDelete = (
    ctx: Window,
    requestId: string,
    messageId: number
): Uint8Array =>
    concatBytes(ctx, [
        ...encodeStringField(ctx, 1, requestId),
        ...encodeUint32Field(ctx, 2, messageId),
    ]);

export const decodeClientDelete = (
    ctx: Window,
    buf: Uint8Array,
): ClientDelete | null => {
    const reader = readerCreate(ctx, buf);
    const fields: unknown[] = ['', 0];
    while (!readerAtEnd(reader)) {
        switch (readerTag(reader)) {
            case 1: fields[CLIENT_DELETE_REQUEST_ID] = readerString(reader); break;
            case 2: fields[CLIENT_DELETE_MESSAGE_ID] = readerVarint(reader); break;
            default: if (!readerSkip(reader)) return null;
        }
    }
    return fields as unknown as ClientDelete;
};
export type ClientUploadStart = readonly [
    requestId: string,
    messageId: number,
    filename: string,
    size: number,
    mimeType: string
];

export const CLIENT_UPLOAD_START_REQUEST_ID = 0 as const;
export const CLIENT_UPLOAD_START_MESSAGE_ID = 1 as const;
export const CLIENT_UPLOAD_START_FILENAME = 2 as const;
export const CLIENT_UPLOAD_START_SIZE = 3 as const;
export const CLIENT_UPLOAD_START_MIME_TYPE = 4 as const;

export const encodeClientUploadStart = (
    ctx: Window,
    requestId: string,
    messageId: number,
    filename: string,
    size: number,
    mimeType: string
): Uint8Array =>
    concatBytes(ctx, [
        ...encodeStringField(ctx, 1, requestId),
        ...encodeUint32Field(ctx, 2, messageId),
        ...encodeStringField(ctx, 3, filename),
        ...encodeUint32Field(ctx, 4, size),
        ...encodeStringField(ctx, 5, mimeType),
    ]);

export const decodeClientUploadStart = (
    ctx: Window,
    buf: Uint8Array,
): ClientUploadStart | null => {
    const reader = readerCreate(ctx, buf);
    const fields: unknown[] = ['', 0, '', 0, ''];
    while (!readerAtEnd(reader)) {
        switch (readerTag(reader)) {
            case 1: fields[CLIENT_UPLOAD_START_REQUEST_ID] = readerString(reader); break;
            case 2: fields[CLIENT_UPLOAD_START_MESSAGE_ID] = readerVarint(reader); break;
            case 3: fields[CLIENT_UPLOAD_START_FILENAME] = readerString(reader); break;
            case 4: fields[CLIENT_UPLOAD_START_SIZE] = readerVarint(reader); break;
            case 5: fields[CLIENT_UPLOAD_START_MIME_TYPE] = readerString(reader); break;
            default: if (!readerSkip(reader)) return null;
        }
    }
    return fields as unknown as ClientUploadStart;
};
export type ClientUploadEnd = readonly [
    requestId: string,
    uploadId: number
];

export const CLIENT_UPLOAD_END_REQUEST_ID = 0 as const;
export const CLIENT_UPLOAD_END_UPLOAD_ID = 1 as const;

export const encodeClientUploadEnd = (
    ctx: Window,
    requestId: string,
    uploadId: number
): Uint8Array =>
    concatBytes(ctx, [
        ...encodeStringField(ctx, 1, requestId),
        ...encodeUint32Field(ctx, 2, uploadId),
    ]);

export const decodeClientUploadEnd = (
    ctx: Window,
    buf: Uint8Array,
): ClientUploadEnd | null => {
    const reader = readerCreate(ctx, buf);
    const fields: unknown[] = ['', 0];
    while (!readerAtEnd(reader)) {
        switch (readerTag(reader)) {
            case 1: fields[CLIENT_UPLOAD_END_REQUEST_ID] = readerString(reader); break;
            case 2: fields[CLIENT_UPLOAD_END_UPLOAD_ID] = readerVarint(reader); break;
            default: if (!readerSkip(reader)) return null;
        }
    }
    return fields as unknown as ClientUploadEnd;
};
export type ClientDownloadRequest = readonly [
    requestId: string,
    attachmentId: number
];

export const CLIENT_DOWNLOAD_REQUEST_REQUEST_ID = 0 as const;
export const CLIENT_DOWNLOAD_REQUEST_ATTACHMENT_ID = 1 as const;

export const encodeClientDownloadRequest = (
    ctx: Window,
    requestId: string,
    attachmentId: number
): Uint8Array =>
    concatBytes(ctx, [
        ...encodeStringField(ctx, 1, requestId),
        ...encodeUint32Field(ctx, 2, attachmentId),
    ]);

export const decodeClientDownloadRequest = (
    ctx: Window,
    buf: Uint8Array,
): ClientDownloadRequest | null => {
    const reader = readerCreate(ctx, buf);
    const fields: unknown[] = ['', 0];
    while (!readerAtEnd(reader)) {
        switch (readerTag(reader)) {
            case 1: fields[CLIENT_DOWNLOAD_REQUEST_REQUEST_ID] = readerString(reader); break;
            case 2: fields[CLIENT_DOWNLOAD_REQUEST_ATTACHMENT_ID] = readerVarint(reader); break;
            default: if (!readerSkip(reader)) return null;
        }
    }
    return fields as unknown as ClientDownloadRequest;
};
export type UploadChunk = readonly [
    uploadId: number,
    index: number,
    data: Uint8Array
];

export const UPLOAD_CHUNK_UPLOAD_ID = 0 as const;
export const UPLOAD_CHUNK_INDEX = 1 as const;
export const UPLOAD_CHUNK_DATA = 2 as const;

export const encodeUploadChunk = (
    ctx: Window,
    uploadId: number,
    index: number,
    data: Uint8Array
): Uint8Array =>
    concatBytes(ctx, [
        ...encodeUint32Field(ctx, 1, uploadId),
        ...encodeUint32Field(ctx, 2, index),
        ...encodeBytesField(ctx, 3, data),
    ]);

export const decodeUploadChunk = (
    ctx: Window,
    buf: Uint8Array,
): UploadChunk | null => {
    const reader = readerCreate(ctx, buf);
    const fields: unknown[] = [0, 0, new ctx.Uint8Array(0)];
    while (!readerAtEnd(reader)) {
        switch (readerTag(reader)) {
            case 1: fields[UPLOAD_CHUNK_UPLOAD_ID] = readerVarint(reader); break;
            case 2: fields[UPLOAD_CHUNK_INDEX] = readerVarint(reader); break;
            case 3: fields[UPLOAD_CHUNK_DATA] = readerBytes(reader); break;
            default: if (!readerSkip(reader)) return null;
        }
    }
    return fields as unknown as UploadChunk;
};
export type ServerJoined = readonly [
    requestId: string,
    senderId: string,
    senderName: string
];

export const SERVER_JOINED_REQUEST_ID = 0 as const;
export const SERVER_JOINED_SENDER_ID = 1 as const;
export const SERVER_JOINED_SENDER_NAME = 2 as const;

export const encodeServerJoined = (
    ctx: Window,
    requestId: string,
    senderId: string,
    senderName: string
): Uint8Array =>
    concatBytes(ctx, [
        ...encodeStringField(ctx, 1, requestId),
        ...encodeStringField(ctx, 2, senderId),
        ...encodeStringField(ctx, 3, senderName),
    ]);

export const decodeServerJoined = (
    ctx: Window,
    buf: Uint8Array,
): ServerJoined | null => {
    const reader = readerCreate(ctx, buf);
    const fields: unknown[] = ['', '', ''];
    while (!readerAtEnd(reader)) {
        switch (readerTag(reader)) {
            case 1: fields[SERVER_JOINED_REQUEST_ID] = readerString(reader); break;
            case 2: fields[SERVER_JOINED_SENDER_ID] = readerString(reader); break;
            case 3: fields[SERVER_JOINED_SENDER_NAME] = readerString(reader); break;
            default: if (!readerSkip(reader)) return null;
        }
    }
    return fields as unknown as ServerJoined;
};
export type AttachmentItem = readonly [
    id: number,
    filename: string,
    size: number,
    mimeType: string
];

export const ATTACHMENT_ITEM_ID = 0 as const;
export const ATTACHMENT_ITEM_FILENAME = 1 as const;
export const ATTACHMENT_ITEM_SIZE = 2 as const;
export const ATTACHMENT_ITEM_MIME_TYPE = 3 as const;

export const encodeAttachmentItem = (
    ctx: Window,
    id: number,
    filename: string,
    size: number,
    mimeType: string
): Uint8Array =>
    concatBytes(ctx, [
        ...encodeUint32Field(ctx, 1, id),
        ...encodeStringField(ctx, 2, filename),
        ...encodeUint32Field(ctx, 3, size),
        ...encodeStringField(ctx, 4, mimeType),
    ]);

export const decodeAttachmentItem = (
    ctx: Window,
    buf: Uint8Array,
): AttachmentItem | null => {
    const reader = readerCreate(ctx, buf);
    const fields: unknown[] = [0, '', 0, ''];
    while (!readerAtEnd(reader)) {
        switch (readerTag(reader)) {
            case 1: fields[ATTACHMENT_ITEM_ID] = readerVarint(reader); break;
            case 2: fields[ATTACHMENT_ITEM_FILENAME] = readerString(reader); break;
            case 3: fields[ATTACHMENT_ITEM_SIZE] = readerVarint(reader); break;
            case 4: fields[ATTACHMENT_ITEM_MIME_TYPE] = readerString(reader); break;
            default: if (!readerSkip(reader)) return null;
        }
    }
    return fields as unknown as AttachmentItem;
};
export type ChatItem = readonly [
    id: number,
    roomId: string,
    senderId: string,
    senderName: string,
    body: string,
    createdAt: string,
    attachments: AttachmentItem[]
];

export const CHAT_ITEM_ID = 0 as const;
export const CHAT_ITEM_ROOM_ID = 1 as const;
export const CHAT_ITEM_SENDER_ID = 2 as const;
export const CHAT_ITEM_SENDER_NAME = 3 as const;
export const CHAT_ITEM_BODY = 4 as const;
export const CHAT_ITEM_CREATED_AT = 5 as const;
export const CHAT_ITEM_ATTACHMENTS = 6 as const;

export const encodeChatItem = (
    ctx: Window,
    id: number,
    roomId: string,
    senderId: string,
    senderName: string,
    body: string,
    createdAt: string,
    attachments: readonly AttachmentItem[]
): Uint8Array =>
    concatBytes(ctx, [
        ...encodeUint32Field(ctx, 1, id),
        ...encodeStringField(ctx, 2, roomId),
        ...encodeStringField(ctx, 3, senderId),
        ...encodeStringField(ctx, 4, senderName),
        ...encodeStringField(ctx, 5, body),
        ...encodeStringField(ctx, 6, createdAt),
        ...encodeRepeatedMessage(ctx, 7, attachments, encodeAttachmentItem),
    ]);

export const decodeChatItem = (
    ctx: Window,
    buf: Uint8Array,
): ChatItem | null => {
    const reader = readerCreate(ctx, buf);
    const fields: unknown[] = [0, '', '', '', '', '', []];
    while (!readerAtEnd(reader)) {
        switch (readerTag(reader)) {
            case 1: fields[CHAT_ITEM_ID] = readerVarint(reader); break;
            case 2: fields[CHAT_ITEM_ROOM_ID] = readerString(reader); break;
            case 3: fields[CHAT_ITEM_SENDER_ID] = readerString(reader); break;
            case 4: fields[CHAT_ITEM_SENDER_NAME] = readerString(reader); break;
            case 5: fields[CHAT_ITEM_BODY] = readerString(reader); break;
            case 6: fields[CHAT_ITEM_CREATED_AT] = readerString(reader); break;
            case 7: ((fields[CHAT_ITEM_ATTACHMENTS] ??= []) as unknown[]).push(readerMessage(ctx, reader, decodeAttachmentItem)); break;
            default: if (!readerSkip(reader)) return null;
        }
    }
    return fields as unknown as ChatItem;
};
export type ServerHistory = readonly [
    items: ChatItem[]
];

export const SERVER_HISTORY_ITEMS = 0 as const;

export const encodeServerHistory = (
    ctx: Window,
    items: readonly ChatItem[]
): Uint8Array =>
    concatBytes(ctx, [
        ...encodeRepeatedMessage(ctx, 1, items, encodeChatItem),
    ]);

export const decodeServerHistory = (
    ctx: Window,
    buf: Uint8Array,
): ServerHistory | null => {
    const reader = readerCreate(ctx, buf);
    const fields: unknown[] = [[]];
    while (!readerAtEnd(reader)) {
        switch (readerTag(reader)) {
            case 1: ((fields[SERVER_HISTORY_ITEMS] ??= []) as unknown[]).push(readerMessage(ctx, reader, decodeChatItem)); break;
            default: if (!readerSkip(reader)) return null;
        }
    }
    return fields as unknown as ServerHistory;
};
export type ServerMessage = readonly [
    item: ChatItem,
    requestId: string
];

export const SERVER_MESSAGE_ITEM = 0 as const;
export const SERVER_MESSAGE_REQUEST_ID = 1 as const;

export const encodeServerMessage = (
    ctx: Window,
    item: ChatItem,
    requestId: string
): Uint8Array =>
    concatBytes(ctx, [
        encodeMessageField(ctx, 1, item, encodeChatItem),
        ...encodeStringField(ctx, 2, requestId),
    ]);

export const decodeServerMessage = (
    ctx: Window,
    buf: Uint8Array,
): ServerMessage | null => {
    const reader = readerCreate(ctx, buf);
    const fields: unknown[] = [null, ''];
    while (!readerAtEnd(reader)) {
        switch (readerTag(reader)) {
            case 1: fields[SERVER_MESSAGE_ITEM] = readerMessage(ctx, reader, decodeChatItem); break;
            case 2: fields[SERVER_MESSAGE_REQUEST_ID] = readerString(reader); break;
            default: if (!readerSkip(reader)) return null;
        }
    }
    return fields as unknown as ServerMessage;
};
export type ServerDeleted = readonly [
    messageId: number
];

export const SERVER_DELETED_MESSAGE_ID = 0 as const;

export const encodeServerDeleted = (
    ctx: Window,
    messageId: number
): Uint8Array =>
    concatBytes(ctx, [
        ...encodeUint32Field(ctx, 1, messageId),
    ]);

export const decodeServerDeleted = (
    ctx: Window,
    buf: Uint8Array,
): ServerDeleted | null => {
    const reader = readerCreate(ctx, buf);
    const fields: unknown[] = [0];
    while (!readerAtEnd(reader)) {
        switch (readerTag(reader)) {
            case 1: fields[SERVER_DELETED_MESSAGE_ID] = readerVarint(reader); break;
            default: if (!readerSkip(reader)) return null;
        }
    }
    return fields as unknown as ServerDeleted;
};
export type ServerError = readonly [
    requestId: string,
    code: string,
    message: string
];

export const SERVER_ERROR_REQUEST_ID = 0 as const;
export const SERVER_ERROR_CODE = 1 as const;
export const SERVER_ERROR_MESSAGE = 2 as const;

export const encodeServerError = (
    ctx: Window,
    requestId: string,
    code: string,
    message: string
): Uint8Array =>
    concatBytes(ctx, [
        ...encodeStringField(ctx, 1, requestId),
        ...encodeStringField(ctx, 2, code),
        ...encodeStringField(ctx, 3, message),
    ]);

export const decodeServerError = (
    ctx: Window,
    buf: Uint8Array,
): ServerError | null => {
    const reader = readerCreate(ctx, buf);
    const fields: unknown[] = ['', '', ''];
    while (!readerAtEnd(reader)) {
        switch (readerTag(reader)) {
            case 1: fields[SERVER_ERROR_REQUEST_ID] = readerString(reader); break;
            case 2: fields[SERVER_ERROR_CODE] = readerString(reader); break;
            case 3: fields[SERVER_ERROR_MESSAGE] = readerString(reader); break;
            default: if (!readerSkip(reader)) return null;
        }
    }
    return fields as unknown as ServerError;
};
export type ServerUploadReady = readonly [
    requestId: string,
    uploadId: number
];

export const SERVER_UPLOAD_READY_REQUEST_ID = 0 as const;
export const SERVER_UPLOAD_READY_UPLOAD_ID = 1 as const;

export const encodeServerUploadReady = (
    ctx: Window,
    requestId: string,
    uploadId: number
): Uint8Array =>
    concatBytes(ctx, [
        ...encodeStringField(ctx, 1, requestId),
        ...encodeUint32Field(ctx, 2, uploadId),
    ]);

export const decodeServerUploadReady = (
    ctx: Window,
    buf: Uint8Array,
): ServerUploadReady | null => {
    const reader = readerCreate(ctx, buf);
    const fields: unknown[] = ['', 0];
    while (!readerAtEnd(reader)) {
        switch (readerTag(reader)) {
            case 1: fields[SERVER_UPLOAD_READY_REQUEST_ID] = readerString(reader); break;
            case 2: fields[SERVER_UPLOAD_READY_UPLOAD_ID] = readerVarint(reader); break;
            default: if (!readerSkip(reader)) return null;
        }
    }
    return fields as unknown as ServerUploadReady;
};
export type ServerUploadDone = readonly [
    requestId: string,
    attachmentId: number,
    filename: string,
    size: number,
    mimeType: string,
    messageId: number
];

export const SERVER_UPLOAD_DONE_REQUEST_ID = 0 as const;
export const SERVER_UPLOAD_DONE_ATTACHMENT_ID = 1 as const;
export const SERVER_UPLOAD_DONE_FILENAME = 2 as const;
export const SERVER_UPLOAD_DONE_SIZE = 3 as const;
export const SERVER_UPLOAD_DONE_MIME_TYPE = 4 as const;
export const SERVER_UPLOAD_DONE_MESSAGE_ID = 5 as const;

export const encodeServerUploadDone = (
    ctx: Window,
    requestId: string,
    attachmentId: number,
    filename: string,
    size: number,
    mimeType: string,
    messageId: number
): Uint8Array =>
    concatBytes(ctx, [
        ...encodeStringField(ctx, 1, requestId),
        ...encodeUint32Field(ctx, 2, attachmentId),
        ...encodeStringField(ctx, 3, filename),
        ...encodeUint32Field(ctx, 4, size),
        ...encodeStringField(ctx, 5, mimeType),
        ...encodeUint32Field(ctx, 6, messageId),
    ]);

export const decodeServerUploadDone = (
    ctx: Window,
    buf: Uint8Array,
): ServerUploadDone | null => {
    const reader = readerCreate(ctx, buf);
    const fields: unknown[] = ['', 0, '', 0, '', 0];
    while (!readerAtEnd(reader)) {
        switch (readerTag(reader)) {
            case 1: fields[SERVER_UPLOAD_DONE_REQUEST_ID] = readerString(reader); break;
            case 2: fields[SERVER_UPLOAD_DONE_ATTACHMENT_ID] = readerVarint(reader); break;
            case 3: fields[SERVER_UPLOAD_DONE_FILENAME] = readerString(reader); break;
            case 4: fields[SERVER_UPLOAD_DONE_SIZE] = readerVarint(reader); break;
            case 5: fields[SERVER_UPLOAD_DONE_MIME_TYPE] = readerString(reader); break;
            case 6: fields[SERVER_UPLOAD_DONE_MESSAGE_ID] = readerVarint(reader); break;
            default: if (!readerSkip(reader)) return null;
        }
    }
    return fields as unknown as ServerUploadDone;
};
export type ServerDownloadStart = readonly [
    requestId: string,
    attachmentId: number,
    filename: string,
    size: number,
    mimeType: string,
    totalChunks: number
];

export const SERVER_DOWNLOAD_START_REQUEST_ID = 0 as const;
export const SERVER_DOWNLOAD_START_ATTACHMENT_ID = 1 as const;
export const SERVER_DOWNLOAD_START_FILENAME = 2 as const;
export const SERVER_DOWNLOAD_START_SIZE = 3 as const;
export const SERVER_DOWNLOAD_START_MIME_TYPE = 4 as const;
export const SERVER_DOWNLOAD_START_TOTAL_CHUNKS = 5 as const;

export const encodeServerDownloadStart = (
    ctx: Window,
    requestId: string,
    attachmentId: number,
    filename: string,
    size: number,
    mimeType: string,
    totalChunks: number
): Uint8Array =>
    concatBytes(ctx, [
        ...encodeStringField(ctx, 1, requestId),
        ...encodeUint32Field(ctx, 2, attachmentId),
        ...encodeStringField(ctx, 3, filename),
        ...encodeUint32Field(ctx, 4, size),
        ...encodeStringField(ctx, 5, mimeType),
        ...encodeUint32Field(ctx, 6, totalChunks),
    ]);

export const decodeServerDownloadStart = (
    ctx: Window,
    buf: Uint8Array,
): ServerDownloadStart | null => {
    const reader = readerCreate(ctx, buf);
    const fields: unknown[] = ['', 0, '', 0, '', 0];
    while (!readerAtEnd(reader)) {
        switch (readerTag(reader)) {
            case 1: fields[SERVER_DOWNLOAD_START_REQUEST_ID] = readerString(reader); break;
            case 2: fields[SERVER_DOWNLOAD_START_ATTACHMENT_ID] = readerVarint(reader); break;
            case 3: fields[SERVER_DOWNLOAD_START_FILENAME] = readerString(reader); break;
            case 4: fields[SERVER_DOWNLOAD_START_SIZE] = readerVarint(reader); break;
            case 5: fields[SERVER_DOWNLOAD_START_MIME_TYPE] = readerString(reader); break;
            case 6: fields[SERVER_DOWNLOAD_START_TOTAL_CHUNKS] = readerVarint(reader); break;
            default: if (!readerSkip(reader)) return null;
        }
    }
    return fields as unknown as ServerDownloadStart;
};
export type ServerDownloadEnd = readonly [
    requestId: string,
    attachmentId: number
];

export const SERVER_DOWNLOAD_END_REQUEST_ID = 0 as const;
export const SERVER_DOWNLOAD_END_ATTACHMENT_ID = 1 as const;

export const encodeServerDownloadEnd = (
    ctx: Window,
    requestId: string,
    attachmentId: number
): Uint8Array =>
    concatBytes(ctx, [
        ...encodeStringField(ctx, 1, requestId),
        ...encodeUint32Field(ctx, 2, attachmentId),
    ]);

export const decodeServerDownloadEnd = (
    ctx: Window,
    buf: Uint8Array,
): ServerDownloadEnd | null => {
    const reader = readerCreate(ctx, buf);
    const fields: unknown[] = ['', 0];
    while (!readerAtEnd(reader)) {
        switch (readerTag(reader)) {
            case 1: fields[SERVER_DOWNLOAD_END_REQUEST_ID] = readerString(reader); break;
            case 2: fields[SERVER_DOWNLOAD_END_ATTACHMENT_ID] = readerVarint(reader); break;
            default: if (!readerSkip(reader)) return null;
        }
    }
    return fields as unknown as ServerDownloadEnd;
};
export type DownloadChunk = readonly [
    attachmentId: number,
    index: number,
    data: Uint8Array
];

export const DOWNLOAD_CHUNK_ATTACHMENT_ID = 0 as const;
export const DOWNLOAD_CHUNK_INDEX = 1 as const;
export const DOWNLOAD_CHUNK_DATA = 2 as const;

export const encodeDownloadChunk = (
    ctx: Window,
    attachmentId: number,
    index: number,
    data: Uint8Array
): Uint8Array =>
    concatBytes(ctx, [
        ...encodeUint32Field(ctx, 1, attachmentId),
        ...encodeUint32Field(ctx, 2, index),
        ...encodeBytesField(ctx, 3, data),
    ]);

export const decodeDownloadChunk = (
    ctx: Window,
    buf: Uint8Array,
): DownloadChunk | null => {
    const reader = readerCreate(ctx, buf);
    const fields: unknown[] = [0, 0, new ctx.Uint8Array(0)];
    while (!readerAtEnd(reader)) {
        switch (readerTag(reader)) {
            case 1: fields[DOWNLOAD_CHUNK_ATTACHMENT_ID] = readerVarint(reader); break;
            case 2: fields[DOWNLOAD_CHUNK_INDEX] = readerVarint(reader); break;
            case 3: fields[DOWNLOAD_CHUNK_DATA] = readerBytes(reader); break;
            default: if (!readerSkip(reader)) return null;
        }
    }
    return fields as unknown as DownloadChunk;
};
