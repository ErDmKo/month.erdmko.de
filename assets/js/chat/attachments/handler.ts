import {
    ObserverInstance,
    domCreator,
    domCreatorRef,
    genClass,
    genProp,
    genRef,
    genTagName,
    observer,
    on,
    off,
    bindArgs,
    bindArg,
    trigger,
    pipe,
    taskMap,
    taskFork,
    noop,
    Task,
} from '../../utils';
import type { ReadonlyTupleOf, TupleOf } from '../../utils';
import { createStore } from '../../utils';
import {
    CHAT_SOCKET_OUTGOING,
    CHAT_SOCKET_INCOMING,
} from '../protocol/incoming';
import type { BaseChatSocket } from '../protocol/incoming';
import {
    SERVER_FRAME_PAYLOAD_VARIANT,
    SERVER_FRAME_PAYLOAD_VALUE,
    SERVER_FRAME_ERROR,
    SERVER_FRAME_UPLOAD_READY,
    SERVER_FRAME_UPLOAD_DONE,
    SERVER_FRAME_DOWNLOAD_START,
    SERVER_FRAME_DOWNLOAD_END,
    SERVER_FRAME_DOWNLOAD_CHUNK,
    SERVER_ERROR_REQUEST_ID,
    SERVER_ERROR_CODE,
    SERVER_ERROR_MESSAGE,
    SERVER_UPLOAD_READY_REQUEST_ID,
    SERVER_UPLOAD_READY_UPLOAD_ID,
    SERVER_UPLOAD_DONE_REQUEST_ID,
    SERVER_DOWNLOAD_START_REQUEST_ID,
    SERVER_DOWNLOAD_END_REQUEST_ID,
    DOWNLOAD_CHUNK_ATTACHMENT_ID,
    DOWNLOAD_CHUNK_INDEX,
    DOWNLOAD_CHUNK_DATA,
    CLIENT_FRAME_DOWNLOAD_REQUEST,
    CLIENT_FRAME_UPLOAD_START,
    CLIENT_FRAME_UPLOAD_END,
    CLIENT_FRAME_UPLOAD_CHUNK,
} from '@month/gen/chat';
import type { ServerFramePayload } from '@month/gen/chat';
export const MAX_UPLOAD_SIZE = 5 * 1024 * 1024;
import { ATTACHMENT_REF_PROGRESS, attachmentItemTemplate } from './template';
import {
    ATTACHMENT_ITEM_ID,
    ATTACHMENT_ITEM_FILENAME,
    ATTACHMENT_ITEM_SIZE,
    ATTACHMENT_ITEM_MIME_TYPE,
    SERVER_DOWNLOAD_START_TOTAL_CHUNKS,
    SERVER_DOWNLOAD_START_MIME_TYPE,
    SERVER_DOWNLOAD_START_FILENAME,
    SERVER_UPLOAD_DONE_ATTACHMENT_ID,
    SERVER_UPLOAD_DONE_FILENAME,
    SERVER_UPLOAD_DONE_SIZE,
    SERVER_UPLOAD_DONE_MIME_TYPE,
    SERVER_UPLOAD_DONE_MESSAGE_ID,
} from '@month/gen/chat';
import type {
    AttachmentItem,
    ServerDownloadStart,
    ServerUploadDone,
} from '@month/gen/chat';
export {
    uploadPreviewTemplate,
    UPLOAD_PREVIEW_REF_PROGRESS,
    UPLOAD_PREVIEW_REF_REMOVE,
} from './template';
export type { AttachmentItem } from '@month/gen/chat';

declare global {
    interface Window {
        FileReader: typeof FileReader;
        Uint8Array: typeof Uint8Array;
        Blob: typeof Blob;
        URL: typeof URL;
        Date: typeof Date;
    }
}

// ── Upload event tuple ────────────────────────────────────────────────────────

export const UPLOAD_READY = 0 as const;
export const UPLOAD_PROGRESS = 1 as const;
export const UPLOAD_DONE = 2 as const;
export const UPLOAD_ERROR = 3 as const;

