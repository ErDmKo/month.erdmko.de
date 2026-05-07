import { ObserverState, on, off, bindArgs } from '../utils';
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

// ── Active session tuple ──────────────────────────────────────────────────────

const ACTIVE_META = 0 as const;
const ACTIVE_CHUNKS = 1 as const;
const ACTIVE_RECEIVED = 2 as const;
const ACTIVE_ON_PROGRESS = 3 as const;
const ACTIVE_ON_DONE = 4 as const;

type DownloadActiveSession = [
    meta: DownloadStartPayload,
    chunks: Uint8Array[],
    received: number,
    onProgress: (received: number, total: number) => void,
    onDone: (blob: Blob, filename: string) => void,
];

// keyed by attachmentId, shared across all active downloads on a socket
export type WsDownloadBinaryState = Map<number, DownloadActiveSession>;

export const wsDownloadBinaryStateCreate = (): WsDownloadBinaryState =>
    new Map();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Send a download_request and subscribe to the shared WS observer for the
 * lifetime of this download. Unsubscribes automatically on completion or error.
 */
export const startDownload = (
    ctx: Window,
    ws: WebSocket,
    requestId: string,
    attachmentId: number,
    onStart: (meta: DownloadStartPayload) => void,
    onProgress: (received: number, total: number) => void,
    onDone: (blob: Blob, filename: string) => void,
    onError: (code: string, message: string) => void,
    wsEvents: ObserverState<IncomingWsEvent>,
    binaryState: WsDownloadBinaryState
): void => {
    const handleEvent = (event: IncomingWsEvent): void => {
        if (event.type === 'download_start' && event.requestId === requestId) {
            const meta: DownloadStartPayload = {
                attachmentId: event.attachmentId,
                filename: event.filename,
                size: event.size,
                mimeType: event.mimeType,
                totalChunks: event.totalChunks,
            };
            const session: DownloadActiveSession = [meta, [], 0, onProgress, onDone];
            binaryState.set(attachmentId, session);
            onStart(meta);
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
            session[ACTIVE_ON_DONE](blob, session[ACTIVE_META].filename);
            return;
        }

        if (event.type === 'error' && event.requestId === requestId) {
            unsubscribe();
            binaryState.delete(attachmentId);
            onError(event.code ?? 'UNKNOWN', event.message ?? '');
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
    session[ACTIVE_ON_PROGRESS](
        session[ACTIVE_RECEIVED],
        session[ACTIVE_META].totalChunks
    );
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
