import { bindArg, observer, on, SIGNAL_SET, trigger, Task } from '../../utils';
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
import { mountChatUi } from './template';
import {
    CHAT_UI_STATE_IS_JOINED,
    CHAT_UI_STATE_JOIN_IN_FLIGHT,
    CHAT_UI_STATE_IS_ONLINE,
    CHAT_UI_STATE_STATUS,
    CHAT_UI_STATE_ERROR,
    createChatUiState,
} from './state';

export {
    CHAT_UI_INIT,
    CHAT_UI_ERROR,
    CHAT_UI_JOINED,
    CHAT_UI_FILE_SELECTED,
    CHAT_UI_EVENT_TYPE,
    CHAT_UI_INIT_REFS,
    CHAT_UI_INIT_STATE,
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
        const roomId = htmlRoot.dataset['roomId'] || 'general';
        const nicknameKey = `chat-nickname-${roomId}`;
        const chatUiObs = observer<ChatUiEvent>();

        const outgoing = socket[CHAT_SOCKET_OUTGOING];
        const incoming = socket[CHAT_SOCKET_INCOMING];

        const savedNickname = ctx.localStorage.getItem(nicknameKey);
        const state = createChatUiState(
            savedNickname && savedNickname.length <= MAX_NICKNAME_LEN
                ? savedNickname
                : ''
        );
        const refs = mountChatUi(
            ctx,
            htmlRoot,
            nicknameKey,
            outgoing,
            chatUiObs,
            state
        );
        const setStatus = state[CHAT_UI_STATE_STATUS][SIGNAL_SET];
        const setError = state[CHAT_UI_STATE_ERROR][SIGNAL_SET];

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
            state[CHAT_UI_STATE_IS_ONLINE][SIGNAL_SET](true);
            state[CHAT_UI_STATE_IS_JOINED][SIGNAL_SET](false);
            state[CHAT_UI_STATE_JOIN_IN_FLIGHT][SIGNAL_SET](false);
            chatUiObs(bindArg([CHAT_UI_JOINED, null] as const, trigger));
        };

        ws.onclose = () => {
            setStatus('offline');
            state[CHAT_UI_STATE_IS_ONLINE][SIGNAL_SET](false);
            state[CHAT_UI_STATE_IS_JOINED][SIGNAL_SET](false);
            state[CHAT_UI_STATE_JOIN_IN_FLIGHT][SIGNAL_SET](false);
            chatUiObs(bindArg([CHAT_UI_JOINED, null] as const, trigger));
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
                state[CHAT_UI_STATE_JOIN_IN_FLIGHT][SIGNAL_SET](false);
                setError(
                    event[SERVER_FRAME_PAYLOAD_VALUE][SERVER_ERROR_MESSAGE] ||
                        'Unknown error'
                );
                return;
            }
            if (event[SERVER_FRAME_PAYLOAD_VARIANT] === SERVER_FRAME_JOINED) {
                state[CHAT_UI_STATE_IS_JOINED][SIGNAL_SET](true);
                state[CHAT_UI_STATE_JOIN_IN_FLIGHT][SIGNAL_SET](false);
                setError('');
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

        // resolve first so downstream can subscribe, then fire INIT
        resolve(chatUiObs);
        chatUiObs(bindArg([CHAT_UI_INIT, refs, state] as const, trigger));
    };
