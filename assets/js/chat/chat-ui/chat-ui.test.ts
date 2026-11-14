import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    bindArg,
    createStore,
    domCreator,
    domDispose,
    observer,
    on,
    SIGNAL_GET,
    SIGNAL_SET,
    trigger,
} from '../../utils';
import type { DomScope } from '../../utils';
import {
    CLIENT_FRAME_JOIN,
    CLIENT_FRAME_MESSAGE,
    CLIENT_FRAME_PING,
    CLIENT_FRAME_PAYLOAD_VARIANT,
    CLIENT_FRAME_PAYLOAD_VALUE,
    CLIENT_JOIN_NICKNAME,
    CLIENT_MESSAGE_BODY,
    encodeAuthSession,
    SERVER_FRAME_JOINED,
    SERVER_FRAME_ERROR,
} from '@month/gen/chat';
import type { ClientFramePayload, ServerFramePayload } from '@month/gen/chat';
import { createTestWindow } from '../../test-window';
import {
    CHAT_UI_ERROR,
    CHAT_UI_EVENT_TYPE,
    CHAT_UI_FILE_SELECTED,
    CHAT_UI_INIT,
    CHAT_UI_INIT_STATE,
    CHAT_UI_VOICE_JOIN,
    CHAT_UI_VOICE_MUTE,
    CHAT_UI_VOICE_LEAVE,
} from './events';
import type { ChatUiEvent } from './events';
import {
    createChatUiState,
    CHAT_UI_STATE_ACCESS_UNTIL,
    CHAT_UI_STATE_HAS_ACTIVE_ACCESS,
    CHAT_UI_STATE_IS_JOINED,
    CHAT_UI_STATE_IS_ONLINE,
    CHAT_UI_STATE_JOIN_IN_FLIGHT,
    CHAT_UI_STATE_MESSAGE,
    CHAT_UI_STATE_PENDING_TX_HASH,
    CHAT_UI_STATE_STATUS,
    CHAT_UI_STATE_ERROR,
    CHAT_UI_STATE_VOICE_IN_CALL,
    CHAT_UI_STATE_VOICE_MUTED,
    CHAT_UI_STATE_VOICE_PARTICIPANTS,
    CHAT_UI_STATE_WALLET_ADDRESS,
} from './state';
import type { ChatUiState } from './state';
import { CHAT_REF_FILE_INPUT, mountChatUi } from './template';
import { initChatUi } from './init';
import { applySessionStatusToState, tryAutoJoin } from './join-form-handler';
import {
    initChatOnboarding,
    ONBOARDING_CHAT_STATE,
    onboardingTemplate,
} from './onboarding';
import { savePendingPaymentTx } from '../auth';
import {
    attachmentItemTemplate,
    uploadPreviewTemplate,
} from '../attachments/template';

const findEl = <T extends HTMLElement = HTMLElement>(
    root: Element,
    tagName: string,
    text?: string
): T => {
    const upper = tagName.toUpperCase();
    const candidates = [root, ...Array.from(root.querySelectorAll(tagName))];
    for (const el of candidates) {
        if (
            el.tagName === upper &&
            (text === undefined || el.textContent === text)
        ) {
            return el as T;
        }
    }
    throw new Error(`Missing <${tagName}>: ${text ?? ''}`);
};

const fixture = (
    nickname = 'alice',
    walletAddress = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
    hasActiveAccess = true,
    accessUntil = 1_795_592_000,
    url = 'https://erdmko.dev/chat/test-room',
    overrides?: Record<string, unknown>
) => {
    const ctx = createTestWindow({ url, overrides });
    const root = ctx.document.createElement('div');
    root.dataset['roomId'] = 'test-room';
    const state = createChatUiState(
        nickname,
        walletAddress,
        hasActiveAccess,
        accessUntil
    );
    const outgoing = observer<ClientFramePayload>();
    const events = observer<ChatUiEvent>();
    const sent: ClientFramePayload[] = [];
    const received: ChatUiEvent[] = [];
    outgoing(bindArg((event: ClientFramePayload) => sent.push(event), on));
    events(bindArg((event: ChatUiEvent) => received.push(event), on));
    const refs = mountChatUi(ctx, root, 'nickname', outgoing, events, state);
    return {
        root,
        ctx,
        state,
        outgoing,
        events,
        sent,
        received,
        refs,
    };
};

