/**
 * chat.test.ts — basic WebSocket smoke tests (no file attachments).
 *
 * Requires the server to be running; port comes from E2E_SERVER_PORT set by
 * globalSetup.
 */
import { WsClient, joinRoom } from '../helpers/ws-client';

const PORT = () => parseInt(process.env.E2E_SERVER_PORT!, 10);
const room = () => `room-${Math.random().toString(36).slice(2)}`;

describe('chat smoke', () => {
    test('server accepts WebSocket connections', async () => {
        const ws = await WsClient.connect(`ws://127.0.0.1:${PORT()}/ws/chat/${room()}`);
        ws.close();
    });

    test('join sends joined then history', async () => {
        const r = room();
        const ws = await WsClient.connect(`ws://127.0.0.1:${PORT()}/ws/chat/${r}`);
        ws.sendText({ type: 'join', nickname: 'alice' });

        const joined = await ws.nextText();
        expect(joined.type).toBe('joined');

        const history = await ws.nextText();
        expect(history.type).toBe('history');
        expect(Array.isArray((history as { messages?: unknown }).messages ?? [])).toBe(true);

        ws.close();
    });

    test('message is broadcast to all room members', async () => {
        const r = room();
        const alice = await joinRoom(PORT(), r, 'alice');
        const bob = await joinRoom(PORT(), r, 'bob');

        alice.sendText({ type: 'message', body: 'hello from alice' });

        const aliceMsg = await alice.findText((v) => v.type === 'message' && (v as { body?: string }).body === 'hello from alice');
        expect(aliceMsg).not.toBeNull();

        const bobMsg = await bob.findText((v) => v.type === 'message' && (v as { body?: string }).body === 'hello from alice');
        expect(bobMsg).not.toBeNull();

        alice.close();
        bob.close();
    });

    test('messages from different rooms do not cross', async () => {
        const r1 = room();
        const r2 = room();
        const alice = await joinRoom(PORT(), r1, 'alice');
        const bob = await joinRoom(PORT(), r2, 'bob');

        alice.sendText({ type: 'message', body: 'room1 only' });

        const aliceReceives = await alice.findText((v) => v.type === 'message');
        expect(aliceReceives).not.toBeNull();

        // bob should receive nothing within the timeout
        const bobReceives = await bob.findText(() => true, 3, 1000);
        expect(bobReceives).toBeNull();

        alice.close();
        bob.close();
    });
});
