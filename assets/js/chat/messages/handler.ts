import {
    domCreatorRef,
    ObserverInstance,
    on,
    off,
    Task,
} from '../../utils';
import type { ObserverState } from '../../utils';
import {
    SERVER_FRAME_MESSAGE,
    SERVER_FRAME_PAYLOAD_VARIANT,
    SERVER_FRAME_PAYLOAD_VALUE,
    SERVER_MESSAGE_ITEM,
    SERVER_MESSAGE_REQUEST_ID,
} from '../generated/chat';
import type { BaseChatSocket } from '../protocol/incoming';
import type { ServerFramePayload } from '../generated/chat';
import {
    CHAT_ITEM_ID,
    CHAT_ITEM_SENDER_ID,
    CHAT_ITEM_SENDER_NAME,
    CHAT_ITEM_BODY,
    CHAT_ITEM_CREATED_AT,
    CHAT_ITEM_ATTACHMENTS,
} from '../generated/chat';
import type { ChatItem } from '../generated/chat';
import { chatMessageTemplate, MESSAGE_REF_ATTACHMENTS, MessageRefs } from './template';
import { renderAttachment } from '../attachments/handler';

// ── MsgsEvent tuple ───────────────────────────────────────────────────────────

export const MSGS_INIT = 0 as const;
export const MSGS_EVENT_TYPE = 0 as const;
export const MSGS_INIT_PAYLOAD = 1 as const;

export type MsgsInitPayload = {
    socket: BaseChatSocket;
    waitForMessageId: (requestId: string) => Task<number>;
};

export type MsgsEvent =
    | readonly [type: typeof MSGS_INIT, payload: MsgsInitPayload];

export type MsgsObs = ObserverInstance<MsgsEvent>;

// ── renderMessage ─────────────────────────────────────────────────────────────

export const renderMessage = (
    ctx: Window,
    socket: BaseChatSocket,
    list: HTMLUListElement,
    item: ChatItem,
    selfSenderId: string | null
): void => {
    const attachments = item[CHAT_ITEM_ATTACHMENTS] ?? [];
    const senderId = item[CHAT_ITEM_SENDER_ID];
    const isOwn = !!(selfSenderId && senderId && senderId === selfSenderId);
    const msgRefs = domCreatorRef(
        ctx,
        list,
        chatMessageTemplate(
            item[CHAT_ITEM_ID],
            item[CHAT_ITEM_SENDER_NAME],
            item[CHAT_ITEM_BODY],
            attachments,
            item[CHAT_ITEM_CREATED_AT],
            isOwn
        )
    ) as unknown as MessageRefs;

    if (attachments.length > 0) {
        const ulEl = msgRefs[MESSAGE_REF_ATTACHMENTS];
        attachments.forEach((a) => renderAttachment(ctx, socket, ulEl, a));
    }

    list.scrollTop = list.scrollHeight;
};

// ── makeWaitForMessageId ──────────────────────────────────────────────────────

export const makeWaitForMessageId =
    (wsEventState: ObserverState<ServerFramePayload>) =>
    (requestId: string): Task<number> =>
    (resolve) => {
        const handler = (event: ServerFramePayload) => {
            if (
                event[SERVER_FRAME_PAYLOAD_VARIANT] === SERVER_FRAME_MESSAGE &&
                event[SERVER_FRAME_PAYLOAD_VALUE][SERVER_MESSAGE_REQUEST_ID] === requestId
            ) {
                off(handler, wsEventState);
                resolve(event[SERVER_FRAME_PAYLOAD_VALUE][SERVER_MESSAGE_ITEM]![CHAT_ITEM_ID]);
            }
        };
        on(handler, wsEventState);
    };
