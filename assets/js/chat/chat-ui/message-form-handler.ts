import { bindArg, SIGNAL_GET, SIGNAL_SET, trigger } from '../../utils';
import type { ObserverInstance } from '../../utils';
import { CLIENT_FRAME_MESSAGE } from '@month/gen/chat';
import type { ClientFramePayload } from '@month/gen/chat';
import { CHAT_UI_ERROR, CHAT_UI_FILE_SELECTED } from './events';
import type { ChatUiObs } from './events';
import { CHAT_UI_STATE_MESSAGE } from './state';
import type { ChatUiState } from './state';

export const MAX_MESSAGE_LEN = 200;

export const handleMessageInput = (state: ChatUiState, event: Event): void => {
    state[CHAT_UI_STATE_MESSAGE][SIGNAL_SET](
        (event.currentTarget as HTMLTextAreaElement).value
    );
};

export const handleMessageKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        (event.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
    }
};

export const handleMessageSubmit = (
    ctx: Window,
    outgoing: ObserverInstance<ClientFramePayload>,
    chatUiObs: ChatUiObs,
    state: ChatUiState,
    event: Event
): void => {
    event.preventDefault();
    const body = state[CHAT_UI_STATE_MESSAGE][SIGNAL_GET]().trim();
    if (body.length === 0 || body.length > MAX_MESSAGE_LEN) {
        chatUiObs(
            bindArg(
                [
                    CHAT_UI_ERROR,
                    `Message must be between 1 and ${MAX_MESSAGE_LEN} characters.`,
                ] as const,
                trigger
            )
        );
        return;
    }
    outgoing(
        bindArg(
            [CLIENT_FRAME_MESSAGE, [`msg-${ctx.Date.now()}`, body]] as const,
            trigger
        )
    );
    state[CHAT_UI_STATE_MESSAGE][SIGNAL_SET]('');
};

export const handleFileSelected = (
    chatUiObs: ChatUiObs,
    event: Event
): void => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (file)
        chatUiObs(bindArg([CHAT_UI_FILE_SELECTED, file] as const, trigger));
};
