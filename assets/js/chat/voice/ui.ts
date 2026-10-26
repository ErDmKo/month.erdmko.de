import { SIGNAL_SET } from '../../utils';
import {
    CHAT_UI_STATE_VOICE_IN_CALL,
    CHAT_UI_STATE_VOICE_STATUS,
    CHAT_UI_STATE_VOICE_MUTED,
    CHAT_UI_STATE_VOICE_PARTICIPANTS,
} from '../chat-ui/state';
import type { ChatUiState } from '../chat-ui/state';
import type { VoiceParticipant } from '@month/gen/chat';

export const setInCall = (state: ChatUiState, inCall: boolean): void => {
    state[CHAT_UI_STATE_VOICE_IN_CALL][SIGNAL_SET](inCall);
};

export const setStatus = (state: ChatUiState, text: string): void => {
    state[CHAT_UI_STATE_VOICE_STATUS][SIGNAL_SET](text);
};

export const setMuteLabel = (state: ChatUiState, muted: boolean): void => {
    state[CHAT_UI_STATE_VOICE_MUTED][SIGNAL_SET](muted);
};

export const renderParticipants = (
    state: ChatUiState,
    participants: readonly VoiceParticipant[]
): void => {
    state[CHAT_UI_STATE_VOICE_PARTICIPANTS][SIGNAL_SET](participants);
};

export const resetVoiceUi = (state: ChatUiState): void => {
    setInCall(state, false);
    setStatus(state, '');
    setMuteLabel(state, false);
    renderParticipants(state, []);
};
