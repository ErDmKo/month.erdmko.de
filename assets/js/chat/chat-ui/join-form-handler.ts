import {
    bindArg,
    isString,
    nullable,
    objectStruct,
    pipe,
    SIGNAL_GET,
    SIGNAL_SET,
    taskFork,
    trigger,
    trim,
    validate,
} from '../../utils';
import type { ObserverInstance } from '../../utils';
import { CLIENT_FRAME_JOIN } from '@month/gen/chat';
import type { ClientFramePayload } from '@month/gen/chat';
import {
    connectAndSignInTask,
    payAndClaimTask,
    SESSION_STATUS_ACCESS_UNTIL,
    SESSION_STATUS_HAS_ACTIVE_ACCESS,
    SESSION_STATUS_NICKNAME,
    SESSION_STATUS_WALLET,
} from '../auth';
import type { SessionStatus } from '../auth';
import { CHAT_UI_AUTH_VERIFIED } from './events';
import type { ChatUiObs } from './events';
import {
    CHAT_UI_STATE_ACCESS_UNTIL,
    CHAT_UI_STATE_AUTH_IN_FLIGHT,
    CHAT_UI_STATE_ERROR,
    CHAT_UI_STATE_HAS_ACTIVE_ACCESS,
    CHAT_UI_STATE_IS_JOINED,
    CHAT_UI_STATE_IS_ONLINE,
    CHAT_UI_STATE_JOIN_IN_FLIGHT,
    CHAT_UI_STATE_NICKNAME,
    CHAT_UI_STATE_WALLET_ADDRESS,
} from './state';
import type { ChatUiState } from './state';

export const MAX_NICKNAME_LEN = 32;
const ASCII_NICKNAME_RE = /^[a-z0-9_-]{1,32}$/;

export const isValidNickname = (nickname: string): boolean =>
    ASCII_NICKNAME_RE.test(nickname.trim());

export const getNicknameValidationError = (nickname: string): string => {
    const trimmed = nickname.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_NICKNAME_LEN) {
        return `Nickname must be between 1 and ${MAX_NICKNAME_LEN} lowercase ASCII characters (a-z, 0-9, _, -).`;
    }
    if (/[A-Z]/.test(trimmed)) {
        return 'Nickname must be lowercase only (a-z, 0-9, _, -).';
    }
    if (!ASCII_NICKNAME_RE.test(trimmed)) {
        return 'Nickname may only contain lowercase ASCII letters (a-z), digits (0-9), _, or -.';
    }
    return '';
};

export const applySessionStatusToState = (
    ctx: Window,
    nicknameKey: string,
    status: SessionStatus,
    state: ChatUiState
): void => {
    state[CHAT_UI_STATE_WALLET_ADDRESS][SIGNAL_SET](
        status[SESSION_STATUS_WALLET]
    );
    state[CHAT_UI_STATE_HAS_ACTIVE_ACCESS][SIGNAL_SET](
        status[SESSION_STATUS_HAS_ACTIVE_ACCESS]
    );
    state[CHAT_UI_STATE_ACCESS_UNTIL][SIGNAL_SET](
        status[SESSION_STATUS_ACCESS_UNTIL]
    );
    const serverNickname = status[SESSION_STATUS_NICKNAME];
    if (serverNickname) {
        state[CHAT_UI_STATE_NICKNAME][SIGNAL_SET](serverNickname);
        ctx.localStorage.setItem(nicknameKey, serverNickname);
    }
};

const ERR_MESSAGE = 0 as const;
const ERR_REASON = 1 as const;
const ERR_DATA = 2 as const;
const ERR_DATA_MESSAGE = 0 as const;

const errorObjectStruct = objectStruct(
    ['message', isString, trim, nullable],
    ['reason', isString, trim, nullable],
    ['data', objectStruct(['message', isString, trim]), nullable]
);

export const formatAuthError = (ctx: Window, err: unknown): string => {
    const direct = validate(err, isString, trim);
    if (direct) return direct;
    const parsed = validate(err, errorObjectStruct);
    if (parsed) {
        const data = parsed[ERR_DATA];
        const msg =
            parsed[ERR_MESSAGE] ??
            parsed[ERR_REASON] ??
            (data ? data[ERR_DATA_MESSAGE] : null);
        if (msg) return msg;
        try {
            return ctx.JSON.stringify(err);
        } catch {
            return 'Wallet request failed.';
        }
    }
    return String(err);
};

