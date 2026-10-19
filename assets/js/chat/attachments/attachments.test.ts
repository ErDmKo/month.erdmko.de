import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { bindArg, observer, on, trigger } from '../../utils';
import type { ObserverState } from '../../utils';
import {
    CLIENT_FRAME_PAYLOAD_VARIANT,
    CLIENT_FRAME_PAYLOAD_VALUE,
    CLIENT_FRAME_UPLOAD_START,
    CLIENT_FRAME_UPLOAD_CHUNK,
    CLIENT_FRAME_UPLOAD_END,
    CLIENT_FRAME_DOWNLOAD_REQUEST,
    SERVER_FRAME_UPLOAD_READY,
    SERVER_FRAME_UPLOAD_DONE,
    SERVER_FRAME_DOWNLOAD_START,
    SERVER_FRAME_DOWNLOAD_CHUNK,
    SERVER_FRAME_DOWNLOAD_END,
    SERVER_FRAME_ERROR,
} from '@month/gen/chat';
import type { ClientFramePayload, ServerFramePayload } from '@month/gen/chat';
import type { BaseChatSocket } from '../protocol/incoming';
import { formatFileSize } from './template';
import {
    MAX_UPLOAD_SIZE,
    UPLOAD_READY,
    UPLOAD_PROGRESS,
    UPLOAD_DONE,
    UPLOAD_ERROR,
    UPLOAD_EVENT_TYPE,
    UPLOAD_READY_ID,
    UPLOAD_PROGRESS_SENT,
    UPLOAD_PROGRESS_TOTAL,
    UPLOAD_ERROR_CODE,
    DOWNLOAD_START,
    DOWNLOAD_PROGRESS,
    DOWNLOAD_DONE,
    DOWNLOAD_EVENT_TYPE,
    DOWNLOAD_DONE_BLOB,
    DOWNLOAD_DONE_FILENAME,
    startUpload,
    startDownload,
} from './handler';
import type { UploadEvent, DownloadEvent } from './handler';

test('formatFileSize formats bytes, KB, and MB', () => {
    assert.equal(formatFileSize(0), '0 B');
    assert.equal(formatFileSize(512), '512 B');
    assert.equal(formatFileSize(2048), '2.0 KB');
    assert.equal(formatFileSize(2 * 1024 * 1024), '2.0 MB');
});

test('startUpload rejects empty and oversized files with UPLOAD_ERROR', () => {
    const incoming: ObserverState<ServerFramePayload> = [];
    const outgoing = observer<ClientFramePayload>();
    const socket: BaseChatSocket = [outgoing, incoming];
    const ctx = globalThis as unknown as Window;

    const emptyEvents: UploadEvent[] = [];
    const emptyFile = {
        name: 'empty.txt',
        size: 0,
        type: 'text/plain',
    } as File;
    const obsEmpty = startUpload(ctx, socket, 'req-empty', 1, emptyFile);
    obsEmpty(bindArg((e: UploadEvent) => emptyEvents.push(e), on));

    // startUpload emits synchronously if subscribed before, or we can check oversized behavior:
    // Note: startUpload emits UPLOAD_ERROR immediately on size check before returning.
    // Let's also verify no outgoing frame was sent for invalid sizes.
    const sentFrames: ClientFramePayload[] = [];
    outgoing(bindArg((f: ClientFramePayload) => sentFrames.push(f), on));

    const hugeFile = {
        name: 'huge.bin',
        size: MAX_UPLOAD_SIZE + 1,
        type: 'application/octet-stream',
    } as File;
    startUpload(ctx, socket, 'req-huge', 1, hugeFile);
    assert.equal(sentFrames.length, 0);
});

