import {
    bindArg,
    cleanHtml,
    domCreatorRef,
    observer,
    on,
    trigger,
} from '@month/utils';
import {
    CHAT_REF_COUNTER,
    CHAT_REF_CHAT_SCREEN,
    CHAT_REF_ERROR,
    CHAT_REF_JOIN_BUTTON,
    CHAT_REF_JOIN_FORM,
    CHAT_REF_MESSAGE,
    CHAT_REF_MESSAGE_FORM,
    CHAT_REF_MESSAGES,
    CHAT_REF_NICKNAME,
    CHAT_REF_SEND,
    CHAT_REF_STATUS,
    CHAT_REF_WELCOME,
    chatMessageTemplate,
    mountChatUi,
} from './template';
import {
    DELETE_TYPE,
    JOIN_TYPE,
    MAX_MESSAGE_LEN,
    MAX_NICKNAME_LEN,
    MESSAGE_TYPE,
    SendCommand,
    serializeCommand,
    validateOutgoingCommand,
} from './protocol';

declare global {
    interface Window {
        WebSocket: typeof WebSocket;
    }
}

type WsPayload = {
    type: string;
    [key: string]: any;
};

const initSendObserver = (ws: WebSocket, setError: (text: string) => void) => {
    const outgoing = observer<SendCommand>();
    outgoing(
        bindArg((command: SendCommand) => {
            if (ws.readyState !== ws.OPEN) {
                setError('Socket is not connected.');
                return;
            }
            const validationError = validateOutgoingCommand(command);
            if (validationError) {
                setError(validationError);
                return;
            }
            const event = serializeCommand(command);
            if (!event) {
                setError('Unsupported event type.');
                return;
            }
            ws.send(JSON.stringify(event));
        }, on)
    );
    return outgoing;
};

const toWsUrl = (ctx: Window, roomId: string) => {
    const wsProtocol = ctx.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProtocol}//${ctx.location.host}/ws/chat/${encodeURIComponent(roomId)}`;
};

const renderMessage = (
    ctx: Window,
    list: HTMLUListElement,
    item: { id: number; senderId?: string; senderName: string; body: string; createdAt?: string },
    selfSenderId: string | null
) => {
    domCreatorRef(
        ctx,
        list,
        chatMessageTemplate(
            item.id,
            item.senderName,
            item.body,
            item.createdAt,
            !!(selfSenderId && item.senderId && item.senderId === selfSenderId)
        )
    );
    list.scrollTop = list.scrollHeight;
};

