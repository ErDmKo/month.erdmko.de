import {
    pipe,
    taskChain,
    taskFork,
    noop,
    Task,
    bindArgs,
    bindArg,
    trigger,
    on,
    off,
} from '../utils';
import { encodeUploadChunk } from './attachments-proto';
import {
    MAX_UPLOAD_SIZE,
    AttachmentMeta,
    WsEvent,
    ChatSocket,
    CHAT_SOCKET_OUTGOING,
    CHAT_SOCKET_INCOMING,
    UPLOAD_START_TYPE,
    UPLOAD_END_TYPE,
    WS_EVENT_TYPE,
    WS_UPLOAD_READY,
    WS_UPLOAD_READY_REQUEST_ID,
    WS_UPLOAD_READY_UPLOAD_ID,
    WS_UPLOAD_DONE,
    WS_UPLOAD_DONE_REQUEST_ID,
    WS_UPLOAD_DONE_ATTACHMENT,
    WS_ERROR,
    WS_ERROR_REQUEST_ID,
    WS_ERROR_CODE,
    WS_ERROR_MESSAGE,
} from './protocol';

export { MAX_UPLOAD_SIZE } from './protocol';

declare global {
    interface Window {
        JSON: typeof JSON;
        FileReader: typeof FileReader;
        Uint8Array: typeof Uint8Array;
    }
}

const CHUNK_SIZE = 64 * 1024;

// ── Task helpers ──────────────────────────────────────────────────────────────

const readFileAsArrayBuffer =
    (ctx: Window, file: File): Task<ArrayBuffer> =>
    (resolve, reject) => {
        const reader = new ctx.FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
    };

const sendChunks =
    (
        ctx: Window,
        sendBinary: (data: ArrayBuffer) => void,
        uploadId: number,
        buffer: ArrayBuffer
    ): Task<void> =>
    (resolve) => {
        const bytes = new ctx.Uint8Array(buffer);
        let offset = 0;
        let index = 0;
        while (offset < bytes.length) {
            const chunk = bytes.slice(offset, offset + CHUNK_SIZE);
            sendBinary(
                encodeUploadChunk(ctx, uploadId, index, chunk)
                    .buffer as ArrayBuffer
            );
            offset += CHUNK_SIZE;
            index++;
        }
        resolve();
    };

const sendUploadEnd =
    (
        outgoing: ChatSocket[typeof CHAT_SOCKET_OUTGOING],
        requestId: string,
        uploadId: number
    ): Task<void> =>
    (resolve) => {
        outgoing(
            bindArg([UPLOAD_END_TYPE, requestId, uploadId] as const, trigger)
        );
        resolve();
    };

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start an upload flow for a single file attached to an existing message.
 * Subscribes to the shared WS observer and unsubscribes on completion or error.
 */
export const startUpload = (
    ctx: Window,
    socket: ChatSocket,
    sendBinary: (data: ArrayBuffer) => void,
    requestId: string,
    messageId: number,
    file: File,
    onReady: (uploadId: number) => void,
    onDone: (attachment: AttachmentMeta) => void,
    onError: (code: string, message: string) => void
): void => {
    if (file.size === 0 || file.size > MAX_UPLOAD_SIZE) {
        onError(
            'UPLOAD_TOO_LARGE',
            `File must be between 1 byte and ${MAX_UPLOAD_SIZE} bytes.`
        );
        return;
    }

    const outgoing = socket[CHAT_SOCKET_OUTGOING];
    const wsEvents = socket[CHAT_SOCKET_INCOMING];

    const handleEvent = (event: WsEvent): void => {
        if (
            event[WS_EVENT_TYPE] === WS_UPLOAD_READY &&
            event[WS_UPLOAD_READY_REQUEST_ID] === requestId
        ) {
            const uploadId = event[WS_UPLOAD_READY_UPLOAD_ID];
            onReady(uploadId);
            pipe(
                readFileAsArrayBuffer(ctx, file),
                taskChain(bindArgs([ctx, sendBinary, uploadId], sendChunks)),
                taskChain(
                    bindArgs([outgoing, requestId, uploadId], sendUploadEnd)
                ),
                taskFork(noop, (e) => {
                    unsubscribe();
                    onError('UPLOAD_FAILED', String(e));
                })
            );
            return;
        }

        if (
            event[WS_EVENT_TYPE] === WS_UPLOAD_DONE &&
            event[WS_UPLOAD_DONE_REQUEST_ID] === requestId
        ) {
            unsubscribe();
            onDone(event[WS_UPLOAD_DONE_ATTACHMENT]);
            return;
        }

        if (
            event[WS_EVENT_TYPE] === WS_ERROR &&
            event[WS_ERROR_REQUEST_ID] === requestId
        ) {
            unsubscribe();
            onError(event[WS_ERROR_CODE], event[WS_ERROR_MESSAGE]);
        }
    };
    const unsubscribe = bindArgs([handleEvent, wsEvents], off);

    on(handleEvent, wsEvents);

    outgoing(
        bindArg(
            [
                UPLOAD_START_TYPE,
                requestId,
                messageId,
                file.name,
                file.size,
                file.type || 'application/octet-stream',
            ] as const,
            trigger
        )
    );
};