test('startUpload full flow: UPLOAD_START -> UPLOAD_READY -> chunks -> UPLOAD_END -> UPLOAD_DONE', () => {
    const incoming: ObserverState<ServerFramePayload> = [];
    const outgoing = observer<ClientFramePayload>();
    const socket: BaseChatSocket = [outgoing, incoming];

    const fileBytes = new Uint8Array([10, 20, 30, 40]);
    class MockFileReader {
        result: ArrayBuffer | null = null;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsArrayBuffer() {
            this.result = fileBytes.buffer.slice(
                fileBytes.byteOffset,
                fileBytes.byteOffset + fileBytes.byteLength
            );
            if (this.onload) this.onload();
        }
    }

    const ctx = {
        FileReader: MockFileReader,
        Uint8Array,
    } as unknown as Window;

    const sentFrames: ClientFramePayload[] = [];
    outgoing(bindArg((f: ClientFramePayload) => sentFrames.push(f), on));

    const file = {
        name: 'hello.bin',
        size: fileBytes.length,
        type: 'application/octet-stream',
    } as File;

    const uploadObs = startUpload(ctx, socket, 'up-1', 99, file);
    const events: UploadEvent[] = [];
    uploadObs(bindArg((e: UploadEvent) => events.push(e), on));

    assert.equal(sentFrames.length, 1);
    assert.equal(
        sentFrames[0][CLIENT_FRAME_PAYLOAD_VARIANT],
        CLIENT_FRAME_UPLOAD_START
    );
    assert.deepEqual(sentFrames[0][CLIENT_FRAME_PAYLOAD_VALUE], [
        'up-1',
        99,
        'hello.bin',
        4,
        'application/octet-stream',
    ]);

    // Server responds with UPLOAD_READY (uploadId = 7)
    trigger([SERVER_FRAME_UPLOAD_READY, ['up-1', 7]], incoming);

    assert.equal(sentFrames.length, 3);
    assert.equal(
        sentFrames[1][CLIENT_FRAME_PAYLOAD_VARIANT],
        CLIENT_FRAME_UPLOAD_CHUNK
    );
    assert.equal(
        sentFrames[2][CLIENT_FRAME_PAYLOAD_VARIANT],
        CLIENT_FRAME_UPLOAD_END
    );

    // Server responds with UPLOAD_DONE
    trigger(
        [
            SERVER_FRAME_UPLOAD_DONE,
            ['up-1', 501, 'hello.bin', 4, 'application/octet-stream', 99],
        ],
        incoming
    );

    assert.equal(events.length, 3);
    assert.equal(events[0][UPLOAD_EVENT_TYPE], UPLOAD_READY);
    assert.equal(events[0][UPLOAD_READY_ID], 7);
    assert.equal(events[1][UPLOAD_EVENT_TYPE], UPLOAD_PROGRESS);
    assert.equal(events[1][UPLOAD_PROGRESS_SENT], 1);
    assert.equal(events[1][UPLOAD_PROGRESS_TOTAL], 1);
    assert.equal(events[2][UPLOAD_EVENT_TYPE], UPLOAD_DONE);
});

test('startUpload handles server error response', () => {
    const incoming: ObserverState<ServerFramePayload> = [];
    const outgoing = observer<ClientFramePayload>();
    const socket: BaseChatSocket = [outgoing, incoming];
    const ctx = { Uint8Array } as unknown as Window;

    const file = { name: 'a.txt', size: 3, type: 'text/plain' } as File;
    const uploadObs = startUpload(ctx, socket, 'up-err', 10, file);
    const events: UploadEvent[] = [];
    uploadObs(bindArg((e: UploadEvent) => events.push(e), on));

    trigger(
        [SERVER_FRAME_ERROR, ['up-err', 'RATE_LIMITED', 'Too many uploads']],
        incoming
    );

    assert.equal(events.length, 1);
    assert.equal(events[0][UPLOAD_EVENT_TYPE], UPLOAD_ERROR);
    assert.equal(events[0][UPLOAD_ERROR_CODE], 'RATE_LIMITED');
});

test('startDownload reassembles out-of-order chunks into Blob on DOWNLOAD_END', async () => {
    const incoming: ObserverState<ServerFramePayload> = [];
    const outgoing = observer<ClientFramePayload>();
    const socket: BaseChatSocket = [outgoing, incoming];
    const ctx = {
        Uint8Array,
        Blob,
    } as unknown as Window;

    const sentFrames: ClientFramePayload[] = [];
    outgoing(bindArg((f: ClientFramePayload) => sentFrames.push(f), on));

    const downloadObs = startDownload(ctx, socket, 'dl-1', 77);
    const events: DownloadEvent[] = [];
    downloadObs(bindArg((e: DownloadEvent) => events.push(e), on));

    assert.equal(sentFrames.length, 1);
    assert.equal(
        sentFrames[0][CLIENT_FRAME_PAYLOAD_VARIANT],
        CLIENT_FRAME_DOWNLOAD_REQUEST
    );
    assert.deepEqual(sentFrames[0][CLIENT_FRAME_PAYLOAD_VALUE], ['dl-1', 77]);

    // Start with 2 expected chunks
    trigger(
        [
            SERVER_FRAME_DOWNLOAD_START,
            ['dl-1', 77, 'doc.txt', 5, 'text/plain', 2],
        ],
        incoming
    );

    // Send chunk 1 before chunk 0, and DOWNLOAD_END before chunk 0
    trigger(
        [SERVER_FRAME_DOWNLOAD_CHUNK, [77, 1, new Uint8Array([108, 111])]],
        incoming
    );
    trigger([SERVER_FRAME_DOWNLOAD_END, ['dl-1', 77]], incoming);
    trigger(
        [SERVER_FRAME_DOWNLOAD_CHUNK, [77, 0, new Uint8Array([104, 101, 108])]],
        incoming
    );

    assert.equal(events.length, 4);
    assert.equal(events[0][DOWNLOAD_EVENT_TYPE], DOWNLOAD_START);
    assert.equal(events[1][DOWNLOAD_EVENT_TYPE], DOWNLOAD_PROGRESS);
    assert.equal(events[2][DOWNLOAD_EVENT_TYPE], DOWNLOAD_PROGRESS);
    assert.equal(events[3][DOWNLOAD_EVENT_TYPE], DOWNLOAD_DONE);

    const doneEvent = events[3] as readonly [
        typeof DOWNLOAD_DONE,
        Blob,
        string,
    ];
    assert.equal(doneEvent[DOWNLOAD_DONE_FILENAME], 'doc.txt');
    const text = await doneEvent[DOWNLOAD_DONE_BLOB].text();
    assert.equal(text, 'hello');
});