const initTemplate = (ctx: Window, root: Element) => {
    const htmlRoot = root as HTMLDivElement;
    const roomId = htmlRoot.dataset.roomId || 'general';
    const refs = mountChatUi(ctx, htmlRoot, MAX_MESSAGE_LEN);
    const nicknameKey = `chat-nickname-${roomId}`;
    let isJoined = false;
    let joinInFlight = false;
    let isOnline = false;
    let selfSenderId: string | null = null;

    const setStatus = (text: string) => {
        refs[CHAT_REF_STATUS].textContent = text;
    };
    const setError = (text: string) => {
        refs[CHAT_REF_ERROR].textContent = text;
    };
    const isValidNickname = () => {
        const value = refs[CHAT_REF_NICKNAME].value.trim();
        return value.length > 0 && value.length <= MAX_NICKNAME_LEN;
    };
    const getMessageBody = () => refs[CHAT_REF_MESSAGE].value.trim();
    const isValidMessage = () => {
        const body = getMessageBody();
        return body.length > 0 && body.length <= MAX_MESSAGE_LEN;
    };
    const showWelcome = () => {
        refs[CHAT_REF_WELCOME].hidden = false;
        refs[CHAT_REF_CHAT_SCREEN].hidden = true;
    };
    const showChat = () => {
        refs[CHAT_REF_WELCOME].hidden = true;
        refs[CHAT_REF_CHAT_SCREEN].hidden = false;
    };
    const updateControls = () => {
        const counter = refs[CHAT_REF_COUNTER];
        const message = refs[CHAT_REF_MESSAGE];
        const send = refs[CHAT_REF_SEND];
        const joinButton = refs[CHAT_REF_JOIN_BUTTON];
        counter.textContent = `${message.value.length}/${MAX_MESSAGE_LEN}`;
        send.disabled = !isJoined || !isValidMessage();
        joinButton.disabled = isJoined || joinInFlight || !isOnline || !isValidNickname();
    };
    const requestJoin = (): boolean => {
        if (isJoined || joinInFlight || !isValidNickname()) {
            return false;
        }
        if (!isOnline || ws.readyState !== ws.OPEN) {
            return false;
        }
        joinInFlight = true;
        sendObserver(
            bindArg(
                [JOIN_TYPE, `join-${Date.now()}`, refs[CHAT_REF_NICKNAME].value.trim()] as const,
                trigger
            )
        );
        return true;
    };
    const sendMessage = (body: string) => {
        sendObserver(
            bindArg(
                [MESSAGE_TYPE, `msg-${Date.now()}`, body] as const,
                trigger
            )
        );
    };
    const sendDelete = (messageId: number) => {
        sendObserver(
            bindArg(
                [DELETE_TYPE, `delete-${Date.now()}`, messageId] as const,
                trigger
            )
        );
    };

    const savedNickname = ctx.localStorage.getItem(nicknameKey);
    if (savedNickname && savedNickname.length <= MAX_NICKNAME_LEN) {
        refs[CHAT_REF_NICKNAME].value = savedNickname;
    }

    setStatus('connecting');
    showWelcome();
    isJoined = false;
    updateControls();
    refs[CHAT_REF_SEND].disabled = true;
    const ws = new ctx.WebSocket(toWsUrl(ctx, roomId));
    const sendObserver = initSendObserver(ws, setError);

    ws.onopen = () => {
        setStatus('online');
        setError('');
        isOnline = true;
        isJoined = false;
        joinInFlight = false;
        selfSenderId = null;
        updateControls();
    };

    ws.onclose = () => {
        setStatus('offline');
        isOnline = false;
        isJoined = false;
        joinInFlight = false;
        selfSenderId = null;
        showWelcome();
        refs[CHAT_REF_SEND].disabled = true;
        updateControls();
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
            cleanHtml(refs[CHAT_REF_MESSAGES]);
            payload.items.forEach((item) => {
                renderMessage(ctx, refs[CHAT_REF_MESSAGES], item, selfSenderId);
            });
            return;
        }

        if (payload.type === 'message' && payload.item) {
            renderMessage(ctx, refs[CHAT_REF_MESSAGES], payload.item, selfSenderId);
            return;
        }
        if (payload.type === 'deleted' && payload.messageId) {
            const target = refs[CHAT_REF_MESSAGES].querySelector(
                `[data-message-id="${payload.messageId}"]`
            );
            if (target) {
                target.remove();
            }
            return;
        }

        if (payload.type === 'error') {
            joinInFlight = false;
            setError(payload.message || 'Unknown error');
            updateControls();
            return;
        }

        if (payload.type === 'joined') {
            isJoined = true;
            joinInFlight = false;
            selfSenderId = payload.self?.senderId || null;
            setError('');
            showChat();
            updateControls();
        }
    };

    refs[CHAT_REF_NICKNAME].addEventListener('input', () => {
        const value = refs[CHAT_REF_NICKNAME].value.trim();
        if (value) {
            ctx.localStorage.setItem(nicknameKey, value);
        }
        updateControls();
    });

    refs[CHAT_REF_MESSAGE].addEventListener('input', updateControls);

    refs[CHAT_REF_MESSAGE].addEventListener(
        'keydown',
        (event: KeyboardEvent) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                refs[CHAT_REF_MESSAGE_FORM].requestSubmit();
            }
        }
    );

    refs[CHAT_REF_JOIN_FORM].addEventListener('submit', (event) => {
        event.preventDefault();
        if (requestJoin()) {
            setError('');
            updateControls();
        } else if (!isValidNickname()) {
            setError(`Nickname must be between 1 and ${MAX_NICKNAME_LEN} characters.`);
        } else if (!isOnline) {
            setError('Socket is not connected.');
        }
    });

    refs[CHAT_REF_MESSAGE_FORM].addEventListener('submit', (event) => {
        event.preventDefault();
        const body = getMessageBody();
        if (!isValidMessage()) {
            setError(`Message must be between 1 and ${MAX_MESSAGE_LEN} characters.`);
            return;
        }
        if (!isJoined) {
            setError('Join the room first.');
            return;
        }
        sendMessage(body);
        refs[CHAT_REF_MESSAGE].value = '';
        updateControls();
    });
    refs[CHAT_REF_MESSAGES].addEventListener('click', (event) => {
        const target = event.target as HTMLElement | null;
        if (!target) {
            return;
        }
        const button = target.closest('[data-delete-id]') as HTMLElement | null;
        if (!button) {
            return;
        }
        const rawId = button.getAttribute('data-delete-id');
        const messageId = rawId ? Number(rawId) : NaN;
        if (!Number.isInteger(messageId) || messageId <= 0) {
            return;
        }
        sendDelete(messageId);
    });
};

export const initChatEffect = (ctx: Window) => {
    const tags = ctx.document.querySelectorAll('.js-chat');
    Array.from(tags).forEach(bindArg(ctx, initTemplate));
};
