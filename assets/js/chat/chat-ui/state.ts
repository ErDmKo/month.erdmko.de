import { createStore } from '../../utils';
import type { Signal, TupleOf } from '../../utils';
import type { VoiceParticipant } from '@month/gen/chat';

export const CHAT_UI_STATE_IS_JOINED = 0 as const;
export const CHAT_UI_STATE_JOIN_IN_FLIGHT = 1 as const;
export const CHAT_UI_STATE_IS_ONLINE = 2 as const;
export const CHAT_UI_STATE_STATUS = 3 as const;
export const CHAT_UI_STATE_ERROR = 4 as const;
export const CHAT_UI_STATE_NICKNAME = 5 as const;
export const CHAT_UI_STATE_MESSAGE = 6 as const;
export const CHAT_UI_STATE_UPLOAD_VISIBLE = 7 as const;
export const CHAT_UI_STATE_VOICE_IN_CALL = 8 as const;
export const CHAT_UI_STATE_VOICE_STATUS = 9 as const;
export const CHAT_UI_STATE_VOICE_MUTED = 10 as const;
export const CHAT_UI_STATE_VOICE_PARTICIPANTS = 11 as const;

export type ChatUiState = TupleOf<{
    [CHAT_UI_STATE_IS_JOINED]: Signal<boolean>;
    [CHAT_UI_STATE_JOIN_IN_FLIGHT]: Signal<boolean>;
    [CHAT_UI_STATE_IS_ONLINE]: Signal<boolean>;
    [CHAT_UI_STATE_STATUS]: Signal<string>;
    [CHAT_UI_STATE_ERROR]: Signal<string>;
    [CHAT_UI_STATE_NICKNAME]: Signal<string>;
    [CHAT_UI_STATE_MESSAGE]: Signal<string>;
    [CHAT_UI_STATE_UPLOAD_VISIBLE]: Signal<boolean>;
    [CHAT_UI_STATE_VOICE_IN_CALL]: Signal<boolean>;
    [CHAT_UI_STATE_VOICE_STATUS]: Signal<string>;
    [CHAT_UI_STATE_VOICE_MUTED]: Signal<boolean>;
    [CHAT_UI_STATE_VOICE_PARTICIPANTS]: Signal<readonly VoiceParticipant[]>;
}>;

export const createChatUiState = (nickname: string = ''): ChatUiState => [
    createStore(false),
    createStore(false),
    createStore(false),
    createStore('connecting'),
    createStore(''),
    createStore(nickname),
    createStore(''),
    createStore(false),
    createStore(false),
    createStore(''),
    createStore(false),
    createStore<readonly VoiceParticipant[]>([]),
];
