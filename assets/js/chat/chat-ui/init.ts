import { bindArg, observer, on, trigger, Task } from '../../utils';
import {
    SERVER_FRAME_JOINED,
    SERVER_FRAME_ERROR,
    SERVER_FRAME_PAYLOAD_VARIANT,
    SERVER_FRAME_PAYLOAD_VALUE,
    SERVER_JOINED_SENDER_ID,
    SERVER_ERROR_REQUEST_ID,
    SERVER_ERROR_MESSAGE,
} from '@month/gen/chat';
import {
    CHAT_SOCKET_OUTGOING,
    CHAT_SOCKET_INCOMING,
    parseBinaryFrame,
} from '../protocol/incoming';
import type { ChatSocket } from '../protocol/incoming';
import {
    serializeCommand,
    validateOutgoingCommand,
} from '../protocol/outgoing';
import { MAX_NICKNAME_LEN } from './join-form-handler';
import type { ServerFramePayload, ClientFramePayload } from '@month/gen/chat';
import {
    CHAT_REF_STATUS,
    CHAT_REF_ERROR,
    CHAT_REF_WELCOME,
    CHAT_REF_CHAT_SCREEN,
    CHAT_REF_JOIN_BUTTON,
    CHAT_REF_NICKNAME,
    CHAT_REF_MESSAGE,
    CHAT_REF_COUNTER,
    CHAT_REF_SEND,
    mountChatUi,
} from './template';
import { mountJoinFormHandler } from './join-form-handler';
import { mountMessageFormHandler } from './message-form-handler';
import {
    CHAT_UI_STATE_IS_JOINED,
    CHAT_UI_STATE_JOIN_IN_FLIGHT,
    CHAT_UI_STATE_IS_ONLINE,
} from './state';
import type { ChatUiState } from './state';

export {
    CHAT_UI_INIT,
    CHAT_UI_ERROR,
    CHAT_UI_JOINED,
    CHAT_UI_FILE_SELECTED,
    CHAT_UI_EVENT_TYPE,
    CHAT_UI_INIT_REFS,
    CHAT_UI_ERROR_MESSAGE,
    CHAT_UI_JOINED_SENDER_ID,
    CHAT_UI_FILE_SELECTED_FILE,
} from './events';
export type { ChatUiEvent, ChatUiObs } from './events';

export {
    CHAT_UI_STATE_IS_JOINED,
    CHAT_UI_STATE_JOIN_IN_FLIGHT,
    CHAT_UI_STATE_IS_ONLINE,
} from './state';
export type { ChatUiState } from './state';

import {
    CHAT_UI_INIT,
    CHAT_UI_ERROR,
    CHAT_UI_JOINED,
    CHAT_UI_EVENT_TYPE,
    CHAT_UI_ERROR_MESSAGE,
} from './events';
import type { ChatUiEvent, ChatUiObs } from './events';

// ── initChatUi ────────────────────────────────────────────────────────────────

