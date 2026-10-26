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
    CLIENT_FRAME_PAYLOAD_VARIANT,
    CLIENT_FRAME_PAYLOAD_VALUE,
    CLIENT_JOIN_NICKNAME,
    CLIENT_MESSAGE_BODY,
    SERVER_FRAME_JOINED,
    SERVER_FRAME_ERROR,
} from '@month/gen/chat';
import type { ClientFramePayload, ServerFramePayload } from '@month/gen/chat';
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
    CHAT_UI_STATE_IS_JOINED,
    CHAT_UI_STATE_IS_ONLINE,
    CHAT_UI_STATE_JOIN_IN_FLIGHT,
    CHAT_UI_STATE_STATUS,
    CHAT_UI_STATE_ERROR,
    CHAT_UI_STATE_MESSAGE,
    CHAT_UI_STATE_VOICE_IN_CALL,
    CHAT_UI_STATE_VOICE_MUTED,
    CHAT_UI_STATE_VOICE_PARTICIPANTS,
} from './state';
import type { ChatUiState } from './state';
import { CHAT_REF_FILE_INPUT, mountChatUi } from './template';
import { initChatUi } from './init';
import {
    attachmentItemTemplate,
    uploadPreviewTemplate,
} from '../attachments/template';

// Minimal browser doubles; production code still receives an explicit Window.
class MockNode {
    parentNode: MockNode | null = null;
    childNodes: MockNode[] = [];
    attributes = new Map<string, string>();
    listeners = new Map<string, (event: any) => void>();
    hidden = false;
    disabled = false;
    value = '';
    files: File[] = [];
    clicks = 0;
    submits = 0;
    dataset = { ['roomId']: 'test-room' };

    constructor(
        public tagName: string,
        public data = ''
    ) {}

    get textContent(): string {
        return (
            this.data + this.childNodes.map((node) => node.textContent).join('')
        );
    }
    get firstChild(): MockNode | null {
        return this.childNodes[0] ?? null;
    }
    get nextSibling(): MockNode | null {
        const siblings = this.parentNode?.childNodes ?? [];
        return siblings[siblings.indexOf(this) + 1] ?? null;
    }
    get form(): MockNode | null {
        return this.parentNode?.tagName === 'form'
            ? this.parentNode
            : (this.parentNode?.form ?? null);
    }
    setAttribute(key: string, value: string) {
        this.attributes.set(key, value);
    }
    removeAttribute(key: string) {
        this.attributes.delete(key);
    }
    appendChild(node: MockNode) {
        return this.insertBefore(node, null);
    }
    insertBefore(node: MockNode, anchor: MockNode | null): MockNode {
        node.parentNode?.removeChild(node);
        node.parentNode = this;
        const index = anchor
            ? this.childNodes.indexOf(anchor)
            : this.childNodes.length;
        this.childNodes.splice(index, 0, node);
        return node;
    }
    removeChild(node: MockNode): MockNode {
        this.childNodes.splice(this.childNodes.indexOf(node), 1);
        node.parentNode = null;
        return node;
    }
    addEventListener(type: string, listener: (event: any) => void) {
        this.listeners.set(type, listener);
    }
    removeEventListener(type: string) {
        this.listeners.delete(type);
    }
    dispatch(type: string, fields: Record<string, unknown> = {}) {
        this.listeners.get(type)?.({
            currentTarget: this,
            preventDefault() {},
            ...fields,
        });
    }
    click() {
        this.clicks++;
        this.dispatch('click');
    }
    requestSubmit() {
        this.submits++;
        this.dispatch('submit');
    }
    find(tagName: string, text?: string): MockNode {
        if (
            this.tagName === tagName &&
            (text === undefined || this.textContent === text)
        )
            return this;
        for (const child of this.childNodes) {
            const match = child.findOptional(tagName, text);
            if (match) return match;
        }
        throw new Error(`Missing ${tagName}: ${text ?? ''}`);
    }
    findOptional(tagName: string, text?: string): MockNode | null {
        if (
            this.tagName === tagName &&
            (text === undefined || this.textContent === text)
        )
            return this;
        for (const child of this.childNodes) {
            const match = child.findOptional(tagName, text);
            if (match) return match;
        }
        return null;
    }
}

const fixture = (nickname = 'alice') => {
    const root = new MockNode('root');
    const storage = new Map<string, string>();
    const ctx = {
        document: {
            createElement: (tag: string) => new MockNode(tag),
            createTextNode: (text: string) => new MockNode('#text', text),
        },
        localStorage: {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
        },
        Date,
    } as unknown as Window;
    const state = createChatUiState(nickname);
    const outgoing = observer<ClientFramePayload>();
    const events = observer<ChatUiEvent>();
    const sent: ClientFramePayload[] = [];
    const received: ChatUiEvent[] = [];
    outgoing(bindArg((event: ClientFramePayload) => sent.push(event), on));
    events(bindArg((event: ChatUiEvent) => received.push(event), on));
    const refs = mountChatUi(
        ctx,
        root as unknown as HTMLDivElement,
        'nickname',
        outgoing,
        events,
        state
    );
    return {
        root,
        ctx,
        state,
        outgoing,
        events,
        sent,
        received,
        storage,
        refs,
    };
};

