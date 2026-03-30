const MAX_MESSAGE_LEN = 200;
const MAX_NICKNAME_LEN = 32;

declare global {
    interface Window {
        WebSocket: typeof WebSocket;
    }
}

type WsPayload = {
    type: string;
    [key: string]: any;
};

const createElement = (ctx: Window, tag: string, className: string, text: string) => {
    const el = ctx.document.createElement(tag);
    el.className = className;
    el.textContent = text;
    return el;
};

const toWsUrl = (ctx: Window, roomId: string) => {
    const wsProtocol = ctx.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProtocol}//${ctx.location.host}/ws/chat/${encodeURIComponent(roomId)}`;
};

const renderMessage = (
    ctx: Window,
    list: HTMLUListElement,
    item: { senderName: string; body: string; createdAt?: string }
) => {
    const row = createElement(ctx, 'li', 'chat__message', '');
    const head = createElement(
        ctx,
        'div',
        'chat__message-head',
        `${item.senderName}${item.createdAt ? ` • ${item.createdAt}` : ''}`
    );
    const body = createElement(ctx, 'div', 'chat__message-body', item.body);
    row.appendChild(head);
    row.appendChild(body);
    list.appendChild(row);
    list.scrollTop = list.scrollHeight;
};

const initTemplate = (ctx: Window, root: Element) => {
    const htmlRoot = root as HTMLDivElement;
    const roomId = htmlRoot.dataset.roomId || 'general';
    const statusEl = htmlRoot.querySelector('.js-chat-status') as HTMLElement;
    const errorEl = htmlRoot.querySelector('.js-chat-error') as HTMLElement;
    const listEl = htmlRoot.querySelector('.js-chat-messages') as HTMLUListElement;
    const formEl = htmlRoot.querySelector('.js-chat-form') as HTMLFormElement;
    const nicknameEl = htmlRoot.querySelector('.js-chat-nickname') as HTMLInputElement;
    const messageEl = htmlRoot.querySelector('.js-chat-input') as HTMLTextAreaElement;
    const sendEl = htmlRoot.querySelector('.js-chat-send') as HTMLButtonElement;
    const counterEl = htmlRoot.querySelector('.js-chat-counter') as HTMLElement;
    const nicknameKey = `chat-nickname-${roomId}`;

    const setStatus = (text: string) => {
        statusEl.textContent = text;
    };
    const setError = (text: string) => {
        errorEl.textContent = text;
    };
    const isValidNickname = () => {
        const value = nicknameEl.value.trim();
        return value.length > 0 && value.length <= MAX_NICKNAME_LEN;
    };
    const getMessageBody = () => messageEl.value.trim();
    const isValidMessage = () => {
        const body = getMessageBody();
        return body.length > 0 && body.length <= MAX_MESSAGE_LEN;
    };
    const updateControls = () => {
        counterEl.textContent = `${messageEl.value.length}/${MAX_MESSAGE_LEN}`;
        sendEl.disabled = !isValidMessage() || !isValidNickname();
    };

    const savedNickname = ctx.localStorage.getItem(nicknameKey);
    if (savedNickname && savedNickname.length <= MAX_NICKNAME_LEN) {
        nicknameEl.value = savedNickname;
    }

    setStatus('connecting');
    updateControls();
    const ws = new ctx.WebSocket(toWsUrl(ctx, roomId));

    ws.onopen = () => {
        setStatus('online');
        setError('');
        updateControls();
        const nickname = nicknameEl.value.trim();
        if (nickname) {
            ctx.localStorage.setItem(nicknameKey, nickname);
            ws.send(
                JSON.stringify({
                    type: 'join',
                    requestId: `join-${Date.now()}`,
                    nickname,
                })
            );
        }
    };

    ws.onclose = () => {
        setStatus('offline');
        sendEl.disabled = true;
    };

    ws.onerror = () => {
        setError('Connection error.');
    };

    ws.onmessage = (event) => {
        let payload: WsPayload | null = null;
        try {
            payload = JSON.parse(event.data);
        } catch (_e) {
            setError('Invalid server payload.');
            return;
        }
        if (!payload) return;

        if (payload.type === 'history' && Array.isArray(payload.items)) {
            listEl.innerHTML = '';
            payload.items.forEach((item) => {
                renderMessage(ctx, listEl, {
                    senderName: item.senderName,
                    body: item.body,
                    createdAt: item.createdAt,
                });
            });
            return;
        }

        if (payload.type === 'message' && payload.item) {
            renderMessage(ctx, listEl, {
                senderName: payload.item.senderName,
                body: payload.item.body,
                createdAt: payload.item.createdAt,
            });
            return;
        }

        if (payload.type === 'error') {
            setError(payload.message || 'Unknown error');
            return;
        }

        if (payload.type === 'joined') {
            setError('');
        }
    };

    nicknameEl.addEventListener('input', () => {
        if (nicknameEl.value.trim()) {
            ctx.localStorage.setItem(nicknameKey, nicknameEl.value.trim());
        }
        updateControls();
    });

    messageEl.addEventListener('input', updateControls);

    messageEl.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            formEl.requestSubmit();
        }
    });

    formEl.addEventListener('submit', (event) => {
        event.preventDefault();
        if (ws.readyState !== ctx.WebSocket.OPEN) {
            setError('Socket is not connected.');
            return;
        }
        if (!isValidNickname()) {
            setError('Nickname must be between 1 and 32 characters.');
            return;
        }
        if (!isValidMessage()) {
            setError('Message must be between 1 and 200 characters.');
            return;
        }

        const nickname = nicknameEl.value.trim();
        if (nickname) {
            ctx.localStorage.setItem(nicknameKey, nickname);
        }

        ws.send(
            JSON.stringify({
                type: 'message',
                requestId: `msg-${Date.now()}`,
                body: getMessageBody(),
            })
        );
        messageEl.value = '';
        updateControls();
    });
};

export const initChatEffect = (ctx: Window) => {
    const tags = ctx.document.querySelectorAll('.js-chat');
    Array.from(tags).forEach((el) => initTemplate(ctx, el));
};