test('chat controls and text update from signals without rebuilding the UI', () => {
    const { root, state } = fixture();
    const status = findEl(root, 'strong');
    const statusText = status.firstChild;
    const send = findEl<HTMLButtonElement>(root, 'button', 'Send');
    const textarea = findEl<HTMLTextAreaElement>(root, 'textarea');
    const chat = textarea.closest('form')!.parentElement!;
    assert.equal(status.textContent, 'connecting');
    assert.equal(send.disabled, true);
    assert.equal(chat.hidden, true);

    state[CHAT_UI_STATE_IS_ONLINE][SIGNAL_SET](true);
    state[CHAT_UI_STATE_STATUS][SIGNAL_SET]('online');
    state[CHAT_UI_STATE_ERROR][SIGNAL_SET]('Oops');
    assert.equal(status.textContent, 'online');
    assert.equal(status.firstChild, statusText);
    assert.equal(findEl(root, 'p').textContent, 'Oops');

    state[CHAT_UI_STATE_IS_JOINED][SIGNAL_SET](true);
    assert.equal(chat.hidden, false);
    state[CHAT_UI_STATE_MESSAGE][SIGNAL_SET]('hello');
    assert.equal(textarea.value, 'hello');
    assert.ok(root.textContent!.includes('5/200'));
    assert.equal(send.disabled, false);
    state[CHAT_UI_STATE_MESSAGE][SIGNAL_SET]('x'.repeat(201));
    assert.equal(send.disabled, true);
    state[CHAT_UI_STATE_IS_JOINED][SIGNAL_SET](false);
    assert.equal(chat.hidden, true);
    assert.equal(findEl(root, 'textarea'), textarea);
});

test('tryAutoJoin automatically emits CLIENT_FRAME_JOIN when online with active paid access', () => {
    const { ctx, state, outgoing, sent } = fixture('alice');
    tryAutoJoin(ctx, outgoing, state);
    assert.equal(sent.length, 0);

    state[CHAT_UI_STATE_IS_ONLINE][SIGNAL_SET](true);
    tryAutoJoin(ctx, outgoing, state);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.[CLIENT_FRAME_PAYLOAD_VARIANT], CLIENT_FRAME_JOIN);
    assert.equal(
        sent[0]?.[CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_JOIN_NICKNAME],
        'alice'
    );
    assert.equal(state[CHAT_UI_STATE_JOIN_IN_FLIGHT][SIGNAL_GET](), true);

    // Duplicate call while join is in flight does not send a second frame
    tryAutoJoin(ctx, outgoing, state);
    assert.equal(sent.length, 1);
});

test('composer events update signals, send on Enter, and emit file selections', () => {
    const { ctx, root, state, sent, received, refs } = fixture();
    state[CHAT_UI_STATE_IS_JOINED][SIGNAL_SET](true);
    const textarea = findEl<HTMLTextAreaElement>(root, 'textarea');
    textarea.value = '  hello  ';
    textarea.dispatchEvent(new ctx.Event('input'));
    assert.equal(state[CHAT_UI_STATE_MESSAGE][SIGNAL_GET](), '  hello  ');
    textarea.dispatchEvent(
        new ctx.KeyboardEvent('keydown', {
            key: 'Enter',
            shiftKey: true,
        })
    );
    assert.equal(sent.length, 0);
    textarea.dispatchEvent(
        new ctx.KeyboardEvent('keydown', {
            key: 'Enter',
            shiftKey: false,
        })
    );
    assert.equal(sent.length, 1);
    assert.equal(sent[0][CLIENT_FRAME_PAYLOAD_VARIANT], CLIENT_FRAME_MESSAGE);
    assert.equal(
        sent[0][CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_MESSAGE_BODY],
        'hello'
    );
    assert.equal(state[CHAT_UI_STATE_MESSAGE][SIGNAL_GET](), '');
    assert.equal(textarea.value, '');
    assert.ok(root.textContent!.includes('0/200'));
    assert.equal(
        findEl<HTMLButtonElement>(root, 'button', 'Send').disabled,
        true
    );
    textarea
        .closest('form')!
        .dispatchEvent(new ctx.Event('submit', { cancelable: true }));
    assert.equal(received.at(-1)?.[CHAT_UI_EVENT_TYPE], CHAT_UI_ERROR);

    const fileInput = refs[CHAT_REF_FILE_INPUT] as HTMLInputElement;
    let fileInputClicks = 0;
    fileInput.click = () => {
        fileInputClicks++;
    };
    findEl<HTMLButtonElement>(root, 'button', 'Attach').click();
    assert.equal(fileInputClicks, 1);

    const file = new ctx.File(['x'], 'a.txt', { type: 'text/plain' });
    Object.defineProperty(fileInput, 'files', {
        value: [file],
        configurable: true,
    });
    fileInput.dispatchEvent(new ctx.Event('change'));
    assert.deepEqual(received.at(-1), [CHAT_UI_FILE_SELECTED, file]);
});