export const handleNicknameInput = (
    ctx: Window,
    nicknameKey: string,
    state: ChatUiState,
    event: Event
): void => {
    const value = (event.currentTarget as HTMLInputElement).value;
    state[CHAT_UI_STATE_NICKNAME][SIGNAL_SET](value);
    const trimmed = value.trim();
    if (!trimmed) {
        state[CHAT_UI_STATE_ERROR][SIGNAL_SET]('');
        return;
    }
    const validationError = getNicknameValidationError(trimmed);
    state[CHAT_UI_STATE_ERROR][SIGNAL_SET](validationError);
    if (!validationError) {
        ctx.localStorage.setItem(nicknameKey, trimmed);
    }
};

export const handleConnectWallet = (
    ctx: Window,
    nicknameKey: string,
    chatUiObs: ChatUiObs,
    state: ChatUiState
): void => {
    if (state[CHAT_UI_STATE_AUTH_IN_FLIGHT][SIGNAL_GET]()) return;
    state[CHAT_UI_STATE_AUTH_IN_FLIGHT][SIGNAL_SET](true);
    state[CHAT_UI_STATE_ERROR][SIGNAL_SET]('');

    pipe(
        connectAndSignInTask(ctx),
        taskFork(
            (status: SessionStatus) => {
                state[CHAT_UI_STATE_AUTH_IN_FLIGHT][SIGNAL_SET](false);
                applySessionStatusToState(ctx, nicknameKey, status, state);
                chatUiObs(
                    bindArg(
                        [
                            CHAT_UI_AUTH_VERIFIED,
                            status[SESSION_STATUS_WALLET],
                        ] as const,
                        trigger
                    )
                );
            },
            (err: unknown) => {
                state[CHAT_UI_STATE_AUTH_IN_FLIGHT][SIGNAL_SET](false);
                state[CHAT_UI_STATE_ERROR][SIGNAL_SET](
                    formatAuthError(ctx, err)
                );
            }
        )
    );
};

export const handlePayAndUnlock = (
    ctx: Window,
    nicknameKey: string,
    state: ChatUiState
): void => {
    if (state[CHAT_UI_STATE_AUTH_IN_FLIGHT][SIGNAL_GET]()) return;
    const walletAddress = state[CHAT_UI_STATE_WALLET_ADDRESS][SIGNAL_GET]();
    if (!walletAddress) {
        state[CHAT_UI_STATE_ERROR][SIGNAL_SET](
            'Connect your wallet before paying.'
        );
        return;
    }
    const nickname = state[CHAT_UI_STATE_NICKNAME][SIGNAL_GET]().trim();
    const nicknameError = getNicknameValidationError(nickname);
    if (nicknameError) {
        state[CHAT_UI_STATE_ERROR][SIGNAL_SET](nicknameError);
        return;
    }
    state[CHAT_UI_STATE_AUTH_IN_FLIGHT][SIGNAL_SET](true);
    state[CHAT_UI_STATE_ERROR][SIGNAL_SET]('');

    pipe(
        payAndClaimTask(ctx, walletAddress, nickname),
        taskFork(
            (status: SessionStatus) => {
                state[CHAT_UI_STATE_AUTH_IN_FLIGHT][SIGNAL_SET](false);
                applySessionStatusToState(ctx, nicknameKey, status, state);
            },
            (err: unknown) => {
                state[CHAT_UI_STATE_AUTH_IN_FLIGHT][SIGNAL_SET](false);
                state[CHAT_UI_STATE_ERROR][SIGNAL_SET](
                    formatAuthError(ctx, err)
                );
            }
        )
    );
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
    const hasWallet = Boolean(
        state[CHAT_UI_STATE_WALLET_ADDRESS][SIGNAL_GET]()
    );
    const hasAccess = state[CHAT_UI_STATE_HAS_ACTIVE_ACCESS][SIGNAL_GET]();
    if (
        state[CHAT_UI_STATE_IS_JOINED][SIGNAL_GET]() ||
        state[CHAT_UI_STATE_JOIN_IN_FLIGHT][SIGNAL_GET]() ||
        !isValid ||
        !hasWallet ||
        !hasAccess ||
        !state[CHAT_UI_STATE_IS_ONLINE][SIGNAL_GET]()
    ) {
        if (!isValid) {
            state[CHAT_UI_STATE_ERROR][SIGNAL_SET](
                getNicknameValidationError(nickname)
            );
        } else if (!hasWallet) {
            state[CHAT_UI_STATE_ERROR][SIGNAL_SET](
                'Connect your wallet before joining.'
            );
        } else if (!hasAccess) {
            state[CHAT_UI_STATE_ERROR][SIGNAL_SET](
                'Paid access is required to join the room.'
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
