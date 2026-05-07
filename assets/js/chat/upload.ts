import { pipe, taskChain, taskFork, noop, Task, bindArgs } from '../utils';
import { encodeUploadChunk } from './attachments-proto';

declare global {
    interface Window {
        JSON: typeof JSON;
        FileReader: typeof FileReader;
    }
}

export const MAX_UPLOAD_SIZE = 5 * 1024 * 1024;
const CHUNK_SIZE = 64 * 1024;

export type UploadDonePayload = {
    attachment: {
        id: number;
        messageId: number;
        filename: string;
        size: number;
        mimeType: string;
    };
};

// ── WsUploadState tuple ───────────────────────────────────────────────────────

const UPLOAD_ON_READY = 0 as const;
const UPLOAD_ON_DONE = 1 as const;
const UPLOAD_ON_ERROR = 2 as const;

type UploadReadyHandler = (uploadId: number) => void;
type UploadDoneHandler = (payload: UploadDonePayload) => void;
type UploadErrorHandler = (code: string, message: string) => void;

export type WsUploadState = [
    onReady: Map<string, UploadReadyHandler>,
    onDone: Map<string, UploadDoneHandler>,
    onError: Map<string, UploadErrorHandler>,
];

export const wsUploadStateCreate = (): WsUploadState => [
    new Map(),
    new Map(),
    new Map(),
];

const wsUploadStateRegister = (
    requestId: string,
    onReady: UploadReadyHandler,
    onDone: UploadDoneHandler,
    onError: UploadErrorHandler,
    state: WsUploadState
): void => {
    state[UPLOAD_ON_READY].set(requestId, onReady);
    state[UPLOAD_ON_DONE].set(requestId, onDone);
    state[UPLOAD_ON_ERROR].set(requestId, onError);
};

const wsUploadStateDelete = (
    requestId: string,
    state: WsUploadState
): void => {
    state[UPLOAD_ON_READY].delete(requestId);
    state[UPLOAD_ON_DONE].delete(requestId);
    state[UPLOAD_ON_ERROR].delete(requestId);
};

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
    (ws: WebSocket, uploadId: number, buffer: ArrayBuffer): Task<void> =>
    (resolve) => {
        const bytes = new Uint8Array(buffer);
        let offset = 0;
        let index = 0;
        while (offset < bytes.length) {
            const chunk = bytes.slice(offset, offset + CHUNK_SIZE);
            ws.send(
                encodeUploadChunk(uploadId, index, chunk).buffer as ArrayBuffer
            );
            offset += CHUNK_SIZE;
            index++;
        }
        resolve();
    };

const sendUploadEnd =
    (ctx: Window, ws: WebSocket, requestId: string, uploadId: number): Task<void> =>
    (resolve) => {
        ws.send(
            ctx.JSON.stringify({
                type: 'upload_end',
                requestId,
                uploadId,
            })
        );
        resolve();
    };

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start an upload flow for a single file attached to an existing message.
 *
 * Registers handlers in the provided WsUploadState for upload_ready /
 * upload_done / upload_error events keyed by requestId.
 * Route incoming server events via handleUploadServerEvent().
 */
export const startUpload = (
    ctx: Window,
    ws: WebSocket,
    requestId: string,
    messageId: number,
    file: File,
    onReady: (uploadId: number) => void,
    onDone: (payload: UploadDonePayload) => void,
    onError: (code: string, message: string) => void,
    state: WsUploadState
): void => {
    if (file.size === 0 || file.size > MAX_UPLOAD_SIZE) {
        onError(
            'UPLOAD_TOO_LARGE',
            `File must be between 1 byte and ${MAX_UPLOAD_SIZE} bytes.`
        );
        return;
    }

    const handleReady = (uploadId: number): void => {
        onReady(uploadId);
        pipe(
            readFileAsArrayBuffer(ctx, file),
            taskChain(bindArgs([ws, uploadId], sendChunks)),
            taskChain(() => sendUploadEnd(ctx, ws, requestId, uploadId)),
            taskFork(noop, (e) => onError('UPLOAD_FAILED', String(e)))
        );
    };

    const handleDone = (payload: UploadDonePayload): void => {
        wsUploadStateDelete(requestId, state);
        onDone(payload);
    };

    const handleError = (code: string, message: string): void => {
        wsUploadStateDelete(requestId, state);
        onError(code, message);
    };

    wsUploadStateRegister(requestId, handleReady, handleDone, handleError, state);

    ws.send(
        ctx.JSON.stringify({
            type: 'upload_start',
            requestId,
            messageId,
            filename: file.name,
            size: file.size,
            mimeType: file.type || 'application/octet-stream',
        })
    );
};

/**
 * Route an incoming server JSON payload to the appropriate upload handler.
 * Call this from ws.onmessage for payloads with type upload_ready / upload_done / error.
 */
export const handleUploadServerEvent = (
    state: WsUploadState,
    payload: {
        type: string;
        requestId?: string;
        uploadId?: number;
        attachment?: UploadDonePayload['attachment'];
        code?: string;
        message?: string;
    }
): boolean => {
    const requestId = payload.requestId;
    if (!requestId) return false;

    if (payload.type === 'upload_ready' && payload.uploadId !== undefined) {
        const handler = state[UPLOAD_ON_READY].get(requestId);
        if (handler) {
            handler(payload.uploadId);
            return true;
        }
    }
    if (payload.type === 'upload_done' && payload.attachment) {
        const handler = state[UPLOAD_ON_DONE].get(requestId);
        if (handler) {
            handler({ attachment: payload.attachment });
            return true;
        }
    }
    if (payload.type === 'error') {
        const handler = state[UPLOAD_ON_ERROR].get(requestId);
        if (handler) {
            handler(payload.code ?? 'UNKNOWN', payload.message ?? '');
            return true;
        }
    }
    return false;
};