test('voice actions use declarative events and participants reconcile by key', () => {
    const { root, state, received } = fixture();
    findEl<HTMLButtonElement>(root, 'button', 'Join voice').click();
    findEl<HTMLButtonElement>(root, 'button', 'Mute').click();
    findEl<HTMLButtonElement>(root, 'button', 'Leave').click();
    assert.deepEqual(received, [
        [CHAT_UI_VOICE_JOIN],
        [CHAT_UI_VOICE_MUTE],
        [CHAT_UI_VOICE_LEAVE],
    ]);
    state[CHAT_UI_STATE_VOICE_IN_CALL][SIGNAL_SET](true);
    assert.equal(findEl(root, 'button', 'Join voice').hidden, true);
    assert.equal(findEl(root, 'button', 'Mute').hidden, false);
    state[CHAT_UI_STATE_VOICE_MUTED][SIGNAL_SET](true);
    assert.equal(findEl(root, 'button', 'Unmute').hidden, false);
    state[CHAT_UI_STATE_VOICE_PARTICIPANTS][SIGNAL_SET]([
        ['u1', 'alice'],
        ['u2', 'bob'],
    ]);
    const alice = findEl(root, 'li', 'alice');
    const bob = findEl(root, 'li', 'bob');
    state[CHAT_UI_STATE_VOICE_PARTICIPANTS][SIGNAL_SET]([
        ['u2', 'bob'],
        ['u1', 'alice'],
    ]);
    assert.equal(findEl(root, 'li', 'alice'), alice);
    assert.equal(findEl(root, 'li', 'bob'), bob);
    assert.equal(bob.nextSibling, alice);
    state[CHAT_UI_STATE_VOICE_PARTICIPANTS][SIGNAL_SET]([['u1', 'renamed']]);
    assert.equal(findEl(root, 'li', 'renamed').textContent, 'renamed');
    assert.equal(alice.parentNode, null);
    assert.equal(bob.parentNode, null);
});

test('attachment progress binds text and visibility and disposes preview listeners', () => {
    const ctx = createTestWindow();
    const root = ctx.document.createElement('div');
    const progress = createStore('');
    const scope: DomScope = [];
    let removed = 0;
    domCreator(
        ctx,
        root,
        uploadPreviewTemplate(
            'a.txt',
            1,
            () => {
                removed++;
            },
            progress
        ),
        scope
    );
    const preview = root.firstElementChild as HTMLElement;
    const label = preview.lastElementChild as HTMLElement;
    assert.equal(label.hidden, true);
    progress[SIGNAL_SET]('1 / 2 chunks sent');
    assert.equal(label.hidden, false);
    assert.equal(label.textContent, '1 / 2 chunks sent');
    findEl<HTMLButtonElement>(root, 'button').click();
    assert.equal(removed, 1);
    domDispose(scope);
    progress[SIGNAL_SET]('Upload error');
    assert.equal(label.textContent, '1 / 2 chunks sent');
    findEl<HTMLButtonElement>(root, 'button').click();
    assert.equal(removed, 1);

    domCreator(
        ctx,
        root,
        attachmentItemTemplate('a.txt', 1, 'text/plain', () => {}, progress)
    );
    const downloadLabel = root.lastElementChild!
        .lastElementChild as HTMLElement;
    assert.equal(downloadLabel.textContent, 'Upload error');
    progress[SIGNAL_SET]('');
    assert.equal(downloadLabel.textContent, '');
    assert.equal(downloadLabel.hidden, true);
});

