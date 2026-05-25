import {
    bindArg,
    noop,
    observer,
    trigger,
    pipe,
    taskChain,
    taskFork,
} from '@month/utils';
import type { ObserverState } from '@month/utils';
import type { ChatSocket } from './protocol/incoming';
import type { ServerFramePayload, ClientFramePayload } from '@month/gen/chat';
import { initChatUi, CHAT_UI_ERROR } from './chat-ui/init';
import type { ChatUiObs } from './chat-ui/events';
import { initMessages } from './messages/init';
import type { MsgsObs } from './messages/handler';
import { initAttachments } from './attachments/init';

declare global {
    interface Window {
        WebSocket: typeof WebSocket;
        JSON: typeof JSON;
        FileReader: typeof FileReader;
        Uint8Array: typeof Uint8Array;
    }
}

const initTemplate = (ctx: Window, root: Element) => {
    const incoming: ObserverState<ServerFramePayload> = [];
    const outgoing = observer<ClientFramePayload>();
    const socket: ChatSocket = [outgoing, incoming];

    pipe(
        initChatUi(ctx, root, socket),
        taskFork(
            (chatUiObs: ChatUiObs) =>
                pipe(
                    initMessages(ctx, socket, chatUiObs),
                    taskChain((msgsObs: MsgsObs) =>
                        initAttachments(ctx, socket, chatUiObs, msgsObs)
                    ),
                    taskFork(noop, (err) =>
                        chatUiObs(
                            bindArg(
                                [CHAT_UI_ERROR, String(err)] as const,
                                trigger
                            )
                        )
                    )
                ),
            (err) => {
                throw err;
            }
        )
    );
};

export const initChatEffect = (ctx: Window) => {
    const tags = ctx.document.querySelectorAll('.js-chat');
    ctx.Array.from(tags).forEach((el) => initTemplate(ctx, el));
};
