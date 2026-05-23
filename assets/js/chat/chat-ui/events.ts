import type { ObserverInstance } from '../../utils';
import type { ChatUiRefs } from './template';

// ── ChatUiEvent discriminants ─────────────────────────────────────────────────

export const CHAT_UI_INIT          = 0 as const;
export const CHAT_UI_ERROR         = 1 as const;
export const CHAT_UI_JOINED        = 2 as const;
export const CHAT_UI_FILE_SELECTED = 3 as const;

// ── Field indices ─────────────────────────────────────────────────────────────

export const CHAT_UI_EVENT_TYPE         = 0 as const;

// CHAT_UI_INIT: [type, refs]
export const CHAT_UI_INIT_REFS          = 1 as const;

// CHAT_UI_ERROR: [type, message]
export const CHAT_UI_ERROR_MESSAGE      = 1 as const;

// CHAT_UI_JOINED: [type, senderId]
export const CHAT_UI_JOINED_SENDER_ID   = 1 as const;

// CHAT_UI_FILE_SELECTED: [type, file]
export const CHAT_UI_FILE_SELECTED_FILE = 1 as const;

// ── ChatUiEvent tuple type ────────────────────────────────────────────────────

export type ChatUiEvent =
    | readonly [type: typeof CHAT_UI_INIT,          refs: ChatUiRefs]
    | readonly [type: typeof CHAT_UI_ERROR,          message: string]
    | readonly [type: typeof CHAT_UI_JOINED,         senderId: string | null]
    | readonly [type: typeof CHAT_UI_FILE_SELECTED,  file: File];

export type ChatUiObs = ObserverInstance<ChatUiEvent>;