test('WebSocket lifecycle and server join errors drive the signal-bound UI', () => {
    let ws: any;
    const socketCtx = createTestWindow({
        url: 'http://localhost/chat/test-room',
        overrides: {
            WebSocket: class {
                onopen?: () => void;
                onclose?: () => void;
                onerror?: () => void;
                constructor(public url: string) {
                    ws = this;
                }
            },
        },
    });
    const root = socketCtx.document.createElement('div');
    root.dataset['roomId'] = 'test-room';
    const incoming: ((event: ServerFramePayload) => void)[] = [];
    const outgoing = observer<ClientFramePayload>();
    let state: ChatUiState | undefined;
    initChatUi(socketCtx, root, [outgoing, incoming])(
        (events) => {
            events(
                bindArg((event: ChatUiEvent) => {
                    if (event[CHAT_UI_EVENT_TYPE] === CHAT_UI_INIT)
                        state = event[CHAT_UI_INIT_STATE];
                }, on)
            );
        },
        (error) => {
            throw error;
        }
    );
    assert.ok(state);
    assert.equal(ws.url, 'ws://localhost/ws/chat/test-room');
    assert.equal(findEl(root, 'strong').textContent, 'connecting');
    ws.onopen();
    assert.equal(findEl(root, 'strong').textContent, 'online');
    state[CHAT_UI_STATE_JOIN_IN_FLIGHT][SIGNAL_SET](true);
    trigger([SERVER_FRAME_ERROR, ['', 'INVALID', 'Try again']], incoming);
    assert.equal(state[CHAT_UI_STATE_JOIN_IN_FLIGHT][SIGNAL_GET](), false);
    assert.equal(findEl(root, 'p').textContent, 'Try again');
    trigger([SERVER_FRAME_JOINED, ['join-1', 'sender-1', 'alice']], incoming);
    assert.equal(
        findEl<HTMLTextAreaElement>(root, 'textarea').closest('form')!
            .parentElement!.hidden,
        false
    );
    assert.equal(findEl(root, 'p').textContent, '');
    ws.onclose();
    assert.equal(findEl(root, 'strong').textContent, 'offline');
    assert.equal(state[CHAT_UI_STATE_IS_JOINED][SIGNAL_GET](), false);
    assert.equal(
        findEl<HTMLTextAreaElement>(root, 'textarea').closest('form')!
            .parentElement!.hidden,
        true
    );
    assert.equal(
        findEl<HTMLButtonElement>(root, 'button', 'Send').disabled,
        true
    );
});

