import {
    pipe,
    taskMap,
    taskFork,
    noop,
    Task,
    ObserverInstance,
    observer,
    bindArgs,
    bindArg,
    trigger,
    on,
    off,
} from '../utils';
import {
    MAX_UPLOAD_SIZE,
    AttachmentMeta,
    WsEvent,
    ChatSocket,
    CHAT_SOCKET_OUTGOING,
    CHAT_SOCKET_INCOMING,
    UPLOAD_START_TYPE,
    UPLOAD_END_TYPE,
    UPLOAD_CHUNK_TYPE,
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
        FileReader: typeof FileReader;
        Uint8Array: typeof Uint8Array;
    }
}

// ── Upload event tuple ────────────────────────────────────────────────────────

export const UPLOAD_READY = 0 as const;
export const UPLOAD_DONE = 1 as const;
export const UPLOAD_ERROR = 2 as const;

export type UploadEvent =
    | readonly [type: typeof UPLOAD_READY, uploadId: number]
    | readonly [type: typeof UPLOAD_DONE, attachment: AttachmentMeta]
    | readonly [type: typeof UPLOAD_ERROR, code: string, message: string];

// ── Task helpers ──────────────────────────────────────────────────────────────

const CHUNK_SIZE = 64 * 1024;

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
        outgoing: ChatSocket[typeof CHAT_SOCKET_OUTGOING],
        uploadId: number,
        buffer: ArrayBuffer
    ): void => {
        const bytes = new ctx.Uint8Array(buffer);
        let offset = 0;
        let index = 0;
        while (offset < bytes.length) {
            const chunk = bytes.slice(offset, offset + CHUNK_SIZE);
            outgoing(
                bindArg(
                    [UPLOAD_CHUNK_TYPE, uploadId, index, chunk] as const,
                    trigger
                )
            );
            offset += CHUNK_SIZE;
            index++;
        }
    };

const sendUploadEnd =
    (
        outgoing: ChatSocket[typeof CHAT_SOCKET_OUTGOING],
        requestId: string,
        uploadId: number
    ): void => {
        outgoing(
            bindArg([UPLOAD_END_TYPE, requestId, uploadId] as const, trigger)
        );
    };

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start an upload flow for a single file attached to an existing message.
 * Subscribes to the shared WS observer for the lifetime of this upload.
 * Unsubscribes automatically on completion or error.
 * Returns an ObserverInstance that emits UPLOAD_READY, UPLOAD_DONE, or UPLOAD_ERROR.
 */
export const startUpload = (
    ctx: Window,
    socket: ChatSocket,
    requestId: string,
    messageId: number,
    file: File
): ObserverInstance<UploadEvent> => {
    const uploadEvents = observer<UploadEvent>();

    if (file.size === 0 || file.size > MAX_UPLOAD_SIZE) {
        uploadEvents(
            bindArg(
                [
                    UPLOAD_ERROR,
                    'UPLOAD_TOO_LARGE',
                    `File must be between 1 byte and ${MAX_UPLOAD_SIZE} bytes.`,
                ] as const,
                trigger
            )
        );
        return uploadEvents;
    }

    const outgoing = socket[CHAT_SOCKET_OUTGOING];
    const wsEvents = socket[CHAT_SOCKET_INCOMING];

    const handleEvent = (event: WsEvent): void => {
        if (
            event[WS_EVENT_TYPE] === WS_UPLOAD_READY &&
            event[WS_UPLOAD_READY_REQUEST_ID] === requestId
        ) {
            const uploadId = event[WS_UPLOAD_READY_UPLOAD_ID];
            uploadEvents(bindArg([UPLOAD_READY, uploadId] as const, trigger));
            pipe(
                readFileAsArrayBuffer(ctx, file),
                taskMap(bindArgs([ctx, outgoing, uploadId], sendChunks)),
                taskMap(
                    bindArgs([outgoing, requestId, uploadId], sendUploadEnd)
                ),
                taskFork(noop, (e) => {
                    unsubscribe();
                    uploadEvents(
                        bindArg(
                            [UPLOAD_ERROR, 'UPLOAD_FAILED', String(e)] as const,
                            trigger
                        )
                    );
                })
            );
            return;
        }

        if (
            event[WS_EVENT_TYPE] === WS_UPLOAD_DONE &&
            event[WS_UPLOAD_DONE_REQUEST_ID] === requestId
        ) {
            unsubscribe();
            uploadEvents(
                bindArg(
                    [UPLOAD_DONE, event[WS_UPLOAD_DONE_ATTACHMENT]] as const,
                    trigger
                )
            );
            return;
        }

        if (
            event[WS_EVENT_TYPE] === WS_ERROR &&
            event[WS_ERROR_REQUEST_ID] === requestId
        ) {
            unsubscribe();
            uploadEvents(
                bindArg(
                    [
                        UPLOAD_ERROR,
                        event[WS_ERROR_CODE],
                        event[WS_ERROR_MESSAGE],
                    ] as const,
                    trigger
                )
            );
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

    return uploadEvents;
};
