import {
    bindArg,
    bindArgs,
    cleanHtml,
    combineSignals,
    createStore,
    domCreator,
    genAttr,
    genClass,
    genOn,
    genProp,
    genTagName,
    isFunction,
    mapSignal,
    noop,
    objectStruct,
    observer,
    on,
    pipe,
    SIGNAL_GET,
    SIGNAL_OBS,
    SIGNAL_SET,
    taskFork,
    validate,
} from '@month/utils';
import type { Signal, TupleOf } from '@month/utils';
import {
    $chat__meta,
    $chat__form,
    $chat__label,
    $chat__input,
    $chat__controls,
    $chat__button,
    $chat__counter,
    $chat__upload_preview_item,
} from '@month/gen/styles';
import {
    fetchSessionTask,
    SESSION_STATUS_HAS_ACTIVE_ACCESS,
    SESSION_STATUS_NICKNAME,
    updateNicknameTask,
} from '../auth';
import type { SessionStatus } from '../auth';
import { CHAT_UI_AUTH_VERIFIED, CHAT_UI_EVENT_TYPE } from './events';
import type { ChatUiEvent, ChatUiObs } from './events';
import {
    applySessionStatusToState,
    formatAuthError,
    getNicknameValidationError,
    handleConnectWallet,
    handleNicknameInput,
    handlePayAndUnlock,
    isValidNickname,
    MAX_NICKNAME_LEN,
} from './join-form-handler';
import {
    CHAT_UI_STATE_ACCESS_UNTIL,
    CHAT_UI_STATE_AUTH_IN_FLIGHT,
    CHAT_UI_STATE_ERROR,
    CHAT_UI_STATE_HAS_ACTIVE_ACCESS,
    CHAT_UI_STATE_NICKNAME,
    CHAT_UI_STATE_PENDING_TX_HASH,
    CHAT_UI_STATE_WALLET_ADDRESS,
    createChatUiState,
} from './state';
import type { ChatUiState } from './state';

export const GLOBAL_NICKNAME_KEY = 'chat-nickname';
const MAX_ROOM_SLUG_LEN = 64;
const ROOM_SLUG_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export const ONBOARDING_CHAT_STATE = 0 as const;
export const ONBOARDING_ROOM_SLUG = 1 as const;
export const ONBOARDING_TARGET_ROOM = 2 as const;

export type OnboardingState = TupleOf<{
    [ONBOARDING_CHAT_STATE]: ChatUiState;
    [ONBOARDING_ROOM_SLUG]: Signal<string>;
    [ONBOARDING_TARGET_ROOM]: string;
}>;

const WIN_LOCATION = 0 as const;
const LOC_ASSIGN = 0 as const;

const windowLocationAssignStruct = objectStruct([
    'location',
    objectStruct(['assign', isFunction<(url: string) => void>]),
]);

export const navigateToUrl = (ctx: Window, url: string): void => {
    const loc = validate(ctx, windowLocationAssignStruct);
    if (loc) {
        loc[WIN_LOCATION][LOC_ASSIGN](url);
        return;
    }
    if (ctx.location) {
        ctx.location.href = url;
    }
};

export const sanitizeRoomSlug = (raw: string): string => {
    const trimmed = raw.trim().replace(/\s+/g, '-');
    const cleaned = trimmed
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, MAX_ROOM_SLUG_LEN);
    return cleaned.replace(/^-+|-+$/g, '');
};

export const isValidRoomSlug = (slug: string): boolean =>
    ROOM_SLUG_RE.test(slug.trim());

const not = (value: boolean): boolean => !value;

