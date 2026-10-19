import type { ObserverInstance, ReadonlyTupleOf } from '../../utils';
import type { ChatUiRefs } from './template';

// ── ChatUiEvent discriminants ─────────────────────────────────────────────────

export const CHAT_UI_INIT = 0 as const;
export const CHAT_UI_ERROR = 1 as const;
export const CHAT_UI_JOINED = 2 as const;
export const CHAT_UI_FILE_SELECTED = 3 as const;

// ── Field indices ─────────────────────────────────────────────────────────────

export const CHAT_UI_EVENT_TYPE = 0 as const;

// CHAT_UI_INIT: [type, refs]
export const CHAT_UI_INIT_REFS = 1 as const;

// CHAT_UI_ERROR: [type, message]
export const CHAT_UI_ERROR_MESSAGE = 1 as const;

// CHAT_UI_JOINED: [type, senderId]
export const CHAT_UI_JOINED_SENDER_ID = 1 as const;

// CHAT_UI_FILE_SELECTED: [type, file]
export const CHAT_UI_FILE_SELECTED_FILE = 1 as const;

// ── ChatUiEvent tuple type ────────────────────────────────────────────────────

export type ChatUiEvent =
    | ReadonlyTupleOf<{
          [CHAT_UI_EVENT_TYPE]: typeof CHAT_UI_INIT;
          [CHAT_UI_INIT_REFS]: ChatUiRefs;
      }>
    | ReadonlyTupleOf<{
          [CHAT_UI_EVENT_TYPE]: typeof CHAT_UI_ERROR;
          [CHAT_UI_ERROR_MESSAGE]: string;
      }>
    | ReadonlyTupleOf<{
          [CHAT_UI_EVENT_TYPE]: typeof CHAT_UI_JOINED;
          [CHAT_UI_JOINED_SENDER_ID]: string | null;
      }>
    | ReadonlyTupleOf<{
          [CHAT_UI_EVENT_TYPE]: typeof CHAT_UI_FILE_SELECTED;
          [CHAT_UI_FILE_SELECTED_FILE]: File;
      }>;

export type ChatUiObs = ObserverInstance<ChatUiEvent>;
