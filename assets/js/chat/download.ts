import { decodeDownloadChunk } from './attachments-proto';

export type DownloadStartPayload = {
    attachmentId: number;
    filename: string;
    size: number;
    mimeType: string;
    totalChunks: number;
};

export type DownloadCallbacks = {
    onStart?: (meta: DownloadStartPayload) => void;
    onProgress?: (received: number, total: number) => void;
    onDone?: (blob: Blob, filename: string) => void;
    onError?: (code: string, message: string) => void;
};

type DownloadState = {
    meta: DownloadStartPayload;
    chunks: Uint8Array[];
    received: number;
    callbacks: DownloadCallbacks;
};

/**
 * Send a download_request and handle the incoming stream of binary chunks.
 *
 * Text frames (download_start / download_end / error) should be routed via
 * handleDownloadServerEvent(). Binary frames should be routed via
 * handleDownloadBinaryFrame().
 */
export const startDownload = (
    ws: WebSocket,
    requestId: string,
    attachmentId: number,
    callbacks: DownloadCallbacks
): void => {
    ws.send(
        JSON.stringify({
            type: 'download_request',
            requestId,
            attachmentId,
        })
    );

    (ws as any)[`__download_start_${requestId}`] = (
        meta: DownloadStartPayload
    ) => {
        const state: DownloadState = {
            meta,
            chunks: [],
            received: 0,
            callbacks,
        };
        (ws as any)[`__download_state_${attachmentId}`] = state;
        callbacks.onStart?.(meta);
    };

    (ws as any)[`__download_end_${requestId}`] = () => {
        const state: DownloadState | undefined = (ws as any)[
            `__download_state_${attachmentId}`
        ];
        delete (ws as any)[`__download_start_${requestId}`];
        delete (ws as any)[`__download_end_${requestId}`];
        delete (ws as any)[`__download_state_${attachmentId}`];
        delete (ws as any)[`__download_error_${requestId}`];
        if (!state) return;
        const totalLen = state.chunks.reduce((s, c) => s + c.length, 0);
        const out = new Uint8Array(totalLen);
        let offset = 0;
        for (const chunk of state.chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        const blob = new Blob([out], { type: state.meta.mimeType });
        state.callbacks.onDone?.(blob, state.meta.filename);
    };

    (ws as any)[`__download_error_${requestId}`] = (
        code: string,
        message: string
    ) => {
        delete (ws as any)[`__download_start_${requestId}`];
        delete (ws as any)[`__download_end_${requestId}`];
        delete (ws as any)[`__download_state_${attachmentId}`];
        delete (ws as any)[`__download_error_${requestId}`];
        callbacks.onError?.(code, message);
    };
};

/**
 * Route an incoming server JSON payload to the download handler.
 */
export const handleDownloadServerEvent = (
    ws: WebSocket,
    payload: {
        type: string;
        requestId?: string;
        attachmentId?: number;
        filename?: string;
        size?: number;
        mimeType?: string;
        totalChunks?: number;
        code?: string;
        message?: string;
    }
): boolean => {
    const requestId = payload.requestId;
    if (!requestId) return false;

    if (payload.type === 'download_start') {
        const handler = (ws as any)[`__download_start_${requestId}`];
        if (handler) {
            handler({
                attachmentId: payload.attachmentId!,
                filename: payload.filename!,
                size: payload.size!,
                mimeType: payload.mimeType!,
                totalChunks: payload.totalChunks!,
            });
            return true;
        }
    }
    if (payload.type === 'download_end') {
        const handler = (ws as any)[`__download_end_${requestId}`];
        if (handler) {
            handler();
            return true;
        }
    }
    if (payload.type === 'error') {
        // try all pending download errors
        const key = `__download_error_${requestId}`;
        const handler = (ws as any)[key];
        if (handler) {
            handler(payload.code ?? 'UNKNOWN', payload.message ?? '');
            return true;
        }
    }
    return false;
};

/**
 * Route an incoming binary WS frame to the active download state.
 */
export const handleDownloadBinaryFrame = (
    ws: WebSocket,
    frame: ArrayBuffer
): boolean => {
    const chunk = decodeDownloadChunk(new Uint8Array(frame));
    if (!chunk) return false;

    const state: DownloadState | undefined = (ws as any)[
        `__download_state_${chunk.attachmentId}`
    ];
    if (!state) return false;

    state.chunks[chunk.index] = chunk.data;
    state.received++;
    state.callbacks.onProgress?.(state.received, state.meta.totalChunks);
    return true;
};

/**
 * Trigger a browser file download from a Blob.
 */
export const triggerBrowserDownload = (
    ctx: Window & typeof globalThis,
    blob: Blob,
    filename: string
): void => {
    const url = URL.createObjectURL(blob);
    const a = ctx.document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
};