export const handleRoomSlugInput = (
    onboardingState: OnboardingState,
    event: Event
): void => {
    const value = (event.currentTarget as HTMLInputElement).value;
    onboardingState[ONBOARDING_ROOM_SLUG][SIGNAL_SET](value);
    const chatState = onboardingState[ONBOARDING_CHAT_STATE];
    const slug = sanitizeRoomSlug(value);
    if (!slug) {
        chatState[CHAT_UI_STATE_ERROR][SIGNAL_SET](
            'Room name is required (letters, numbers, -, _).'
        );
        return;
    }
    chatState[CHAT_UI_STATE_ERROR][SIGNAL_SET]('');
};

export const handleOnboardingPayAndUnlock = (
    ctx: Window,
    onboardingState: OnboardingState
): void => {
    const chatState = onboardingState[ONBOARDING_CHAT_STATE];
    handlePayAndUnlock(ctx, GLOBAL_NICKNAME_KEY, chatState);
};

export const handleOnboardingSubmit = (
    ctx: Window,
    onboardingState: OnboardingState,
    event: Event
): void => {
    event.preventDefault();
    const chatState = onboardingState[ONBOARDING_CHAT_STATE];
    if (chatState[CHAT_UI_STATE_AUTH_IN_FLIGHT][SIGNAL_GET]()) return;

    const wallet = chatState[CHAT_UI_STATE_WALLET_ADDRESS][SIGNAL_GET]();
    if (!wallet) {
        chatState[CHAT_UI_STATE_ERROR][SIGNAL_SET](
            'Connect your wallet before entering a room.'
        );
        return;
    }
    if (!chatState[CHAT_UI_STATE_HAS_ACTIVE_ACCESS][SIGNAL_GET]()) {
        chatState[CHAT_UI_STATE_ERROR][SIGNAL_SET](
            'Unlock chat access before entering a room.'
        );
        return;
    }
    const nickname = chatState[CHAT_UI_STATE_NICKNAME][SIGNAL_GET]().trim();
    const nickError = getNicknameValidationError(nickname);
    if (nickError) {
        chatState[CHAT_UI_STATE_ERROR][SIGNAL_SET](nickError);
        return;
    }
    const roomSlug = sanitizeRoomSlug(
        onboardingState[ONBOARDING_ROOM_SLUG][SIGNAL_GET]()
    );
    if (!roomSlug) {
        chatState[CHAT_UI_STATE_ERROR][SIGNAL_SET](
            'Room name is required (letters, numbers, -, _).'
        );
        return;
    }

    chatState[CHAT_UI_STATE_AUTH_IN_FLIGHT][SIGNAL_SET](true);
    chatState[CHAT_UI_STATE_ERROR][SIGNAL_SET]('');
    ctx.localStorage.setItem(GLOBAL_NICKNAME_KEY, nickname);
    ctx.localStorage.setItem(`chat-nickname-${roomSlug}`, nickname);

    pipe(
        updateNicknameTask(ctx, nickname),
        taskFork(
            (status: SessionStatus) => {
                chatState[CHAT_UI_STATE_AUTH_IN_FLIGHT][SIGNAL_SET](false);
                applySessionStatusToState(
                    ctx,
                    GLOBAL_NICKNAME_KEY,
                    status,
                    chatState
                );
                navigateToUrl(ctx, `/chat/${encodeURIComponent(roomSlug)}`);
            },
            (err: unknown) => {
                chatState[CHAT_UI_STATE_AUTH_IN_FLIGHT][SIGNAL_SET](false);
                chatState[CHAT_UI_STATE_ERROR][SIGNAL_SET](
                    formatAuthError(ctx, err)
                );
            }
        )
    );
};

