import { bindArg, trigger } from '../../utils';
import type { ObserverInstance } from '../../utils';
import { CLIENT_FRAME_JOIN } from '@month/gen/chat';

export const MAX_NICKNAME_LEN = 32;
import {
    CHAT_REF_NICKNAME,
    CHAT_REF_JOIN_FORM,
    CHAT_REF_MESSAGE,
} from './template';
import type { ChatUiRefs } from './template';
import {
    CHAT_UI_STATE_IS_JOINED,
    CHAT_UI_STATE_JOIN_IN_FLIGHT,
    CHAT_UI_STATE_IS_ONLINE,
} from './state';
import type { ChatUiState } from './state';
import type { ClientFramePayload } from '@month/gen/chat';

export const mountJoinFormHandler = (
    ctx: Window,
    refs: ChatUiRefs,
    nicknameKey: string,
    outgoing: ObserverInstance<ClientFramePayload>,
    state: ChatUiState,
    setError: (msg: string) => void,
    updateControls: (messageLen: number) => void
): void => {
    const savedNickname = ctx.localStorage.getItem(nicknameKey);
    if (savedNickname && savedNickname.length <= MAX_NICKNAME_LEN) {
        refs[CHAT_REF_NICKNAME].value = savedNickname;
    }

    refs[CHAT_REF_NICKNAME].addEventListener('input', () => {
        const value = refs[CHAT_REF_NICKNAME].value.trim();
        if (value) ctx.localStorage.setItem(nicknameKey, value);
        updateControls(refs[CHAT_REF_MESSAGE].value.length);
    });

    refs[CHAT_REF_JOIN_FORM].addEventListener('submit', (e: Event) => {
        e.preventDefault();
        const nickname = refs[CHAT_REF_NICKNAME].value.trim();
        const isValidNickname =
            nickname.length > 0 && nickname.length <= MAX_NICKNAME_LEN;
        if (
            state[CHAT_UI_STATE_IS_JOINED] ||
            state[CHAT_UI_STATE_JOIN_IN_FLIGHT] ||
            !isValidNickname ||
            !state[CHAT_UI_STATE_IS_ONLINE]
        ) {
            if (!isValidNickname) {
                setError(
                    `Nickname must be between 1 and ${MAX_NICKNAME_LEN} characters.`
                );
            } else if (!state[CHAT_UI_STATE_IS_ONLINE]) {
                setError('Socket is not connected.');
            }
            return;
        }
        state[CHAT_UI_STATE_JOIN_IN_FLIGHT] = true;
        setError('');
        outgoing(
            bindArg(
                [CLIENT_FRAME_JOIN, [`join-${Date.now()}`, nickname]] as const,
                trigger
            )
        );
        updateControls(refs[CHAT_REF_MESSAGE].value.length);
    });
};
