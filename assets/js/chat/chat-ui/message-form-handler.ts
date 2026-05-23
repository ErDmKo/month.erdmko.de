import { bindArg, trigger } from '../../utils';
import type { ObserverInstance } from '../../utils';
import {
    CLIENT_FRAME_MESSAGE,
} from '../generated/chat';

export const MAX_MESSAGE_LEN = 200;
import {
    CHAT_REF_MESSAGE_FORM,
    CHAT_REF_MESSAGE,
    CHAT_REF_COUNTER,
    CHAT_REF_SEND,
    CHAT_REF_ATTACH_BUTTON,
    CHAT_REF_FILE_INPUT,
} from './template';
import type { ChatUiRefs } from './template';
import {
    CHAT_UI_ERROR,
    CHAT_UI_FILE_SELECTED,
} from './events';
import type { ChatUiObs } from './events';
import {
    CHAT_UI_STATE_IS_JOINED,
} from './state';
import type { ChatUiState } from './state';
import type { ClientFramePayload } from '../generated/chat';

export const mountMessageFormHandler = (
    refs: ChatUiRefs,
    outgoing: ObserverInstance<ClientFramePayload>,
    chatUiObs: ChatUiObs,
    state: ChatUiState
): void => {
    refs[CHAT_REF_MESSAGE].addEventListener('input', () => {
        const len = refs[CHAT_REF_MESSAGE].value.length;
        refs[CHAT_REF_COUNTER].textContent = `${len}/${MAX_MESSAGE_LEN}`;
        refs[CHAT_REF_SEND].disabled = !state[CHAT_UI_STATE_IS_JOINED] || len === 0 || len > MAX_MESSAGE_LEN;
    });

    refs[CHAT_REF_MESSAGE].addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            refs[CHAT_REF_MESSAGE_FORM].requestSubmit();
        }
    });

    refs[CHAT_REF_MESSAGE_FORM].addEventListener('submit', (e: Event) => {
        e.preventDefault();
        const body = refs[CHAT_REF_MESSAGE].value.trim();
        if (body.length === 0 || body.length > MAX_MESSAGE_LEN) {
            chatUiObs(
                bindArg(
                    [CHAT_UI_ERROR, `Message must be between 1 and ${MAX_MESSAGE_LEN} characters.`] as const,
                    trigger
                )
            );
            return;
        }
        const msgRequestId = `msg-${Date.now()}`;
        outgoing(bindArg([CLIENT_FRAME_MESSAGE, [msgRequestId, body]] as const, trigger));
        refs[CHAT_REF_MESSAGE].value = '';
        refs[CHAT_REF_COUNTER].textContent = `0/${MAX_MESSAGE_LEN}`;
        refs[CHAT_REF_SEND].disabled = true;
    });

    refs[CHAT_REF_ATTACH_BUTTON].addEventListener('click', () => {
        refs[CHAT_REF_FILE_INPUT].click();
    });

    refs[CHAT_REF_FILE_INPUT].addEventListener('change', () => {
        const file = refs[CHAT_REF_FILE_INPUT].files?.[0] ?? null;
        if (!file) return;
        chatUiObs(
            bindArg([CHAT_UI_FILE_SELECTED, file] as const, trigger)
        );
    });
};
