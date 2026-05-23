export const CHAT_UI_STATE_IS_JOINED        = 0 as const;
export const CHAT_UI_STATE_JOIN_IN_FLIGHT   = 1 as const;
export const CHAT_UI_STATE_IS_ONLINE        = 2 as const;

export type ChatUiState = [isJoined: boolean, joinInFlight: boolean, isOnline: boolean];