test('WebSocket sends CLIENT_FRAME_PING on interval and redirects to onboarding on UNAUTHORIZED or PAYMENT_REQUIRED', () => {
    const incoming: ((event: ServerFramePayload) => void)[] = [];
    const outgoing = observer<ClientFramePayload>();
    const sent: ClientFramePayload[] = [];
    outgoing(bindArg((cmd: ClientFramePayload) => sent.push(cmd), on));

    let ws: any;
    const sentBuffers: ArrayBuffer[] = [];
    let intervalTick: (() => void) | undefined;
    let clearedTimerId: number | undefined;
    const socketCtx = createTestWindow({
        url: 'http://localhost/chat/test-room',
        overrides: {
            setInterval: (fn: () => void) => {
                intervalTick = fn;
                return 77;
            },
            clearInterval: (id: number) => {
                clearedTimerId = id;
            },
            WebSocket: class {
                OPEN = 1;
                readyState = 1;
                onopen?: () => void;
                onclose?: () => void;
                onerror?: () => void;
                constructor(public url: string) {
                    ws = this;
                }
                send(buf: ArrayBuffer) {
                    sentBuffers.push(buf);
                }
            },
        },
    });
    const root = socketCtx.document.createElement('div');
    root.dataset['roomId'] = 'test-room';

    let state: ChatUiState | undefined;
    initChatUi(socketCtx, root, [outgoing, incoming])(
        (events) => {
            events(
                bindArg((event: ChatUiEvent) => {
                    if (event[CHAT_UI_EVENT_TYPE] === CHAT_UI_INIT)
                        state = event[CHAT_UI_INIT_STATE];
                }, on)
            );
        },
        (error) => {
            throw error;
        }
    );

    ws.onopen();
    assert.ok(intervalTick);
    intervalTick!();
    assert.ok(
        sent.some(
            (frame) => frame[CLIENT_FRAME_PAYLOAD_VARIANT] === CLIENT_FRAME_PING
        )
    );
    assert.ok(
        sentBuffers.some((buf) => buf.byteLength >= 2),
        'serialized CLIENT_FRAME_PING binary frame must be non-empty on the wire'
    );

    trigger(
        [
            SERVER_FRAME_ERROR,
            ['', 'PAYMENT_REQUIRED', 'Active paid access is required.'],
        ],
        incoming
    );
    assert.equal(clearedTimerId, 77);
    assert.equal(state![CHAT_UI_STATE_IS_JOINED][SIGNAL_GET](), false);
    assert.equal(state![CHAT_UI_STATE_HAS_ACTIVE_ACCESS][SIGNAL_GET](), false);
    assert.equal(
        `${socketCtx.location.pathname}${socketCtx.location.search}`,
        '/chat?room=test-room'
    );
});

test('onboarding screen on /chat transitions across disconnected, connected unpaid, and connected paid states', () => {
    const ctx = createTestWindow({ url: 'https://erdmko.dev/chat' });
    const events = observer<ChatUiEvent>();
    const root = ctx.document.createElement('div');
    const state = createChatUiState('alice', '', false, 0);
    const roomSig = createStore('general');
    domCreator(
        ctx,
        root,
        onboardingTemplate(ctx, events, [state, roomSig, 'general'])
    );

    const connectBtn = findEl<HTMLButtonElement>(
        root,
        'button',
        'Connect Wallet'
    );
    const payBtn = findEl<HTMLButtonElement>(
        root,
        'button',
        'Pay & Unlock Chat'
    );
    const openBtn = findEl<HTMLButtonElement>(root, 'button', 'Open room');
    const form = findEl<HTMLFormElement>(root, 'form');

    // 1. Disconnected: Connect Wallet is shown, form is hidden, auth notice explains free SIWE + network/price/duration
    assert.equal(connectBtn.parentElement!.hidden, false);
    assert.equal(form.hidden, true);
    assert.equal(openBtn.disabled, true);
    assert.ok(
        root.textContent!.includes('Authorization required to join #general')
    );
    assert.ok(root.textContent!.includes('free SIWE sign-in'));
    assert.ok(
        root.textContent!.includes('0.001 ETH on Ethereum Mainnet for 30 days')
    );

    // 2. Connected but Unpaid: Wallet address + Pay & Unlock Chat shown, Open room hidden, price + network + duration shown
    state[CHAT_UI_STATE_WALLET_ADDRESS][SIGNAL_SET](
        '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'
    );
    assert.equal(connectBtn.parentElement!.hidden, true);
    assert.equal(form.hidden, false);
    assert.equal(payBtn.hidden, false);
    assert.equal(payBtn.disabled, false);
    assert.equal(openBtn.hidden, true);
    assert.equal(openBtn.disabled, true);
    assert.ok(
        root.textContent!.includes(
            'Paid access required to join #general (0.001 ETH on Ethereum Mainnet for 30 days)'
        )
    );
    assert.ok(
        root.textContent!.includes('0x7e5f4552091a69125d5dfcb7b8c2659029395bdf')
    );

    // 2b. Pending transaction restored from localStorage displays pending banner and Etherscan link
    const sampleTx = `0x${'ab'.repeat(32)}`;
    savePendingPaymentTx(
        ctx,
        '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
        sampleTx
    );
    applySessionStatusToState(
        ctx,
        'chat-nickname',
        ['0x7e5f4552091a69125d5dfcb7b8c2659029395bdf', 'alice', 0, false],
        state
    );
    assert.equal(state[CHAT_UI_STATE_PENDING_TX_HASH][SIGNAL_GET](), sampleTx);
    assert.ok(root.textContent!.includes('Pending payment (0xabababab...)'));
    const txLink = findEl<HTMLAnchorElement>(root, 'a', sampleTx);
    assert.equal(
        txLink.getAttribute('href'),
        `https://etherscan.io/tx/${sampleTx}`
    );

    // 3. Connected & Paid: active expiration date + Open room shown, Pay & Unlock Chat hidden, pending tx cleared
    applySessionStatusToState(
        ctx,
        'chat-nickname',
        [
            '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
            'alice',
            1_795_592_000,
            true,
        ],
        state
    );
    assert.equal(state[CHAT_UI_STATE_PENDING_TX_HASH][SIGNAL_GET](), '');
    assert.equal(payBtn.hidden, true);
    assert.equal(openBtn.hidden, false);
    assert.equal(openBtn.disabled, false);
    assert.ok(root.textContent!.includes('active until 2026-11-25'));
});

