import { pipe, taskChain, taskFork, noop, Task, bindArgs, ObserverState, on, off } from '../utils';
import { encodeUploadChunk } from './attachments-proto';
import { MAX_UPLOAD_SIZE, UploadDonePayload, IncomingWsEvent } from './protocol';

export { MAX_UPLOAD_SIZE } from './protocol';

declare global {
    interface Window {
        JSON: typeof JSON;
        FileReader: typeof FileReader;
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
 * Subscribes to the shared WS observer and unsubscribes on completion or error.
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
    wsEvents: ObserverState<IncomingWsEvent>
): void => {
    if (file.size === 0 || file.size > MAX_UPLOAD_SIZE) {
        onError(
            'UPLOAD_TOO_LARGE',
            `File must be between 1 byte and ${MAX_UPLOAD_SIZE} bytes.`
        );
        return;
    }

    const handleEvent = (event: IncomingWsEvent): void => {
        if (event.type === 'upload_ready' && event.requestId === requestId) {
            onReady(event.uploadId);
            pipe(
                readFileAsArrayBuffer(ctx, file),
                taskChain(bindArgs([ws, event.uploadId], sendChunks)),
                taskChain(bindArgs([ctx, ws, requestId, event.uploadId], sendUploadEnd)),
                taskFork(noop, (e) => {
                    unsubscribe();
                    onError('UPLOAD_FAILED', String(e));
                })
            );
            return;
        }

        if (event.type === 'upload_done' && event.requestId === requestId) {
            unsubscribe();
            onDone({ attachment: event.attachment });
            return;
        }

        if (event.type === 'error' && event.requestId === requestId) {
            unsubscribe();
            onError(event.code ?? 'UNKNOWN', event.message ?? '');
        }
    };
    const unsubscribe = bindArgs([handleEvent, wsEvents], off);

    on(handleEvent, wsEvents);

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
