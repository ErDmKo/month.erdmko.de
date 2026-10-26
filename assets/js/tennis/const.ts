export const TEAM_LEFT = 0 as const;
export const TEAM_RIGHT = 1 as const;
export const LOG = 3 as const;
export const VOICE_ENABLED = 4 as const;
export const UPDATE_DATE = 5 as const;

export type Sides = {
    TEAM_LEFT: typeof TEAM_LEFT;
    TEAM_RIGHT: typeof TEAM_RIGHT;
};
export const LOG_TYPE = 0 as const;
export const COMMAND_TYPE = 1 as const;
export const STOP_TYPE = 2 as const;
export const START_TYPE = 3 as const;
export const BACK_TYPE = 4 as const;

export type Commands =
    | [typeof LOG_TYPE, string]
    | [typeof COMMAND_TYPE, Sides[keyof Sides]]
    | [typeof STOP_TYPE]
    | [typeof START_TYPE]
    | [typeof BACK_TYPE];

export const TEAM_LEFT_NAME = 'first';
export const TEAM_RIGHT_NAME = 'second';
export const STOP_COMMAND = 'stop';
export const BACK_COMMAND = 'back';

export const TEAM_NAMES = {
    [TEAM_LEFT]: TEAM_LEFT_NAME,
    [TEAM_RIGHT]: TEAM_RIGHT_NAME,
};

// Bracketed string keys must remain stable for speech grammar/command lookup.
export const WORDS_TO_COMMANDS: Record<string, Commands | undefined> = {
    [TEAM_NAMES[TEAM_LEFT]]: [COMMAND_TYPE, TEAM_LEFT],
    [TEAM_NAMES[TEAM_RIGHT]]: [COMMAND_TYPE, TEAM_RIGHT],
    [STOP_COMMAND]: [STOP_TYPE],
    [BACK_COMMAND]: [BACK_TYPE],
};

export const SERVE = '🏓' as const;

export type GameState = {
    [TEAM_LEFT]: number;
    [TEAM_RIGHT]: number;
    [SERVE]: Sides[keyof Sides];
    [LOG]: GameState[];
    [VOICE_ENABLED]: boolean;
    [UPDATE_DATE]: Date;
};
