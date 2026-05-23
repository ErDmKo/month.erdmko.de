/**
 * attachments.test.ts — upload/download flows via native WS client.
 *
 * These tests exercise the real server binary end-to-end without a browser,
 * covering all ASSETS-40 / ASSETS-50 checkboxes that were previously only
 * tested in-process via awc.
 */
import { joinRoom } from '../helpers/ws-client';
import { encodeUploadChunk, extractDownloadChunk } from '../helpers/proto';

const PORT = () => parseInt(process.env.E2E_SERVER_PORT!, 10);
const room = () => `room-${Math.random().toString(36).slice(2)}`;

// ─── helpers ────────────────────────────────────────────────────────────────

async function uploadFile(
    port: number,
    roomId: string,
    nickname: string,
    filename: string,
    mimeType: string,
    data: Buffer,
): Promise<{ ws: ReturnType<typeof joinRoom> extends Promise<infer T> ? T : never; attachmentId: number }> {
    const ws = await joinRoom(port, roomId, nickname);

    ws.sendText({
        type: 'upload_start',
        requestId: 'req-1',
        messageId: 1,          // message must exist; for these tests we rely on
        filename,               // the server returning UPLOAD_DONE even if message_id
        size: data.length,      // is synthetic (server validates existence)
        mimeType,
    });

    const ready = await ws.findText((v) => v.type === 'upload_ready' || v.type === 'error');
    if (!ready || ready.type !== 'upload_ready') {
        throw new Error(`Expected upload_ready, got: ${JSON.stringify(ready)}`);
    }
    const uploadId = (ready as { uploadId: number }).uploadId;

    // Send all data as a single chunk
    ws.sendBinary(encodeUploadChunk(uploadId, 0, data));

    ws.sendText({ type: 'upload_end', requestId: 'req-1', uploadId });

    const done = await ws.findText((v) => v.type === 'upload_done' || v.type === 'error');
    if (!done || done.type !== 'upload_done') {
        throw new Error(`Expected upload_done, got: ${JSON.stringify(done)}`);
    }
    const attachmentId = (done as { attachment: { id: number } }).attachment.id;
    return { ws, attachmentId };
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('attachments upload', () => {
    test('happy path: upload_start → chunk → upload_end → upload_done', async () => {
        const r = room();
        const fileData = Buffer.from('hello e2e world');
        const ws = await joinRoom(PORT(), r, 'alice');

        // First send a text message to get a real message_id
        ws.sendText({ type: 'message', body: 'test msg' });
        const msgEvent = await ws.findText((v) => v.type === 'message');
        expect(msgEvent).not.toBeNull();
        const messageId = (msgEvent as { id: number }).id;

        ws.sendText({
            type: 'upload_start',
            requestId: 'up-1',
            messageId,
            filename: 'hello.txt',
            size: fileData.length,
            mimeType: 'text/plain',
        });

        const ready = await ws.findText((v) => v.type === 'upload_ready');
        expect(ready).not.toBeNull();
        const uploadId = (ready as { uploadId: number }).uploadId;

        ws.sendBinary(encodeUploadChunk(uploadId, 0, fileData));
        ws.sendText({ type: 'upload_end', requestId: 'up-1', uploadId });

        const done = await ws.findText((v) => v.type === 'upload_done');
        expect(done).not.toBeNull();
        expect((done as { attachment: { filename: string } }).attachment.filename).toBe('hello.txt');
        expect((done as { attachment: { id: number } }).attachment.id).toBeGreaterThan(0);

        ws.close();
    });

    test('upload_done is broadcast to all room members', async () => {
        const r = room();
        const alice = await joinRoom(PORT(), r, 'alice');
        const bob = await joinRoom(PORT(), r, 'bob');

        alice.sendText({ type: 'message', body: 'shared' });
        const msgEvent = await alice.findText((v) => v.type === 'message');
        const messageId = (msgEvent as { id: number }).id;

        const fileData = Buffer.from('broadcast bytes');
        alice.sendText({
            type: 'upload_start', requestId: 'up-bc', messageId,
            filename: 'bc.bin', size: fileData.length, mimeType: 'application/octet-stream',
        });
        const ready = await alice.findText((v) => v.type === 'upload_ready');
        const uploadId = (ready as { uploadId: number }).uploadId;
        alice.sendBinary(encodeUploadChunk(uploadId, 0, fileData));
        alice.sendText({ type: 'upload_end', requestId: 'up-bc', uploadId });

        const aliceDone = await alice.findText((v) => v.type === 'upload_done');
        const bobDone = await bob.findText((v) => v.type === 'upload_done');

        expect(aliceDone).not.toBeNull();
        expect(bobDone).not.toBeNull();
        expect((aliceDone as { attachment: { id: number } }).attachment.id)
            .toBe((bobDone as { attachment: { id: number } }).attachment.id);

        alice.close();
        bob.close();
    });

    test('UPLOAD_TOO_LARGE when declared size exceeds 5 MB', async () => {
        const r = room();
        const ws = await joinRoom(PORT(), r, 'alice');

        ws.sendText({
            type: 'upload_start', requestId: 'up-big', messageId: 1,
            filename: 'big.bin', size: 5 * 1024 * 1024 + 1, mimeType: 'application/octet-stream',
        });

        const err = await ws.findText((v) => v.type === 'error');
        expect(err).not.toBeNull();
        expect((err as { code: string }).code).toBe('UPLOAD_TOO_LARGE');

        ws.close();
    });

    test('UPLOAD_LIMIT_EXCEEDED when 4th concurrent upload is attempted', async () => {
        const r = room();
        const ws = await joinRoom(PORT(), r, 'alice');

        ws.sendText({ type: 'message', body: 'msg' });
        const msgEvent = await ws.findText((v) => v.type === 'message');
        const messageId = (msgEvent as { id: number }).id;

        for (let i = 0; i < 3; i++) {
            ws.sendText({
                type: 'upload_start', requestId: `up-${i}`, messageId,
                filename: 'f.bin', size: 5, mimeType: 'application/octet-stream',
            });
            const r2 = await ws.findText((v) => v.type === 'upload_ready');
            expect(r2).not.toBeNull();
        }

        ws.sendText({
            type: 'upload_start', requestId: 'up-limit', messageId,
            filename: 'f.bin', size: 5, mimeType: 'application/octet-stream',
        });

        const err = await ws.findText((v) => v.type === 'error');
        expect(err).not.toBeNull();
        expect((err as { code: string }).code).toBe('UPLOAD_LIMIT_EXCEEDED');

        ws.close();
    });

    test('UPLOAD_CHUNK_OUT_OF_ORDER when chunk index is not 0', async () => {
        const r = room();
        const ws = await joinRoom(PORT(), r, 'alice');

        ws.sendText({ type: 'message', body: 'msg' });
        const msgEvent = await ws.findText((v) => v.type === 'message');
        const messageId = (msgEvent as { id: number }).id;

        ws.sendText({
            type: 'upload_start', requestId: 'up-oo', messageId,
            filename: 'f.bin', size: 10, mimeType: 'application/octet-stream',
        });
        const ready = await ws.findText((v) => v.type === 'upload_ready');
        const uploadId = (ready as { uploadId: number }).uploadId;

        ws.sendBinary(encodeUploadChunk(uploadId, 1, Buffer.alloc(5)));

        const err = await ws.findText((v) => v.type === 'error');
        expect(err).not.toBeNull();
        expect((err as { code: string }).code).toBe('UPLOAD_CHUNK_OUT_OF_ORDER');

        ws.close();
    });
});

describe('attachments download', () => {
    test('happy path: download_request → download_start → chunks → download_end', async () => {
        const r = room();
        const alice = await joinRoom(PORT(), r, 'alice');

        // Upload a file first
        alice.sendText({ type: 'message', body: 'msg' });
        const msgEvent = await alice.findText((v) => v.type === 'message');
        const messageId = (msgEvent as { id: number }).id;

        const fileData = Buffer.from(Array.from({ length: 200 }, (_, i) => i % 256));
        alice.sendText({
            type: 'upload_start', requestId: 'up-dl', messageId,
            filename: 'dl.bin', size: fileData.length, mimeType: 'application/octet-stream',
        });
        const ready = await alice.findText((v) => v.type === 'upload_ready');
        const uploadId = (ready as { uploadId: number }).uploadId;
        alice.sendBinary(encodeUploadChunk(uploadId, 0, fileData));
        alice.sendText({ type: 'upload_end', requestId: 'up-dl', uploadId });
        const done = await alice.findText((v) => v.type === 'upload_done');
        const attachmentId = (done as { attachment: { id: number } }).attachment.id;

        // Now download it
        alice.sendText({ type: 'download_request', requestId: 'dl-1', attachmentId });

        const start = await alice.findText((v) => v.type === 'download_start');
        expect(start).not.toBeNull();
        const totalChunks = (start as { totalChunks: number }).totalChunks;

        const received: Buffer[] = [];
        for (let i = 0; i < totalChunks; i++) {
            const bin = await alice.nextBinary();
            received.push(extractDownloadChunk(bin));
        }

        const endMsg = await alice.findText((v) => v.type === 'download_end');
        expect(endMsg).not.toBeNull();

        const assembled = Buffer.concat(received);
        expect(assembled).toEqual(fileData);

        alice.close();
    });

    test('ATTACHMENT_NOT_FOUND when downloading from a different room', async () => {
        const r1 = room();
        const r2 = room();
        const alice = await joinRoom(PORT(), r1, 'alice');
        const bob = await joinRoom(PORT(), r2, 'bob');

        // Alice uploads in r1
        alice.sendText({ type: 'message', body: 'msg' });
        const msgEvent = await alice.findText((v) => v.type === 'message');
        const messageId = (msgEvent as { id: number }).id;

        const fileData = Buffer.from('secret');
        alice.sendText({
            type: 'upload_start', requestId: 'up-scope', messageId,
            filename: 'secret.txt', size: fileData.length, mimeType: 'text/plain',
        });
        const ready = await alice.findText((v) => v.type === 'upload_ready');
        const uploadId = (ready as { uploadId: number }).uploadId;
        alice.sendBinary(encodeUploadChunk(uploadId, 0, fileData));
        alice.sendText({ type: 'upload_end', requestId: 'up-scope', uploadId });
        const done = await alice.findText((v) => v.type === 'upload_done');
        const attachmentId = (done as { attachment: { id: number } }).attachment.id;

        // Bob tries to download from r2
        bob.sendText({ type: 'download_request', requestId: 'dl-scope', attachmentId });
        const err = await bob.findText((v) => v.type === 'error');
        expect(err).not.toBeNull();
        expect((err as { code: string }).code).toBe('ATTACHMENT_NOT_FOUND');

        alice.close();
        bob.close();
    });
});