export const UPLOAD_EVENT_TYPE = 0 as const;
export const UPLOAD_READY_ID = 1 as const;
export const UPLOAD_PROGRESS_SENT = 1 as const;
export const UPLOAD_PROGRESS_TOTAL = 2 as const;
export const UPLOAD_DONE_PAYLOAD = 1 as const;
export const UPLOAD_ERROR_CODE = 1 as const;
export const UPLOAD_ERROR_MESSAGE = 2 as const;

export type UploadEvent =
    | ReadonlyTupleOf<{
          [UPLOAD_EVENT_TYPE]: typeof UPLOAD_READY;
          [UPLOAD_READY_ID]: number;
      }>
    | ReadonlyTupleOf<{
          [UPLOAD_EVENT_TYPE]: typeof UPLOAD_PROGRESS;
          [UPLOAD_PROGRESS_SENT]: number;
          [UPLOAD_PROGRESS_TOTAL]: number;
      }>
    | ReadonlyTupleOf<{
          [UPLOAD_EVENT_TYPE]: typeof UPLOAD_DONE;
          [UPLOAD_DONE_PAYLOAD]: ServerUploadDone;
      }>
    | ReadonlyTupleOf<{
          [UPLOAD_EVENT_TYPE]: typeof UPLOAD_ERROR;
          [UPLOAD_ERROR_CODE]: string;
          [UPLOAD_ERROR_MESSAGE]: string;
      }>;

// ── Download event tuple ──────────────────────────────────────────────────────

export const DOWNLOAD_START = 0 as const;
export const DOWNLOAD_PROGRESS = 1 as const;
export const DOWNLOAD_DONE = 2 as const;
export const DOWNLOAD_ERROR = 3 as const;

export const DOWNLOAD_EVENT_TYPE = 0 as const;
export const DOWNLOAD_START_META = 1 as const;
export const DOWNLOAD_PROGRESS_RECEIVED = 1 as const;
export const DOWNLOAD_PROGRESS_TOTAL = 2 as const;
export const DOWNLOAD_DONE_BLOB = 1 as const;
export const DOWNLOAD_DONE_FILENAME = 2 as const;
export const DOWNLOAD_ERROR_CODE = 1 as const;
export const DOWNLOAD_ERROR_MESSAGE = 2 as const;

export type DownloadEvent =
    | ReadonlyTupleOf<{
          [DOWNLOAD_EVENT_TYPE]: typeof DOWNLOAD_START;
          [DOWNLOAD_START_META]: ServerDownloadStart;
      }>
    | ReadonlyTupleOf<{
          [DOWNLOAD_EVENT_TYPE]: typeof DOWNLOAD_PROGRESS;
          [DOWNLOAD_PROGRESS_RECEIVED]: number;
          [DOWNLOAD_PROGRESS_TOTAL]: number;
      }>
    | ReadonlyTupleOf<{
          [DOWNLOAD_EVENT_TYPE]: typeof DOWNLOAD_DONE;
          [DOWNLOAD_DONE_BLOB]: Blob;
          [DOWNLOAD_DONE_FILENAME]: string;
      }>
    | ReadonlyTupleOf<{
          [DOWNLOAD_EVENT_TYPE]: typeof DOWNLOAD_ERROR;
          [DOWNLOAD_ERROR_CODE]: string;
          [DOWNLOAD_ERROR_MESSAGE]: string;
      }>;

// ── Upload ────────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 64 * 1024 - 32;

const readFileAsArrayBuffer =
    (ctx: Window, file: File): Task<ArrayBuffer> =>
    (resolve, reject) => {
        const reader = new ctx.FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
    };

const sendChunks = (
    ctx: Window,
    outgoing: BaseChatSocket[typeof CHAT_SOCKET_OUTGOING],
    uploadId: number,
    buffer: ArrayBuffer,
    uploadEvents: ObserverInstance<UploadEvent>
): void => {
    const bytes = new ctx.Uint8Array(buffer);
    const total = Math.ceil(bytes.length / CHUNK_SIZE) || 1;
    let offset = 0;
    let index = 0;
    while (offset < bytes.length) {
        const chunk = bytes.slice(offset, offset + CHUNK_SIZE);
        outgoing(
            bindArg(
                [CLIENT_FRAME_UPLOAD_CHUNK, [uploadId, index, chunk]] as const,
                trigger
            )
        );
        offset += CHUNK_SIZE;
        index++;
        uploadEvents(
            bindArg([UPLOAD_PROGRESS, index, total] as const, trigger)
        );
    }
};

