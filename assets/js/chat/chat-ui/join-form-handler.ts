import { bindArg, SIGNAL_GET, SIGNAL_SET, trigger } from '../../utils';
import type { ObserverInstance } from '../../utils';
import { CLIENT_FRAME_JOIN } from '@month/gen/chat';
import type { ClientFramePayload } from '@month/gen/chat';
import {
    CHAT_UI_STATE_ERROR,
    CHAT_UI_STATE_IS_JOINED,
    CHAT_UI_STATE_JOIN_IN_FLIGHT,
    CHAT_UI_STATE_IS_ONLINE,
    CHAT_UI_STATE_NICKNAME,
} from './state';
import type { ChatUiState } from './state';

export const MAX_NICKNAME_LEN = 32;

export const isValidNickname = (nickname: string): boolean => {
    const len = nickname.trim().length;
    return len > 0 && len <= MAX_NICKNAME_LEN;
};

export const handleNicknameInput = (
    ctx: Window,
    nicknameKey: string,
    state: ChatUiState,
    event: Event
): void => {
    const value = (event.currentTarget as HTMLInputElement).value;
    state[CHAT_UI_STATE_NICKNAME][SIGNAL_SET](value);
    if (value.trim()) ctx.localStorage.setItem(nicknameKey, value.trim());
};

export const handleJoinSubmit = (
    ctx: Window,
    outgoing: ObserverInstance<ClientFramePayload>,
    state: ChatUiState,
    event: Event
): void => {
    event.preventDefault();
    const nickname = state[CHAT_UI_STATE_NICKNAME][SIGNAL_GET]().trim();
    const isValid = isValidNickname(nickname);
    if (
        state[CHAT_UI_STATE_IS_JOINED][SIGNAL_GET]() ||
        state[CHAT_UI_STATE_JOIN_IN_FLIGHT][SIGNAL_GET]() ||
        !isValid ||
        !state[CHAT_UI_STATE_IS_ONLINE][SIGNAL_GET]()
    ) {
        if (!isValid) {
            state[CHAT_UI_STATE_ERROR][SIGNAL_SET](
                `Nickname must be between 1 and ${MAX_NICKNAME_LEN} characters.`
            );
        } else if (!state[CHAT_UI_STATE_IS_ONLINE][SIGNAL_GET]()) {
            state[CHAT_UI_STATE_ERROR][SIGNAL_SET]('Socket is not connected.');
        }
        return;
    }
    state[CHAT_UI_STATE_JOIN_IN_FLIGHT][SIGNAL_SET](true);
    state[CHAT_UI_STATE_ERROR][SIGNAL_SET]('');
    outgoing(
        bindArg(
            [CLIENT_FRAME_JOIN, [`join-${ctx.Date.now()}`, nickname]] as const,
            trigger
        )
    );
};
