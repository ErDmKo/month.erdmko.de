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

// ── WsDownloadState tuple ─────────────────────────────────────────────────────

const DOWNLOAD_ON_START = 0 as const;
const DOWNLOAD_ON_END = 1 as const;
const DOWNLOAD_ON_ERROR = 2 as const;
const DOWNLOAD_ACTIVE = 3 as const;

// Per-request active session: tuple keyed by attachmentId
const ACTIVE_META = 0 as const;
const ACTIVE_CHUNKS = 1 as const;
const ACTIVE_RECEIVED = 2 as const;
const ACTIVE_ON_PROGRESS = 3 as const;
const ACTIVE_ON_DONE = 4 as const;
const ACTIVE_MIME = 5 as const;
const ACTIVE_FILENAME = 6 as const;

type DownloadActiveSession = [
    meta: DownloadStartPayload,
    chunks: Uint8Array[],
    received: number,
    onProgress: (received: number, total: number) => void,
    onDone: (blob: Blob, filename: string) => void,
    mimeType: string,
    filename: string,
];

type DownloadStartHandler = (meta: DownloadStartPayload) => void;
type DownloadEndHandler = () => void;
type DownloadErrorHandler = (code: string, message: string) => void;

export type WsDownloadState = [
    onStart: Map<string, DownloadStartHandler>,
    onEnd: Map<string, DownloadEndHandler>,
    onError: Map<string, DownloadErrorHandler>,
    active: Map<number, DownloadActiveSession>,
];

export const wsDownloadStateCreate = (): WsDownloadState => [
    new Map(),
    new Map(),
    new Map(),
    new Map(),
];

const wsDownloadStateRegister = (
    requestId: string,
    onStart: DownloadStartHandler,
    onEnd: DownloadEndHandler,
    onError: DownloadErrorHandler,
    state: WsDownloadState
): void => {
    state[DOWNLOAD_ON_START].set(requestId, onStart);
    state[DOWNLOAD_ON_END].set(requestId, onEnd);
    state[DOWNLOAD_ON_ERROR].set(requestId, onError);
};

const wsDownloadStateDelete = (
    requestId: string,
    attachmentId: number,
    state: WsDownloadState
): void => {
    state[DOWNLOAD_ON_START].delete(requestId);
    state[DOWNLOAD_ON_END].delete(requestId);
    state[DOWNLOAD_ON_ERROR].delete(requestId);
    state[DOWNLOAD_ACTIVE].delete(attachmentId);
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Send a download_request and register handlers in the provided WsDownloadState.
 *
 * Text frames (download_start / download_end / error) should be routed via
 * handleDownloadServerEvent(). Binary frames should be routed via
 * handleDownloadBinaryFrame().
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
    state: WsDownloadState
): void => {
    const handleStart = (meta: DownloadStartPayload): void => {
        const session: DownloadActiveSession = [
            meta,
            [],
            0,
            onProgress,
            onDone,
            meta.mimeType,
            meta.filename,
        ];
        state[DOWNLOAD_ACTIVE].set(attachmentId, session);
        onStart(meta);
    };

    const handleEnd = (): void => {
        const session = state[DOWNLOAD_ACTIVE].get(attachmentId);
        wsDownloadStateDelete(requestId, attachmentId, state);
        if (!session) return;

        const chunks = session[ACTIVE_CHUNKS];
        const totalLen = chunks.reduce((s, c) => s + c.length, 0);
        const out = new ctx.Uint8Array(totalLen);
        let offset = 0;
        for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        const blob = new ctx.Blob([out], { type: session[ACTIVE_MIME] });
        session[ACTIVE_ON_DONE](blob, session[ACTIVE_FILENAME]);
    };

    const handleError = (code: string, message: string): void => {
        wsDownloadStateDelete(requestId, attachmentId, state);
        onError(code, message);
    };

    wsDownloadStateRegister(requestId, handleStart, handleEnd, handleError, state);

    ws.send(
        ctx.JSON.stringify({
            type: 'download_request',
            requestId,
            attachmentId,
        })
    );
};

/**
 * Route an incoming server JSON payload to the download handler.
 */
export const handleDownloadServerEvent = (
    state: WsDownloadState,
    payload: IncomingWsEvent
): boolean => {
    if (payload.type === 'download_start') {
        const handler = state[DOWNLOAD_ON_START].get(payload.requestId);
        if (handler) {
            handler({
                attachmentId: payload.attachmentId,
                filename: payload.filename,
                size: payload.size,
                mimeType: payload.mimeType,
                totalChunks: payload.totalChunks,
            });
            return true;
        }
    }
    if (payload.type === 'download_end') {
        const handler = state[DOWNLOAD_ON_END].get(payload.requestId);
        if (handler) {
            handler();
            return true;
        }
    }
    if (payload.type === 'error' && payload.requestId) {
        const handler = state[DOWNLOAD_ON_ERROR].get(payload.requestId);
        if (handler) {
            handler(payload.code ?? 'UNKNOWN', payload.message ?? '');
            return true;
        }
    }
    return false;
};

/**
 * Route an incoming binary WS frame to the active download session.
 */
export const handleDownloadBinaryFrame = (
    state: WsDownloadState,
    frame: ArrayBuffer
): boolean => {
    const chunk = decodeDownloadChunk(new Uint8Array(frame));
    if (!chunk) return false;

    const attachmentId = Number(chunk.attachmentId);
    const session = state[DOWNLOAD_ACTIVE].get(attachmentId);
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
