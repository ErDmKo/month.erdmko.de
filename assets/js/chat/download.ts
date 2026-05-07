import { ObserverState, ObserverInstance, observer, on, off, bindArgs, bindArg, trigger } from '../utils';
import { DownloadStartPayload, WsEvent, WS_DOWNLOAD_START, WS_DOWNLOAD_END, WS_DOWNLOAD_CHUNK, WS_ERROR } from './protocol';

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
    ws: WebSocket,
    requestId: string,
    attachmentId: number,
    wsEvents: ObserverState<WsEvent>
): ObserverInstance<DownloadEvent> => {
    const downloadEvents = observer<DownloadEvent>();
    let session: DownloadActiveSession | null = null;

    const handleEvent = (event: WsEvent): void => {
        if (event[0] === WS_DOWNLOAD_START && event[1] === requestId) {
            const meta = event[2];
            session = [meta, [], 0, downloadEvents];
            downloadEvents(bindArg([DOWNLOAD_START, meta] as const, trigger));
            return;
        }

        if (event[0] === WS_DOWNLOAD_CHUNK && event[1] === attachmentId) {
            if (!session) return;
            session[ACTIVE_CHUNKS][event[2]] = event[3];
            session[ACTIVE_RECEIVED]++;
            session[ACTIVE_OBSERVER](bindArg(
                [DOWNLOAD_PROGRESS, session[ACTIVE_RECEIVED], session[ACTIVE_META].totalChunks] as const,
                trigger
            ));
            return;
        }

        if (event[0] === WS_DOWNLOAD_END && event[1] === requestId) {
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
            const blob = new ctx.Blob([out], { type: session[ACTIVE_META].mimeType });
            downloadEvents(bindArg([DOWNLOAD_DONE, blob, session[ACTIVE_META].filename] as const, trigger));
            return;
        }

        if (event[0] === WS_ERROR && event[1] === requestId) {
            unsubscribe();
            downloadEvents(bindArg([DOWNLOAD_ERROR, event[2], event[3]] as const, trigger));
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
