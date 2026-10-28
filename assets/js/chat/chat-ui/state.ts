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
export const CHAT_UI_STATE_WALLET_ADDRESS = 12 as const;
export const CHAT_UI_STATE_HAS_ACTIVE_ACCESS = 13 as const;
export const CHAT_UI_STATE_ACCESS_UNTIL = 14 as const;
export const CHAT_UI_STATE_AUTH_IN_FLIGHT = 15 as const;

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
    [CHAT_UI_STATE_WALLET_ADDRESS]: Signal<string>;
    [CHAT_UI_STATE_HAS_ACTIVE_ACCESS]: Signal<boolean>;
    [CHAT_UI_STATE_ACCESS_UNTIL]: Signal<number>;
    [CHAT_UI_STATE_AUTH_IN_FLIGHT]: Signal<boolean>;
}>;

export const createChatUiState = (
    nickname: string = '',
    walletAddress: string = '',
    hasActiveAccess: boolean = false,
    accessUntil: number = 0
): ChatUiState => [
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
    createStore(walletAddress),
    createStore(hasActiveAccess),
    createStore(accessUntil),
    createStore(false),
];