test('chat controls and text update from signals without rebuilding the UI', () => {
    const { root, state } = fixture();
    const status = root.find('strong');
    const statusText = status.firstChild;
    const join = root.find('button', 'Join room');
    const send = root.find('button', 'Send');
    const textarea = root.find('textarea');
    const welcome = root.find('form').parentNode!;
    const chat = textarea.form!.parentNode!;
    assert.equal(status.textContent, 'connecting');
    assert.equal(join.disabled, true);
    assert.equal(send.disabled, true);
    assert.equal(welcome.hidden, false);
    assert.equal(chat.hidden, true);

    state[CHAT_UI_STATE_IS_ONLINE][SIGNAL_SET](true);
    assert.equal(join.disabled, false);
    state[CHAT_UI_STATE_JOIN_IN_FLIGHT][SIGNAL_SET](true);
    assert.equal(join.disabled, true);
    state[CHAT_UI_STATE_STATUS][SIGNAL_SET]('online');
    state[CHAT_UI_STATE_ERROR][SIGNAL_SET]('Oops');
    assert.equal(status.textContent, 'online');
    assert.equal(status.firstChild, statusText);
    assert.equal(root.find('p').textContent, 'Oops');

    state[CHAT_UI_STATE_IS_JOINED][SIGNAL_SET](true);
    assert.equal(welcome.hidden, true);
    assert.equal(chat.hidden, false);
    state[CHAT_UI_STATE_MESSAGE][SIGNAL_SET]('hello');
    assert.equal(textarea.value, 'hello');
    assert.ok(root.textContent.includes('5/200'));
    assert.equal(send.disabled, false);
    state[CHAT_UI_STATE_MESSAGE][SIGNAL_SET]('x'.repeat(201));
    assert.equal(send.disabled, true);
    state[CHAT_UI_STATE_IS_JOINED][SIGNAL_SET](false);
    assert.equal(welcome.hidden, false);
    assert.equal(chat.hidden, true);
    assert.equal(root.find('textarea'), textarea);
});

test('join input persists nicknames and submit prevents duplicate pending joins', () => {
    const { root, state, sent, storage } = fixture('');
    const input = root.find('input');
    const join = root.find('button', 'Join room');
    state[CHAT_UI_STATE_IS_ONLINE][SIGNAL_SET](true);
    input.value = '   ';
    input.dispatch('input');
    assert.equal(join.disabled, true);
    input.form!.dispatch('submit');
    assert.equal(sent.length, 0);
    assert.ok(
        state[CHAT_UI_STATE_ERROR][SIGNAL_GET]().includes('Nickname must')
    );

    input.value = '  alice  ';
    input.dispatch('input');
    assert.equal(storage.get('nickname'), 'alice');
    assert.equal(join.disabled, false);
    input.form!.dispatch('submit');
    assert.equal(sent.length, 1);
    assert.equal(sent[0][CLIENT_FRAME_PAYLOAD_VARIANT], CLIENT_FRAME_JOIN);
    assert.equal(
        sent[0][CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_JOIN_NICKNAME],
        'alice'
    );
    assert.equal(state[CHAT_UI_STATE_JOIN_IN_FLIGHT][SIGNAL_GET](), true);
    assert.equal(join.disabled, true);
    input.form!.dispatch('submit');
    assert.equal(sent.length, 1);
    state[CHAT_UI_STATE_JOIN_IN_FLIGHT][SIGNAL_SET](false);
    assert.equal(join.disabled, false);
});

test('composer events update signals, send on Enter, and emit file selections', () => {
    const { root, state, sent, received, refs } = fixture();
    state[CHAT_UI_STATE_IS_JOINED][SIGNAL_SET](true);
    const textarea = root.find('textarea');
    textarea.value = '  hello  ';
    textarea.dispatch('input');
    assert.equal(state[CHAT_UI_STATE_MESSAGE][SIGNAL_GET](), '  hello  ');
    textarea.dispatch('keydown', { key: 'Enter', shiftKey: true });
    assert.equal(sent.length, 0);
    textarea.dispatch('keydown', { key: 'Enter', shiftKey: false });
    assert.equal(sent.length, 1);
    assert.equal(sent[0][CLIENT_FRAME_PAYLOAD_VARIANT], CLIENT_FRAME_MESSAGE);
    assert.equal(
        sent[0][CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_MESSAGE_BODY],
        'hello'
    );
    assert.equal(state[CHAT_UI_STATE_MESSAGE][SIGNAL_GET](), '');
    assert.equal(textarea.value, '');
    assert.ok(root.textContent.includes('0/200'));
    assert.equal(root.find('button', 'Send').disabled, true);
    textarea.form!.dispatch('submit');
    assert.equal(received.at(-1)?.[CHAT_UI_EVENT_TYPE], CHAT_UI_ERROR);

    root.find('button', 'Attach').click();
    const fileInput = refs[CHAT_REF_FILE_INPUT] as unknown as MockNode;
    assert.equal(fileInput.clicks, 1);
    const file = { name: 'a.txt', size: 1 } as File;
    fileInput.files = [file];
    fileInput.dispatch('change');
    assert.deepEqual(received.at(-1), [CHAT_UI_FILE_SELECTED, file]);
});