const sendUploadEnd = (
    outgoing: BaseChatSocket[typeof CHAT_SOCKET_OUTGOING],
    requestId: string,
    uploadId: number
): void => {
    outgoing(
        bindArg(
            [CLIENT_FRAME_UPLOAD_END, [requestId, uploadId]] as const,
            trigger
        )
    );
};

export const startUpload = (
    ctx: Window,
    socket: BaseChatSocket,
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

    const handleEvent = (event: ServerFramePayload): void => {
        if (
            event[SERVER_FRAME_PAYLOAD_VARIANT] === SERVER_FRAME_UPLOAD_READY &&
            event[SERVER_FRAME_PAYLOAD_VALUE][
                SERVER_UPLOAD_READY_REQUEST_ID
            ] === requestId
        ) {
            const uploadId =
                event[SERVER_FRAME_PAYLOAD_VALUE][
                    SERVER_UPLOAD_READY_UPLOAD_ID
                ];
            uploadEvents(bindArg([UPLOAD_READY, uploadId] as const, trigger));
            pipe(
                readFileAsArrayBuffer(ctx, file),
                taskMap((buffer: ArrayBuffer) =>
                    sendChunks(ctx, outgoing, uploadId, buffer, uploadEvents)
                ),
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
            event[SERVER_FRAME_PAYLOAD_VARIANT] === SERVER_FRAME_UPLOAD_DONE &&
            event[SERVER_FRAME_PAYLOAD_VALUE][SERVER_UPLOAD_DONE_REQUEST_ID] ===
                requestId
        ) {
            unsubscribe();
            uploadEvents(
                bindArg(
                    [UPLOAD_DONE, event[SERVER_FRAME_PAYLOAD_VALUE]] as const,
                    trigger
                )
            );
            return;
        }

        if (
            event[SERVER_FRAME_PAYLOAD_VARIANT] === SERVER_FRAME_ERROR &&
            (event[SERVER_FRAME_PAYLOAD_VALUE][SERVER_ERROR_REQUEST_ID] ===
                requestId ||
                event[SERVER_FRAME_PAYLOAD_VALUE][SERVER_ERROR_REQUEST_ID] ===
                    '')
        ) {
            unsubscribe();
            uploadEvents(
                bindArg(
                    [
                        UPLOAD_ERROR,
                        event[SERVER_FRAME_PAYLOAD_VALUE][SERVER_ERROR_CODE],
                        event[SERVER_FRAME_PAYLOAD_VALUE][SERVER_ERROR_MESSAGE],
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
                CLIENT_FRAME_UPLOAD_START,
                [
                    requestId,
                    messageId,
                    file.name,
                    file.size,
                    file.type || 'application/octet-stream',
                ],
            ] as const,
            trigger
        )
    );

    return uploadEvents;
};

// ── Download ──────────────────────────────────────────────────────────────────

const ACTIVE_META = 0 as const;
const ACTIVE_CHUNKS = 1 as const;
const ACTIVE_RECEIVED = 2 as const;
const ACTIVE_OBSERVER = 3 as const;
const ACTIVE_END_SEEN = 4 as const;

type DownloadActiveSession = TupleOf<{
    [ACTIVE_META]: ServerDownloadStart;
    [ACTIVE_CHUNKS]: Uint8Array[];
    [ACTIVE_RECEIVED]: number;
    [ACTIVE_OBSERVER]: ObserverInstance<DownloadEvent>;
    [ACTIVE_END_SEEN]: boolean;
}>;

export const startDownload = (
    ctx: Window,
    socket: BaseChatSocket,
    requestId: string,
    attachmentId: number
): ObserverInstance<DownloadEvent> => {
    const outgoing = socket[CHAT_SOCKET_OUTGOING];
    const wsEvents = socket[CHAT_SOCKET_INCOMING];
    const downloadEvents = observer<DownloadEvent>();
    let session: DownloadActiveSession | null = null;

    const tryAssembleBlob = (): void => {
        if (!session) return;
        if (!session[ACTIVE_END_SEEN]) return;
        if (
            session[ACTIVE_RECEIVED] <
            session[ACTIVE_META][SERVER_DOWNLOAD_START_TOTAL_CHUNKS]
        )
            return;
        unsubscribe();
        const chunks = session[ACTIVE_CHUNKS];
        const totalLen = chunks.reduce((s, c) => s + c.length, 0);
        const out = new ctx.Uint8Array(totalLen);
        let offset = 0;
        for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        const blob = new ctx.Blob([out], {
            type: session[ACTIVE_META][SERVER_DOWNLOAD_START_MIME_TYPE],
        });
        downloadEvents(
            bindArg(
                [
                    DOWNLOAD_DONE,
                    blob,
                    session[ACTIVE_META][SERVER_DOWNLOAD_START_FILENAME],
                ] as const,
                trigger
            )
        );
    };

    const handleEvent = (event: ServerFramePayload): void => {
        if (
            event[SERVER_FRAME_PAYLOAD_VARIANT] ===
                SERVER_FRAME_DOWNLOAD_START &&
            event[SERVER_FRAME_PAYLOAD_VALUE][
                SERVER_DOWNLOAD_START_REQUEST_ID
            ] === requestId
        ) {
            const meta = event[SERVER_FRAME_PAYLOAD_VALUE];
            session = [meta, [], 0, downloadEvents, false];
            downloadEvents(bindArg([DOWNLOAD_START, meta] as const, trigger));
            return;
        }

        if (
            event[SERVER_FRAME_PAYLOAD_VARIANT] ===
                SERVER_FRAME_DOWNLOAD_CHUNK &&
            event[SERVER_FRAME_PAYLOAD_VALUE][DOWNLOAD_CHUNK_ATTACHMENT_ID] ===
                attachmentId
        ) {
            if (!session) return;
            session[ACTIVE_CHUNKS][
                event[SERVER_FRAME_PAYLOAD_VALUE][DOWNLOAD_CHUNK_INDEX]
            ] = event[SERVER_FRAME_PAYLOAD_VALUE][DOWNLOAD_CHUNK_DATA];
            session[ACTIVE_RECEIVED]++;
            session[ACTIVE_OBSERVER](
                bindArg(
                    [
                        DOWNLOAD_PROGRESS,
                        session[ACTIVE_RECEIVED],
                        session[ACTIVE_META][
                            SERVER_DOWNLOAD_START_TOTAL_CHUNKS
                        ],
                    ] as const,
                    trigger
                )
            );
            tryAssembleBlob();
            return;
        }

        if (
            event[SERVER_FRAME_PAYLOAD_VARIANT] === SERVER_FRAME_DOWNLOAD_END &&
            event[SERVER_FRAME_PAYLOAD_VALUE][
                SERVER_DOWNLOAD_END_REQUEST_ID
            ] === requestId
        ) {
            if (!session) return;
            session[ACTIVE_END_SEEN] = true;
            tryAssembleBlob();
            return;
        }

        if (
            event[SERVER_FRAME_PAYLOAD_VARIANT] === SERVER_FRAME_ERROR &&
            event[SERVER_FRAME_PAYLOAD_VALUE][SERVER_ERROR_REQUEST_ID] ===
                requestId
        ) {
            unsubscribe();
            downloadEvents(
                bindArg(
                    [
                        DOWNLOAD_ERROR,
                        event[SERVER_FRAME_PAYLOAD_VALUE][SERVER_ERROR_CODE],
                        event[SERVER_FRAME_PAYLOAD_VALUE][SERVER_ERROR_MESSAGE],
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
            [CLIENT_FRAME_DOWNLOAD_REQUEST, [requestId, attachmentId]] as const,
            trigger
        )
    );

    return downloadEvents;
};

// ── triggerBrowserDownload ────────────────────────────────────────────────────

export const triggerBrowserDownload = (
    ctx: Window,
    blob: Blob,
    filename: string
): void => {
    const url = ctx.URL.createObjectURL(blob);
    const [a] = domCreator(
        ctx,
        ctx.document.body,
        genTagName('a', [
            genRef(),
            genProp('href', url),
            genProp('download', filename),
        ])
    );
    a.click();
    ctx.document.body.removeChild(a);
    ctx.requestAnimationFrame(() => ctx.URL.revokeObjectURL(url));
};

// ── renderAttachment ──────────────────────────────────────────────────────────

export const renderAttachment = (
    ctx: Window,
    socket: BaseChatSocket,
    ulEl: HTMLUListElement,
    attachment: AttachmentItem
): void => {
    const [getDownloadState, setDownloadState, downloadStateObs] =
        createStore<DownloadEvent | null>(null);

    const onDownloadClick = () => {
        const state = getDownloadState();
        if (
            state !== null &&
            state[DOWNLOAD_EVENT_TYPE] !== DOWNLOAD_DONE &&
            state[DOWNLOAD_EVENT_TYPE] !== DOWNLOAD_ERROR
        ) {
            return;
        }
        const requestId = `dl-${attachment[ATTACHMENT_ITEM_ID]}-${ctx.Date.now()}`;
        const downloadObs = startDownload(
            ctx,
            socket,
            requestId,
            attachment[ATTACHMENT_ITEM_ID]
        );
        downloadObs(
            bindArg((event: DownloadEvent) => setDownloadState(event), on)
        );
    };

    const attachRefs = domCreatorRef(
        ctx,
        ulEl,
        genTagName(
            'li',
            [genClass('chat__attachment')],
            [
                attachmentItemTemplate(
                    attachment[ATTACHMENT_ITEM_FILENAME],
                    attachment[ATTACHMENT_ITEM_SIZE],
                    attachment[ATTACHMENT_ITEM_MIME_TYPE],
                    onDownloadClick
                ),
            ]
        )
    ) as unknown as { [ATTACHMENT_REF_PROGRESS]: HTMLSpanElement };

    const progressEl = attachRefs[ATTACHMENT_REF_PROGRESS];

    downloadStateObs(
        bindArg((event: DownloadEvent | null) => {
            if (event === null) {
                progressEl.hidden = true;
                progressEl.textContent = '';
                return;
            }
            if (event[DOWNLOAD_EVENT_TYPE] === DOWNLOAD_PROGRESS) {
                progressEl.hidden = false;
                progressEl.textContent = `${event[DOWNLOAD_PROGRESS_RECEIVED]}/${event[DOWNLOAD_PROGRESS_TOTAL]}`;
                return;
            }
            if (event[DOWNLOAD_EVENT_TYPE] === DOWNLOAD_DONE) {
                progressEl.hidden = true;
                progressEl.textContent = '';
                triggerBrowserDownload(
                    ctx,
                    event[DOWNLOAD_DONE_BLOB] as Blob,
                    event[DOWNLOAD_DONE_FILENAME] as string
                );
                return;
            }
            if (event[DOWNLOAD_EVENT_TYPE] === DOWNLOAD_ERROR) {
                progressEl.hidden = false;
                progressEl.textContent = 'Error';
            }
        }, on)
    );
};

// ── renderAttachmentFromUploadDone ────────────────────────────────────────────

export const renderAttachmentFromUploadDone = (
    ctx: Window,
    socket: BaseChatSocket,
    ulEl: HTMLUListElement,
    uploadDone: ServerUploadDone
): void => {
    const attachment = [
        uploadDone[SERVER_UPLOAD_DONE_ATTACHMENT_ID],
        uploadDone[SERVER_UPLOAD_DONE_FILENAME],
        uploadDone[SERVER_UPLOAD_DONE_SIZE],
        uploadDone[SERVER_UPLOAD_DONE_MIME_TYPE],
    ] as unknown as AttachmentItem;
    renderAttachment(ctx, socket, ulEl, attachment);
};

export const getUploadDoneMessageId = (uploadDone: ServerUploadDone): number =>
    uploadDone[SERVER_UPLOAD_DONE_MESSAGE_ID];