test('initChatOnboarding reacts to chainChanged, accountsChanged, and unauthenticated /auth/session protobuf config', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const protoHelperCtx = createTestWindow();
    const unauthBytes = encodeAuthSession(protoHelperCtx, '', '', 0, false, [
        1,
        '0xeff121f128e0e64c0e64ae8eb6eb042a0e5aa81c',
        '0x71afd498d0000', // 0.002 ETH
        604800, // 7 days
    ]);
    const ctx = createTestWindow({
        url: 'https://erdmko.dev/chat',
        overrides: {
            ['ethereum']: {
                ['request']: async () => '0x1',
                ['on']: (
                    event: string,
                    listener: (...args: unknown[]) => void
                ) => {
                    listeners.set(event, listener);
                },
            },
            fetch: async () =>
                ({
                    ok: true,
                    status: 200,
                    arrayBuffer: async () =>
                        unauthBytes.buffer.slice(
                            unauthBytes.byteOffset,
                            unauthBytes.byteOffset + unauthBytes.byteLength
                        ),
                }) as Response,
        },
    });

    const root = ctx.document.createElement('div');
    root.dataset['targetRoom'] = 'general';
    const onboardingState = initChatOnboarding(ctx, root);
    const state = onboardingState[ONBOARDING_CHAT_STATE];

    await new Promise((r) => setTimeout(r, 15));
    assert.ok(
        root.textContent!.includes('0.002 ETH on Ethereum Mainnet for 7 days'),
        'unauthenticated /auth/session protobuf response updates displayed terms before connecting'
    );

    applySessionStatusToState(
        ctx,
        'chat-nickname',
        ['0x7e5f4552091a69125d5dfcb7b8c2659029395bdf', null, 0, false],
        state
    );

    // 1. Switching to wrong chain (Base 0x2105) sets actionable banner error
    listeners.get('chainChanged')?.('0x2105');
    assert.ok(
        root.textContent!.includes(
            'Switch your wallet network to Ethereum Mainnet (chain ID 1) to continue.'
        )
    );

    // 2. Switching back to Mainnet (0x1) clears the error
    listeners.get('chainChanged')?.('0x1');
    assert.equal(state[CHAT_UI_STATE_ERROR][SIGNAL_GET](), '');

    // 3. Switching active wallet account resets onboarding wallet state and prompts reconnect
    listeners.get('accountsChanged')?.([
        '0x1111111111111111111111111111111111111111',
    ]);
    assert.equal(state[CHAT_UI_STATE_WALLET_ADDRESS][SIGNAL_GET](), '');
    assert.ok(
        root.textContent!.includes(
            'Wallet account changed — connect your wallet again to continue.'
        )
    );
});