test('voice actions use declarative events and participants reconcile by key', () => {
    const { root, state, received } = fixture();
    root.find('button', 'Join voice').click();
    root.find('button', 'Mute').click();
    root.find('button', 'Leave').click();
    assert.deepEqual(received, [
        [CHAT_UI_VOICE_JOIN],
        [CHAT_UI_VOICE_MUTE],
        [CHAT_UI_VOICE_LEAVE],
    ]);
    state[CHAT_UI_STATE_VOICE_IN_CALL][SIGNAL_SET](true);
    assert.equal(root.find('button', 'Join voice').hidden, true);
    assert.equal(root.find('button', 'Mute').hidden, false);
    state[CHAT_UI_STATE_VOICE_MUTED][SIGNAL_SET](true);
    assert.equal(root.find('button', 'Unmute').hidden, false);
    state[CHAT_UI_STATE_VOICE_PARTICIPANTS][SIGNAL_SET]([
        ['u1', 'alice'],
        ['u2', 'bob'],
    ]);
    const alice = root.find('li', 'alice');
    const bob = root.find('li', 'bob');
    state[CHAT_UI_STATE_VOICE_PARTICIPANTS][SIGNAL_SET]([
        ['u2', 'bob'],
        ['u1', 'alice'],
    ]);
    assert.equal(root.find('li', 'alice'), alice);
    assert.equal(root.find('li', 'bob'), bob);
    assert.equal(bob.nextSibling, alice);
    state[CHAT_UI_STATE_VOICE_PARTICIPANTS][SIGNAL_SET]([['u1', 'renamed']]);
    assert.equal(root.find('li', 'renamed').textContent, 'renamed');
    assert.equal(alice.parentNode, null);
    assert.equal(bob.parentNode, null);
});

test('attachment progress binds text and visibility and disposes preview listeners', () => {
    const { ctx } = fixture();
    const root = new MockNode('root');
    const progress = createStore('');
    const scope: DomScope = [];
    let removed = 0;
    domCreator(
        ctx,
        root as unknown as HTMLElement,
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
    const preview = root.find('div');
    const label = preview.childNodes.at(-1)!;
    assert.equal(label.hidden, true);
    progress[SIGNAL_SET]('1 / 2 chunks sent');
    assert.equal(label.hidden, false);
    assert.equal(label.textContent, '1 / 2 chunks sent');
    root.find('button').click();
    assert.equal(removed, 1);
    domDispose(scope);
    progress[SIGNAL_SET]('Upload error');
    assert.equal(label.textContent, '1 / 2 chunks sent');
    root.find('button').click();
    assert.equal(removed, 1);

    domCreator(
        ctx,
        root as unknown as HTMLElement,
        attachmentItemTemplate('a.txt', 1, 'text/plain', () => {}, progress)
    );
    const downloadLabel = root.childNodes.at(-1)!.childNodes.at(-1)!;
    assert.equal(downloadLabel.textContent, 'Upload error');
    progress[SIGNAL_SET]('');
    assert.equal(downloadLabel.textContent, '');
    assert.equal(downloadLabel.hidden, true);
});

test('WebSocket lifecycle and server join errors drive the signal-bound UI', () => {
    const { ctx } = fixture();
    const root = new MockNode('root');
    const incoming: ((event: ServerFramePayload) => void)[] = [];
    const outgoing = observer<ClientFramePayload>();
    let ws: any;
    const socketCtx = {
        ...ctx,
        location: { protocol: 'http:', host: 'localhost' },
        WebSocket: class {
            onopen?: () => void;
            onclose?: () => void;
            onerror?: () => void;
            constructor(public url: string) {
                ws = this;
            }
        },
    } as unknown as Window;
    let state: ChatUiState | undefined;
    initChatUi(socketCtx, root as unknown as Element, [outgoing, incoming])(
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
    assert.equal(root.find('strong').textContent, 'connecting');
    ws.onopen();
    assert.equal(root.find('strong').textContent, 'online');
    state[CHAT_UI_STATE_JOIN_IN_FLIGHT][SIGNAL_SET](true);
    trigger([SERVER_FRAME_ERROR, ['', 'INVALID', 'Try again']], incoming);
    assert.equal(state[CHAT_UI_STATE_JOIN_IN_FLIGHT][SIGNAL_GET](), false);
    assert.equal(root.find('p').textContent, 'Try again');
    trigger([SERVER_FRAME_JOINED, ['join-1', 'sender-1', 'alice']], incoming);
    assert.equal(root.find('textarea').form!.parentNode!.hidden, false);
    assert.equal(root.find('p').textContent, '');
    ws.onclose();
    assert.equal(root.find('strong').textContent, 'offline');
    assert.equal(state[CHAT_UI_STATE_IS_JOINED][SIGNAL_GET](), false);
    assert.equal(root.find('textarea').form!.parentNode!.hidden, true);
    assert.equal(root.find('button', 'Send').disabled, true);
});