export const onboardingTemplate = (
    ctx: Window,
    chatUiObs: ChatUiObs,
    onboardingState: OnboardingState
) => {
    const state = onboardingState[ONBOARDING_CHAT_STATE];
    const roomSig = onboardingState[ONBOARDING_ROOM_SLUG];
    const targetRoom = onboardingState[ONBOARDING_TARGET_ROOM];

    const walletConnected = mapSignal(
        (wallet: string) => wallet.length > 0,
        state[CHAT_UI_STATE_WALLET_ADDRESS]
    );
    const walletDisconnected = mapSignal(not, walletConnected);
    const payHidden = mapSignal(
        ([connected, paid]: [boolean, boolean]) => !connected || paid,
        combineSignals(walletConnected, state[CHAT_UI_STATE_HAS_ACTIVE_ACCESS])
    );
    const payDisabled = mapSignal(
        ([authInFlight, nickname]: [boolean, string]) =>
            authInFlight || !isValidNickname(nickname),
        combineSignals(
            state[CHAT_UI_STATE_AUTH_IN_FLIGHT],
            state[CHAT_UI_STATE_NICKNAME]
        )
    );
    const joinHidden = mapSignal(not, state[CHAT_UI_STATE_HAS_ACTIVE_ACCESS]);
    const pendingTxHidden = mapSignal(
        ([pendingTx, hasAccess]: [string, boolean]) =>
            hasAccess || pendingTx.length === 0,
        combineSignals(
            state[CHAT_UI_STATE_PENDING_TX_HASH],
            state[CHAT_UI_STATE_HAS_ACTIVE_ACCESS]
        )
    );
    const pendingTxHref = mapSignal(
        (pendingTx: string) =>
            pendingTx ? `https://etherscan.io/tx/${pendingTx}` : '#',
        state[CHAT_UI_STATE_PENDING_TX_HASH]
    );
    const authBannerText = mapSignal(
        ([[connected, hasAccess], pendingTx]: [[boolean, boolean], string]) => {
            if (hasAccess) {
                return targetRoom
                    ? `Authorized — ready to enter #${targetRoom}.`
                    : 'Authorized — enter any room name below or pick a public room.';
            }
            if (!connected) {
                return targetRoom
                    ? `Authorization required to join #${targetRoom} — connect your Ethereum wallet below to continue.`
                    : 'Authorization required — connect your Ethereum wallet (SIWE) and unlock access to join chat rooms.';
            }
            if (pendingTx) {
                return `Pending payment (${pendingTx.slice(0, 10)}...) — waiting for onchain confirmation or click Pay & Unlock Chat to retry without sending a second transfer.`;
            }
            return targetRoom
                ? `Paid access required to join #${targetRoom} — choose your nickname and unlock chat access below to continue.`
                : 'Paid access required — choose your nickname and unlock chat access below to join chat rooms.';
        },
        combineSignals(
            combineSignals(
                walletConnected,
                state[CHAT_UI_STATE_HAS_ACTIVE_ACCESS]
            ),
            state[CHAT_UI_STATE_PENDING_TX_HASH]
        )
    );
    const bannerText = mapSignal(
        ([error, notice]: [string, string]) =>
            error ? `Error: ${error}` : notice,
        combineSignals(state[CHAT_UI_STATE_ERROR], authBannerText)
    );
    const bannerState = mapSignal(
        (error: string) => (error ? 'error' : 'info'),
        state[CHAT_UI_STATE_ERROR]
    );
    const joinDisabled = mapSignal(
        ([[authInFlight, hasAccess], [nickname, room]]: [
            [boolean, boolean],
            [string, string],
        ]) =>
            authInFlight ||
            !hasAccess ||
            !isValidNickname(nickname) ||
            sanitizeRoomSlug(room).length === 0,
        combineSignals(
            combineSignals(
                state[CHAT_UI_STATE_AUTH_IN_FLIGHT],
                state[CHAT_UI_STATE_HAS_ACTIVE_ACCESS]
            ),
            combineSignals(state[CHAT_UI_STATE_NICKNAME], roomSig)
        )
    );
    const accessUntilText = mapSignal(
        (accessUntil: number) =>
            accessUntil > 0
                ? ` (active until ${new ctx.Date(accessUntil * 1000).toISOString().slice(0, 10)})`
                : '',
        state[CHAT_UI_STATE_ACCESS_UNTIL]
    );

    return genTagName(
        'div',
        [],
        [
            genTagName(
                'div',
                [
                    genClass([$chat__meta, $chat__upload_preview_item]),
                    genAttr('role', 'status'),
                    genAttr('aria-atomic', 'true'),
                    genAttr('data-state', bannerState),
                ],
                [genTagName('strong', [], [bannerText])]
            ),
            genTagName(
                'div',
                [genClass($chat__meta)],
                [
                    genTagName(
                        'div',
                        [genProp('hidden', walletConnected)],
                        [
                            genTagName(
                                'button',
                                [
                                    genClass($chat__button),
                                    genAttr('type', 'button'),
                                    genProp(
                                        'disabled',
                                        state[CHAT_UI_STATE_AUTH_IN_FLIGHT]
                                    ),
                                    genOn(
                                        'click',
                                        bindArgs(
                                            [
                                                ctx,
                                                GLOBAL_NICKNAME_KEY,
                                                chatUiObs,
                                                state,
                                            ],
                                            handleConnectWallet
                                        )
                                    ),
                                ],
                                ['Connect Wallet']
                            ),
                        ]
                    ),
                    genTagName(
                        'div',
                        [genProp('hidden', walletDisconnected)],
                        [
                            genTagName(
                                'span',
                                [],
                                [
                                    'Wallet: ',
                                    state[CHAT_UI_STATE_WALLET_ADDRESS],
                                ]
                            ),
                            genTagName(
                                'span',
                                [genProp('hidden', joinHidden)],
                                [accessUntilText]
                            ),
                            genTagName(
                                'span',
                                [genProp('hidden', pendingTxHidden)],
                                [
                                    ' · Pending tx: ',
                                    genTagName(
                                        'a',
                                        [
                                            genAttr('href', pendingTxHref),
                                            genAttr('target', '_blank'),
                                            genAttr(
                                                'rel',
                                                'noopener noreferrer'
                                            ),
                                        ],
                                        [state[CHAT_UI_STATE_PENDING_TX_HASH]]
                                    ),
                                ]
                            ),
                        ]
                    ),
                ]
            ),
            genTagName(
                'form',
                [
                    genClass($chat__form),
                    genProp('hidden', walletDisconnected),
                    genOn(
                        'submit',
                        bindArgs([ctx, onboardingState], handleOnboardingSubmit)
                    ),
                ],
                [
                    genTagName(
                        'label',
                        [genClass($chat__label)],
                        [
                            genTagName('span', [], ['Nickname']),
                            genTagName('input', [
                                genClass($chat__input),
                                genProp('value', state[CHAT_UI_STATE_NICKNAME]),
                                genOn(
                                    'input',
                                    bindArgs(
                                        [ctx, GLOBAL_NICKNAME_KEY, state],
                                        handleNicknameInput
                                    )
                                ),
                                genAttr('type', 'text'),
                                genAttr('maxlength', MAX_NICKNAME_LEN),
                                genAttr('placeholder', 'guest'),
                                genAttr('required', 'required'),
                            ]),
                        ]
                    ),
                    genTagName(
                        'label',
                        [genClass($chat__label), genProp('hidden', joinHidden)],
                        [
                            genTagName('span', [], ['Room name']),
                            genTagName('input', [
                                genClass($chat__input),
                                genProp('value', roomSig),
                                genOn(
                                    'input',
                                    bindArg(
                                        onboardingState,
                                        handleRoomSlugInput
                                    )
                                ),
                                genAttr('type', 'text'),
                                genAttr('maxlength', MAX_ROOM_SLUG_LEN),
                                genAttr(
                                    'placeholder',
                                    'general, rust, web3, voice'
                                ),
                                genAttr('required', 'required'),
                            ]),
                        ]
                    ),
                    genTagName(
                        'div',
                        [genClass($chat__controls)],
                        [
                            genTagName(
                                'span',
                                [genClass($chat__counter)],
                                [
                                    'Lowercase nickname (a-z, 0-9, _, -) & room slug',
                                ]
                            ),
                            genTagName(
                                'button',
                                [
                                    genClass($chat__button),
                                    genAttr('type', 'button'),
                                    genProp('hidden', payHidden),
                                    genProp('disabled', payDisabled),
                                    genOn(
                                        'click',
                                        bindArgs(
                                            [ctx, onboardingState],
                                            handleOnboardingPayAndUnlock
                                        )
                                    ),
                                ],
                                ['Pay & Unlock Chat']
                            ),
                            genTagName(
                                'button',
                                [
                                    genClass($chat__button),
                                    genAttr('type', 'submit'),
                                    genProp('hidden', joinHidden),
                                    genProp('disabled', joinDisabled),
                                ],
                                ['Open room']
                            ),
                        ]
                    ),
                ]
            ),
        ]
    );
};

