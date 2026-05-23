import {
    bindArg,
    cleanHtml,
    observer,
    on,
    trigger,
    Task,
} from '../../utils';
import {
    SERVER_FRAME_HISTORY,
    SERVER_FRAME_MESSAGE,
    SERVER_FRAME_DELETED,
    SERVER_FRAME_ERROR,
    SERVER_FRAME_PAYLOAD_VARIANT,
    SERVER_FRAME_PAYLOAD_VALUE,
    SERVER_HISTORY_ITEMS,
    SERVER_MESSAGE_ITEM,
    SERVER_DELETED_MESSAGE_ID,
    SERVER_ERROR_REQUEST_ID,
    SERVER_ERROR_MESSAGE,
    CLIENT_FRAME_DELETE,
} from '../generated/chat';
import {
    CHAT_SOCKET_OUTGOING,
    CHAT_SOCKET_INCOMING,
} from '../protocol/incoming';
import type { ChatSocket } from '../protocol/incoming';
import type { ServerFramePayload } from '../generated/chat';
import { renderMessage, makeWaitForMessageId, MSGS_INIT } from './handler';
import type { MsgsEvent, MsgsObs } from './handler';
import {
    CHAT_UI_EVENT_TYPE,
    CHAT_UI_INIT,
    CHAT_UI_INIT_REFS,
    CHAT_UI_JOINED,
    CHAT_UI_JOINED_SENDER_ID,
    CHAT_UI_ERROR,
} from '../chat-ui/events';
import type { ChatUiObs, ChatUiEvent } from '../chat-ui/events';
import {
    CHAT_REF_MESSAGES,
} from '../chat-ui/template';

export const initMessages = (
    ctx: Window,
    socket: ChatSocket,
    chatUiObs: ChatUiObs
): Task<MsgsObs> =>
    (resolve) => {
        const msgsObs = observer<MsgsEvent>();
        const outgoing = socket[CHAT_SOCKET_OUTGOING];
        const incoming = socket[CHAT_SOCKET_INCOMING];
        const waitForMessageId = makeWaitForMessageId(incoming);
        let selfSenderId: string | null = null;

        // ── WS event reactions ────────────────────────────────────────────────

        on((wsEvent: ServerFramePayload) => {
            if (
                wsEvent[SERVER_FRAME_PAYLOAD_VARIANT] === SERVER_FRAME_ERROR &&
                wsEvent[SERVER_FRAME_PAYLOAD_VALUE][SERVER_ERROR_REQUEST_ID]
            ) {
                chatUiObs(
                    bindArg(
                        [CHAT_UI_ERROR, wsEvent[SERVER_FRAME_PAYLOAD_VALUE][SERVER_ERROR_MESSAGE] || 'Unknown error'] as const,
                        trigger
                    )
                );
            }
        }, incoming);

        // ── chatUiObs reactions ───────────────────────────────────────────────

        chatUiObs(
            bindArg((event: ChatUiEvent) => {
                if (event[CHAT_UI_EVENT_TYPE] === CHAT_UI_JOINED) {
                    selfSenderId = event[CHAT_UI_JOINED_SENDER_ID];
                    return;
                }

                if (event[CHAT_UI_EVENT_TYPE] !== CHAT_UI_INIT) return;

                const refs = event[CHAT_UI_INIT_REFS];

                // subscribe to WS history/message/deleted now that we have refs
                on((wsEvent: ServerFramePayload) => {
                    if (wsEvent[SERVER_FRAME_PAYLOAD_VARIANT] === SERVER_FRAME_HISTORY) {
                        cleanHtml(refs[CHAT_REF_MESSAGES]);
                        wsEvent[SERVER_FRAME_PAYLOAD_VALUE][SERVER_HISTORY_ITEMS].forEach((item) => {
                            renderMessage(ctx, socket, refs[CHAT_REF_MESSAGES], item, selfSenderId);
                        });
                        return;
                    }
                    if (wsEvent[SERVER_FRAME_PAYLOAD_VARIANT] === SERVER_FRAME_MESSAGE) {
                        const item = wsEvent[SERVER_FRAME_PAYLOAD_VALUE][SERVER_MESSAGE_ITEM];
                        if (item) renderMessage(ctx, socket, refs[CHAT_REF_MESSAGES], item, selfSenderId);
                        return;
                    }
                    if (wsEvent[SERVER_FRAME_PAYLOAD_VARIANT] === SERVER_FRAME_DELETED) {
                        const target = refs[CHAT_REF_MESSAGES].querySelector(
                            `[data-message-id="${wsEvent[SERVER_FRAME_PAYLOAD_VALUE][SERVER_DELETED_MESSAGE_ID]}"]`
                        );
                        if (target) target.remove();
                    }
                }, incoming);

                refs[CHAT_REF_MESSAGES].addEventListener('click', (e: Event) => {
                    const target = e.target as HTMLElement | null;
                    if (!target) return;
                    const button = target.closest('[data-delete-id]') as HTMLElement | null;
                    if (!button) return;
                    const rawId = button.getAttribute('data-delete-id');
                    const messageId = rawId ? Number(rawId) : NaN;
                    if (!Number.isInteger(messageId) || messageId <= 0) return;
                    outgoing(
                        bindArg([CLIENT_FRAME_DELETE, [`delete-${Date.now()}`, messageId]] as const, trigger)
                    );
                });

                resolve(msgsObs);
                msgsObs(bindArg([MSGS_INIT, { socket, waitForMessageId }] as const, trigger));
            }, on)
        );
    };
