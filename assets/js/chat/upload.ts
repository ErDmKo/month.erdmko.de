import { encodeUploadChunk } from './attachments-proto';

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

export type UploadCallbacks = {
    onReady?: (uploadId: number) => void;
    onDone?: (payload: UploadDonePayload) => void;
    onError?: (code: string, message: string) => void;
};

/**
 * Start an upload flow for a single file attached to an existing message.
 *
 * Registers one-time handlers on the socket `onmessage` for `upload_ready`
 * and `upload_done` keyed by requestId, then sends `upload_start`.
 * The caller is responsible for dispatching `upload_ready` / `upload_done`
 * events into `handleUploadServerEvent()`.
 */
export const startUpload = (
    ws: WebSocket,
    requestId: string,
    messageId: number,
    file: File,
    callbacks: UploadCallbacks
): void => {
    if (file.size === 0 || file.size > MAX_UPLOAD_SIZE) {
        callbacks.onError?.(
            'UPLOAD_TOO_LARGE',
            `File must be between 1 byte and ${MAX_UPLOAD_SIZE} bytes.`
        );
        return;
    }

    // Step 1: send upload_start
    ws.send(
        JSON.stringify({
            type: 'upload_start',
            requestId,
            messageId,
            filename: file.name,
            size: file.size,
            mimeType: file.type || 'application/octet-stream',
        })
    );

    // Step 2: wait for upload_ready, then stream chunks + send upload_end
    const onReady = async (uploadId: number) => {
        callbacks.onReady?.(uploadId);
        const buffer = await file.arrayBuffer();
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
        ws.send(
            JSON.stringify({
                type: 'upload_end',
                requestId,
                uploadId,
            })
        );
    };

    // Expose handler — caller should invoke this from ws.onmessage
    (ws as any)[`__upload_ready_${requestId}`] = onReady;
    (ws as any)[`__upload_done_${requestId}`] = (
        payload: UploadDonePayload
    ) => {
        delete (ws as any)[`__upload_ready_${requestId}`];
        delete (ws as any)[`__upload_done_${requestId}`];
        callbacks.onDone?.(payload);
    };
    (ws as any)[`__upload_error_${requestId}`] = (
        code: string,
        message: string
    ) => {
        delete (ws as any)[`__upload_ready_${requestId}`];
        delete (ws as any)[`__upload_done_${requestId}`];
        delete (ws as any)[`__upload_error_${requestId}`];
        callbacks.onError?.(code, message);
    };
};

/**
 * Route an incoming server JSON payload to the appropriate upload handler.
 * Call this from ws.onmessage for payloads with type upload_ready / upload_done.
 */
export const handleUploadServerEvent = (
    ws: WebSocket,
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
        const handler = (ws as any)[`__upload_ready_${requestId}`];
        if (handler) {
            handler(payload.uploadId);
            return true;
        }
    }
    if (payload.type === 'upload_done' && payload.attachment) {
        const handler = (ws as any)[`__upload_done_${requestId}`];
        if (handler) {
            handler({ attachment: payload.attachment });
            return true;
        }
    }
    if (
        payload.type === 'error' &&
        (ws as any)[`__upload_error_${requestId}`]
    ) {
        const handler = (ws as any)[`__upload_error_${requestId}`];
        if (handler) {
            handler(payload.code ?? 'UNKNOWN', payload.message ?? '');
            return true;
        }
    }
    return false;
};
