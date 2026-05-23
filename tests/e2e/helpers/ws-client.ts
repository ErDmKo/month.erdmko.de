import WebSocket from 'ws';

export interface WsFrame {
    type: 'text' | 'binary';
    data: unknown;         // parsed JSON for text, Buffer for binary
    raw: string | Buffer;
}

/**
 * Minimal WebSocket client with async helpers for test assertions.
 *
 * All received frames are queued internally; `nextText()` / `nextBinary()`
 * drain the queue or wait for the next arriving frame.
 */
export class WsClient {
    private ws: WebSocket;
    private queue: WsFrame[] = [];
    private waiters: Array<(frame: WsFrame) => void> = [];
    private closed = false;

    private constructor(ws: WebSocket) {
        this.ws = ws;
        ws.on('message', (data, isBinary) => {
            let frame: WsFrame;
            if (isBinary) {
                frame = { type: 'binary', data: data as Buffer, raw: data as Buffer };
            } else {
                const str = data.toString();
                frame = { type: 'text', data: JSON.parse(str), raw: str };
            }
            if (this.waiters.length > 0) {
                this.waiters.shift()!(frame);
            } else {
                this.queue.push(frame);
            }
        });
        ws.on('close', () => { this.closed = true; });
    }

    static connect(url: string, origin = 'http://localhost:8080'): Promise<WsClient> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url, { headers: { Origin: origin } });
            ws.once('open', () => resolve(new WsClient(ws)));
            ws.once('error', reject);
        });
    }

    sendText(obj: unknown): void {
        this.ws.send(JSON.stringify(obj));
    }

    sendBinary(buf: Buffer | Uint8Array): void {
        this.ws.send(buf);
    }

    /** Wait for the next frame of any type. */
    private nextFrame(timeoutMs = 5000): Promise<WsFrame> {
        if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const idx = this.waiters.indexOf(resolve);
                if (idx !== -1) this.waiters.splice(idx, 1);
                reject(new Error(`WsClient.nextFrame timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.waiters.push((frame) => {
                clearTimeout(timer);
                resolve(frame);
            });
        });
    }

    /** Wait for the next text frame and return the parsed JSON. */
    async nextText(timeoutMs = 5000): Promise<Record<string, unknown>> {
        while (true) {
            const frame = await this.nextFrame(timeoutMs);
            if (frame.type === 'text') return frame.data as Record<string, unknown>;
        }
    }

    /**
     * Scan up to `max` frames for a text frame satisfying `pred`.
     * Returns the matched frame or null.
     */
    async findText(
        pred: (v: Record<string, unknown>) => boolean,
        max = 10,
        timeoutMs = 5000,
    ): Promise<Record<string, unknown> | null> {
        for (let i = 0; i < max; i++) {
            let frame: WsFrame;
            try {
                frame = await this.nextFrame(timeoutMs);
            } catch {
                return null;
            }
            if (frame.type === 'text' && pred(frame.data as Record<string, unknown>)) {
                return frame.data as Record<string, unknown>;
            }
        }
        return null;
    }

    /** Wait for the next binary frame and return it as a Buffer. */
    async nextBinary(timeoutMs = 5000): Promise<Buffer> {
        while (true) {
            const frame = await this.nextFrame(timeoutMs);
            if (frame.type === 'binary') return frame.data as Buffer;
        }
    }

    close(): void {
        if (!this.closed) this.ws.close();
    }
}

/**
 * Convenience: connect and perform the join handshake.
 * Returns the WsClient after `joined` and `history` events are consumed.
 */
export async function joinRoom(
    port: number,
    room: string,
    nickname: string,
): Promise<WsClient> {
    const ws = await WsClient.connect(`ws://127.0.0.1:${port}/ws/chat/${room}`);
    ws.sendText({ type: 'join', nickname });
    // consume joined + history
    await ws.nextText();
    await ws.nextText();
    return ws;
}
