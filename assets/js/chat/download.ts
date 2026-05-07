import {
    ObserverState,
    ObserverInstance,
    observer,
    on,
    off,
    bindArgs,
    bindArg,
    trigger,
} from '../utils';
import {
    DownloadStartPayload,
    WsEvent,
    SendCommand,
    DOWNLOAD_REQUEST_TYPE,
    WS_EVENT_TYPE,
    WS_DOWNLOAD_START,
    WS_DOWNLOAD_START_REQUEST_ID,
    WS_DOWNLOAD_START_META,
    WS_DOWNLOAD_END,
    WS_DOWNLOAD_END_REQUEST_ID,
    WS_DOWNLOAD_CHUNK,
    WS_DOWNLOAD_CHUNK_ATTACHMENT_ID,
    WS_DOWNLOAD_CHUNK_INDEX,
    WS_DOWNLOAD_CHUNK_DATA,
    WS_ERROR,
    WS_ERROR_REQUEST_ID,
    WS_ERROR_CODE,
    WS_ERROR_MESSAGE,
} from './protocol';

export type { DownloadStartPayload } from './protocol';

declare global {
    interface Window {
        Blob: typeof Blob;
        Uint8Array: typeof Uint8Array;
        URL: typeof URL;
        JSON: typeof JSON;
    }
}

// ── Download event tuple ──────────────────────────────────────────────────────

export const DOWNLOAD_START = 0 as const;
export const DOWNLOAD_PROGRESS = 1 as const;
export const DOWNLOAD_DONE = 2 as const;
export const DOWNLOAD_ERROR = 3 as const;

export type DownloadEvent =
    | readonly [type: typeof DOWNLOAD_START, meta: DownloadStartPayload]
    | readonly [type: typeof DOWNLOAD_PROGRESS, received: number, total: number]
    | readonly [type: typeof DOWNLOAD_DONE, blob: Blob, filename: string]
    | readonly [type: typeof DOWNLOAD_ERROR, code: string, message: string];

// ── Active session tuple ──────────────────────────────────────────────────────

const ACTIVE_META = 0 as const;
const ACTIVE_CHUNKS = 1 as const;
const ACTIVE_RECEIVED = 2 as const;
const ACTIVE_OBSERVER = 3 as const;

type DownloadActiveSession = [
    meta: DownloadStartPayload,
    chunks: Uint8Array[],
    received: number,
    events: ObserverInstance<DownloadEvent>,
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Send a download_request and return an ObserverInstance for download events.
 * Subscribes to the shared WsEvent observer for the lifetime of this download,
 * including binary chunk events. Unsubscribes automatically on completion or error.
 */
export const startDownload = (
    ctx: Window,
    outgoing: ObserverInstance<SendCommand>,
    requestId: string,
    attachmentId: number,
    wsEvents: ObserverState<WsEvent>
): ObserverInstance<DownloadEvent> => {
    const downloadEvents = observer<DownloadEvent>();
    let session: DownloadActiveSession | null = null;

    const handleEvent = (event: WsEvent): void => {
        if (
            event[WS_EVENT_TYPE] === WS_DOWNLOAD_START &&
            event[WS_DOWNLOAD_START_REQUEST_ID] === requestId
        ) {
            const meta = event[WS_DOWNLOAD_START_META];
            session = [meta, [], 0, downloadEvents];
            downloadEvents(bindArg([DOWNLOAD_START, meta] as const, trigger));
            return;
        }

        if (
            event[WS_EVENT_TYPE] === WS_DOWNLOAD_CHUNK &&
            event[WS_DOWNLOAD_CHUNK_ATTACHMENT_ID] === attachmentId
        ) {
            if (!session) return;
            session[ACTIVE_CHUNKS][event[WS_DOWNLOAD_CHUNK_INDEX]] =
                event[WS_DOWNLOAD_CHUNK_DATA];
            session[ACTIVE_RECEIVED]++;
            session[ACTIVE_OBSERVER](
                bindArg(
                    [
                        DOWNLOAD_PROGRESS,
                        session[ACTIVE_RECEIVED],
                        session[ACTIVE_META].totalChunks,
                    ] as const,
                    trigger
                )
            );
            return;
        }

        if (
            event[WS_EVENT_TYPE] === WS_DOWNLOAD_END &&
            event[WS_DOWNLOAD_END_REQUEST_ID] === requestId
        ) {
            unsubscribe();
            if (!session) return;

            const chunks = session[ACTIVE_CHUNKS];
            const totalLen = chunks.reduce((s, c) => s + c.length, 0);
            const out = new ctx.Uint8Array(totalLen);
            let offset = 0;
            for (const chunk of chunks) {
                out.set(chunk, offset);
                offset += chunk.length;
            }
            const blob = new ctx.Blob([out], {
                type: session[ACTIVE_META].mimeType,
            });
            downloadEvents(
                bindArg(
                    [
                        DOWNLOAD_DONE,
                        blob,
                        session[ACTIVE_META].filename,
                    ] as const,
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
            downloadEvents(
                bindArg(
                    [
                        DOWNLOAD_ERROR,
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
            [DOWNLOAD_REQUEST_TYPE, requestId, attachmentId] as const,
            trigger
        )
    );

    return downloadEvents;
};

/**
 * Trigger a browser file download from a Blob.
 */
export const triggerBrowserDownload = (
    ctx: Window,
    blob: Blob,
    filename: string
): void => {
    const url = ctx.URL.createObjectURL(blob);
    const a = ctx.document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    ctx.URL.revokeObjectURL(url);
};
