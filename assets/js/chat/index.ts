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
    CHAT_REF_ERROR,
    CHAT_REF_FORM,
    CHAT_REF_MESSAGE,
    CHAT_REF_MESSAGES,
    CHAT_REF_NICKNAME,
    CHAT_REF_SEND,
    CHAT_REF_STATUS,
    chatMessageTemplate,
    mountChatUi,
} from './template';
import {
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
    item: { senderName: string; body: string; createdAt?: string }
) => {
    domCreatorRef(
        ctx,
        list,
        chatMessageTemplate(item.senderName, item.body, item.createdAt)
    );
    list.scrollTop = list.scrollHeight;
};

const initTemplate = (ctx: Window, root: Element) => {
    const htmlRoot = root as HTMLDivElement;
    const roomId = htmlRoot.dataset.roomId || 'general';
    const refs = mountChatUi(ctx, htmlRoot, MAX_MESSAGE_LEN);
    const nicknameKey = `chat-nickname-${roomId}`;

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
    const updateControls = () => {
        const counter = refs[CHAT_REF_COUNTER];
        const message = refs[CHAT_REF_MESSAGE];
        const send = refs[CHAT_REF_SEND];
        counter.textContent = `${message.value.length}/${MAX_MESSAGE_LEN}`;
        send.disabled = !isValidMessage() || !isValidNickname();
    };

    const savedNickname = ctx.localStorage.getItem(nicknameKey);
    if (savedNickname && savedNickname.length <= MAX_NICKNAME_LEN) {
        refs[CHAT_REF_NICKNAME].value = savedNickname;
    }

    setStatus('connecting');
    updateControls();
    refs[CHAT_REF_SEND].disabled = true;
    const ws = new ctx.WebSocket(toWsUrl(ctx, roomId));
    const sendObserver = initSendObserver(ws, setError);

    ws.onopen = () => {
        setStatus('online');
        setError('');
        updateControls();
        const currentNickname = refs[CHAT_REF_NICKNAME].value.trim();
        if (currentNickname) {
            sendObserver(
                bindArg(
                    [JOIN_TYPE, `join-${Date.now()}`, currentNickname] as const,
                    trigger
                )
            );
        }
    };

    ws.onclose = () => {
        setStatus('offline');
        refs[CHAT_REF_SEND].disabled = true;
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
                renderMessage(ctx, refs[CHAT_REF_MESSAGES], item);
            });
            return;
        }

        if (payload.type === 'message' && payload.item) {
            renderMessage(ctx, refs[CHAT_REF_MESSAGES], payload.item);
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
                refs[CHAT_REF_FORM].requestSubmit();
            }
        }
    );

    refs[CHAT_REF_FORM].addEventListener('submit', (event) => {
        event.preventDefault();
        sendObserver(
            bindArg(
                [MESSAGE_TYPE, `msg-${Date.now()}`, getMessageBody()] as const,
                trigger
            )
        );
        refs[CHAT_REF_MESSAGE].value = '';
        updateControls();
    });
};

export const initChatEffect = (ctx: Window) => {
    const tags = ctx.document.querySelectorAll('.js-chat');
    Array.from(tags).forEach(bindArg(ctx, initTemplate));
};