export const initChatUi =
    (ctx: Window, root: Element, socket: ChatSocket): Task<ChatUiObs> =>
    (resolve) => {
        const htmlRoot = root as HTMLDivElement;
        const roomId = htmlRoot.dataset.roomId || 'general';
        const nicknameKey = `chat-nickname-${roomId}`;
        const refs = mountChatUi(ctx, htmlRoot, 200);
        const chatUiObs = observer<ChatUiEvent>();

        const outgoing = socket[CHAT_SOCKET_OUTGOING];
        const incoming = socket[CHAT_SOCKET_INCOMING];

        // mutable state owned by chat-ui
        const state: ChatUiState = [false, false, false];

        const setStatus = (text: string) => {
            refs[CHAT_REF_STATUS].textContent = text;
        };
        const setError = (text: string) => {
            refs[CHAT_REF_ERROR].textContent = text;
        };
        const showWelcome = () => {
            refs[CHAT_REF_WELCOME].hidden = false;
            refs[CHAT_REF_CHAT_SCREEN].hidden = true;
        };
        const showChat = () => {
            refs[CHAT_REF_WELCOME].hidden = true;
            refs[CHAT_REF_CHAT_SCREEN].hidden = false;
        };
        const updateControls = (messageLen: number) => {
            const nickname = refs[CHAT_REF_NICKNAME].value.trim();
            const isValidNickname =
                nickname.length > 0 && nickname.length <= MAX_NICKNAME_LEN;
            refs[CHAT_REF_COUNTER].textContent = `${messageLen}/200`;
            refs[CHAT_REF_SEND].disabled =
                !state[CHAT_UI_STATE_IS_JOINED] || messageLen === 0;
            refs[CHAT_REF_JOIN_BUTTON].disabled =
                state[CHAT_UI_STATE_IS_JOINED] ||
                state[CHAT_UI_STATE_JOIN_IN_FLIGHT] ||
                !state[CHAT_UI_STATE_IS_ONLINE] ||
                !isValidNickname;
        };

        // ── WebSocket setup ───────────────────────────────────────────────────

        const wsProtocol = ctx.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsProtocol}//${ctx.location.host}/ws/chat/${encodeURIComponent(roomId)}`;
        const ws = new ctx.WebSocket(wsUrl);

        // wire outgoing observer → ws.send
        outgoing(
            bindArg((command: ClientFramePayload) => {
                if (ws.readyState !== ws.OPEN) {
                    setError('Socket is not connected.');
                    return;
                }
                const validationError = validateOutgoingCommand(command);
                if (validationError) {
                    setError(validationError);
                    return;
                }
                const frame = serializeCommand(ctx, command);
                if (!frame) {
                    setError('Unsupported event type.');
                    return;
                }
                ws.send(frame);
            }, on)
        );

        // wire ws.onmessage → incoming (all frames are binary)
        ws.onmessage = (msg) => {
            msg.data.arrayBuffer().then((buf: ArrayBuffer) => {
                const wsEvent = parseBinaryFrame(ctx, new ctx.Uint8Array(buf));
                if (wsEvent) trigger(wsEvent, incoming);
            });
        };

        // ── WS lifecycle ──────────────────────────────────────────────────────

        ws.onopen = () => {
            setStatus('online');
            setError('');
            state[CHAT_UI_STATE_IS_ONLINE] = true;
            state[CHAT_UI_STATE_IS_JOINED] = false;
            state[CHAT_UI_STATE_JOIN_IN_FLIGHT] = false;
            chatUiObs(bindArg([CHAT_UI_JOINED, null] as const, trigger));
            updateControls(refs[CHAT_REF_MESSAGE].value.length);
        };

        ws.onclose = () => {
            setStatus('offline');
            state[CHAT_UI_STATE_IS_ONLINE] = false;
            state[CHAT_UI_STATE_IS_JOINED] = false;
            state[CHAT_UI_STATE_JOIN_IN_FLIGHT] = false;
            showWelcome();
            refs[CHAT_REF_SEND].disabled = true;
            chatUiObs(bindArg([CHAT_UI_JOINED, null] as const, trigger));
            updateControls(refs[CHAT_REF_MESSAGE].value.length);
        };

        ws.onerror = () => {
            setError('Connection error.');
        };

        // ── WS event reactions (chat-ui owns: joined, global error) ───────────

        on((event: ServerFramePayload) => {
            if (
                event[SERVER_FRAME_PAYLOAD_VARIANT] === SERVER_FRAME_ERROR &&
                !event[SERVER_FRAME_PAYLOAD_VALUE][SERVER_ERROR_REQUEST_ID]
            ) {
                state[CHAT_UI_STATE_JOIN_IN_FLIGHT] = false;
                setError(
                    event[SERVER_FRAME_PAYLOAD_VALUE][SERVER_ERROR_MESSAGE] ||
                        'Unknown error'
                );
                updateControls(refs[CHAT_REF_MESSAGE].value.length);
                return;
            }
            if (event[SERVER_FRAME_PAYLOAD_VARIANT] === SERVER_FRAME_JOINED) {
                state[CHAT_UI_STATE_IS_JOINED] = true;
                state[CHAT_UI_STATE_JOIN_IN_FLIGHT] = false;
                setError('');
                showChat();
                updateControls(refs[CHAT_REF_MESSAGE].value.length);
                chatUiObs(
                    bindArg(
                        [
                            CHAT_UI_JOINED,
                            event[SERVER_FRAME_PAYLOAD_VALUE][
                                SERVER_JOINED_SENDER_ID
                            ],
                        ] as const,
                        trigger
                    )
                );
            }
        }, incoming);

        // ── External error channel ────────────────────────────────────────────

        chatUiObs(
            bindArg((event: ChatUiEvent) => {
                if (event[CHAT_UI_EVENT_TYPE] === CHAT_UI_ERROR) {
                    setError(event[CHAT_UI_ERROR_MESSAGE]);
                }
            }, on)
        );

        // ── Form handlers ─────────────────────────────────────────────────────

        mountJoinFormHandler(
            ctx,
            refs,
            nicknameKey,
            outgoing,
            state,
            setError,
            updateControls
        );

        mountMessageFormHandler(refs, outgoing, chatUiObs, state);

        // ── Initial UI state ──────────────────────────────────────────────────

        setStatus('connecting');
        showWelcome();
        updateControls(0);
        refs[CHAT_REF_SEND].disabled = true;

        // resolve first so downstream can subscribe, then fire INIT
        resolve(chatUiObs);
        chatUiObs(bindArg([CHAT_UI_INIT, refs] as const, trigger));
    };
