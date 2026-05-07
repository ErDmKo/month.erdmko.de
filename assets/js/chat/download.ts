import { ObserverState, ObserverInstance, observer, on, off, bindArgs, bindArg, trigger } from '../utils';
import { decodeDownloadChunk } from './attachments-proto';
import { DownloadStartPayload, IncomingWsEvent } from './protocol';

export type { DownloadStartPayload } from './protocol';

declare global {
    interface Window {
        JSON: typeof JSON;
        Blob: typeof Blob;
        Uint8Array: typeof Uint8Array;
        URL: typeof URL;
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

// keyed by attachmentId, shared across all active downloads on a socket
export type WsDownloadBinaryState = Map<number, DownloadActiveSession>;

export const wsDownloadBinaryStateCreate = (): WsDownloadBinaryState =>
    new Map();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Send a download_request and return an ObserverInstance for download events.
 * Subscribe to it to receive start / progress / done / error notifications.
 * Unsubscribes from the shared WS observer automatically on completion or error.
 */
export const startDownload = (
    ctx: Window,
    ws: WebSocket,
    requestId: string,
    attachmentId: number,
    wsEvents: ObserverState<IncomingWsEvent>,
    binaryState: WsDownloadBinaryState
): ObserverInstance<DownloadEvent> => {
    const downloadEvents = observer<DownloadEvent>();

    const handleEvent = (event: IncomingWsEvent): void => {
        if (event.type === 'download_start' && event.requestId === requestId) {
            const { type: _t, requestId: _r, ...meta } = event;
            const session: DownloadActiveSession = [meta, [], 0, downloadEvents];
            binaryState.set(attachmentId, session);
            downloadEvents(bindArg([DOWNLOAD_START, meta] as const, trigger));
            return;
        }

        if (event.type === 'download_end' && event.requestId === requestId) {
            unsubscribe();
            const session = binaryState.get(attachmentId);
            binaryState.delete(attachmentId);
            if (!session) return;

            const chunks = session[ACTIVE_CHUNKS];
            const totalLen = chunks.reduce((s, c) => s + c.length, 0);
            const out = new ctx.Uint8Array(totalLen);
            let offset = 0;
            for (const chunk of chunks) {
                out.set(chunk, offset);
                offset += chunk.length;
            }
            const blob = new ctx.Blob([out], { type: session[ACTIVE_META].mimeType });
            downloadEvents(bindArg([DOWNLOAD_DONE, blob, session[ACTIVE_META].filename] as const, trigger));
            return;
        }

        if (event.type === 'error' && event.requestId === requestId) {
            unsubscribe();
            binaryState.delete(attachmentId);
            downloadEvents(bindArg([DOWNLOAD_ERROR, event.code ?? 'UNKNOWN', event.message ?? ''] as const, trigger));
        }
    };
    const unsubscribe = bindArgs([handleEvent, wsEvents], off);

    on(handleEvent, wsEvents);

    ws.send(
        ctx.JSON.stringify({
            type: 'download_request',
            requestId,
            attachmentId,
        })
    );

    return downloadEvents;
};

/**
 * Route an incoming binary WS frame to the active download session.
 */
export const handleDownloadBinaryFrame = (
    binaryState: WsDownloadBinaryState,
    frame: ArrayBuffer
): boolean => {
    const chunk = decodeDownloadChunk(new Uint8Array(frame));
    if (!chunk) return false;

    const attachmentId = Number(chunk.attachmentId);
    const session = binaryState.get(attachmentId);
    if (!session) return false;

    session[ACTIVE_CHUNKS][chunk.index] = chunk.data;
    session[ACTIVE_RECEIVED]++;
    session[ACTIVE_OBSERVER](bindArg(
        [DOWNLOAD_PROGRESS, session[ACTIVE_RECEIVED], session[ACTIVE_META].totalChunks] as const,
        trigger
    ));
    return true;
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