export const initChatOnboarding = (
    ctx: Window,
    root: Element
): OnboardingState => {
    const htmlRoot = root as HTMLDivElement;
    const targetRoom = sanitizeRoomSlug(htmlRoot.dataset['targetRoom'] || '');
    const savedNickname = ctx.localStorage.getItem(GLOBAL_NICKNAME_KEY);
    const state = createChatUiState(
        savedNickname && savedNickname.length <= MAX_NICKNAME_LEN
            ? savedNickname
            : ''
    );
    const roomSig = createStore(targetRoom || 'general');
    const onboardingState: OnboardingState = [state, roomSig, targetRoom];
    const chatUiObs = observer<ChatUiEvent>();

    cleanHtml(htmlRoot);
    domCreator(
        ctx,
        htmlRoot,
        onboardingTemplate(ctx, chatUiObs, onboardingState)
    );

    chatUiObs(
        bindArg((event: ChatUiEvent) => {
            if (
                event[CHAT_UI_EVENT_TYPE] === CHAT_UI_AUTH_VERIFIED &&
                targetRoom &&
                state[CHAT_UI_STATE_HAS_ACTIVE_ACCESS][SIGNAL_GET]() &&
                isValidNickname(state[CHAT_UI_STATE_NICKNAME][SIGNAL_GET]())
            ) {
                navigateToUrl(ctx, `/chat/${encodeURIComponent(targetRoom)}`);
            }
        }, on)
    );

    state[CHAT_UI_STATE_HAS_ACTIVE_ACCESS][SIGNAL_OBS](
        bindArg((hasAccess: boolean) => {
            if (
                hasAccess &&
                targetRoom &&
                isValidNickname(state[CHAT_UI_STATE_NICKNAME][SIGNAL_GET]())
            ) {
                navigateToUrl(ctx, `/chat/${encodeURIComponent(targetRoom)}`);
            }
        }, on)
    );

    pipe(
        fetchSessionTask(ctx),
        taskFork((status: SessionStatus | null) => {
            if (status) {
                applySessionStatusToState(
                    ctx,
                    GLOBAL_NICKNAME_KEY,
                    status,
                    state
                );
                if (
                    targetRoom &&
                    status[SESSION_STATUS_HAS_ACTIVE_ACCESS] &&
                    status[SESSION_STATUS_NICKNAME]
                ) {
                    navigateToUrl(
                        ctx,
                        `/chat/${encodeURIComponent(targetRoom)}`
                    );
                    return;
                }
                if (
                    !status[SESSION_STATUS_HAS_ACTIVE_ACCESS] &&
                    state[CHAT_UI_STATE_PENDING_TX_HASH][SIGNAL_GET]() &&
                    isValidNickname(state[CHAT_UI_STATE_NICKNAME][SIGNAL_GET]())
                ) {
                    handlePayAndUnlock(ctx, GLOBAL_NICKNAME_KEY, state);
                }
            }
        }, noop)
    );

    return onboardingState;
};
