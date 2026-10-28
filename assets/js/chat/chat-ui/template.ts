import {
    genTagName,
    bindArg,
    bindArgs,
    cleanHtml,
    combineSignals,
    domCreatorRef,
    domList,
    genAttr,
    genClass,
    genOn,
    genProp,
    genRef,
    mapSignal,
    trigger,
} from '@month/utils';
import type { ObserverInstance } from '@month/utils';
import {
    $chat__meta,
    $chat__error,
    $chat__form,
    $chat__label,
    $chat__input,
    $chat__textarea,
    $chat__controls,
    $chat__button,
    $chat__messages,
    $chat__counter,
    $chat__upload_preview,
    $chat__voice_bar,
    $chat__voice_status,
    $chat__voice_participants,
    $chat__voice_participant,
} from '@month/gen/styles';
import {
    VOICE_PARTICIPANT_SENDER_ID,
    VOICE_PARTICIPANT_SENDER_NAME,
} from '@month/gen/chat';
import type { ClientFramePayload, VoiceParticipant } from '@month/gen/chat';
import {
    handleConnectWallet,
    handleJoinSubmit,
    handleNicknameInput,
    handlePayAndUnlock,
    isValidNickname,
    MAX_NICKNAME_LEN,
} from './join-form-handler';
import {
    handleFileSelected,
    handleMessageInput,
    handleMessageKeydown,
    handleMessageSubmit,
    MAX_MESSAGE_LEN,
} from './message-form-handler';
import {
    CHAT_UI_VOICE_JOIN,
    CHAT_UI_VOICE_MUTE,
    CHAT_UI_VOICE_LEAVE,
} from './events';
import type { ChatUiObs } from './events';
import {
    CHAT_UI_STATE_ACCESS_UNTIL,
    CHAT_UI_STATE_AUTH_IN_FLIGHT,
    CHAT_UI_STATE_ERROR,
    CHAT_UI_STATE_HAS_ACTIVE_ACCESS,
    CHAT_UI_STATE_IS_JOINED,
    CHAT_UI_STATE_IS_ONLINE,
    CHAT_UI_STATE_JOIN_IN_FLIGHT,
    CHAT_UI_STATE_MESSAGE,
    CHAT_UI_STATE_NICKNAME,
    CHAT_UI_STATE_STATUS,
    CHAT_UI_STATE_UPLOAD_VISIBLE,
    CHAT_UI_STATE_VOICE_IN_CALL,
    CHAT_UI_STATE_VOICE_MUTED,
    CHAT_UI_STATE_VOICE_PARTICIPANTS,
    CHAT_UI_STATE_VOICE_STATUS,
    CHAT_UI_STATE_WALLET_ADDRESS,
} from './state';
import type { ChatUiState } from './state';

// Refs are only used for mounting dynamic content and browser APIs.
export const CHAT_REF_MESSAGES = 0 as const;
export const CHAT_REF_FILE_INPUT = 1 as const;
export const CHAT_REF_UPLOAD_PREVIEW = 2 as const;
export const CHAT_REF_VOICE_REMOTE_AUDIO = 3 as const;

export type ChatUiRefs = {
    [CHAT_REF_MESSAGES]: HTMLUListElement;
    [CHAT_REF_FILE_INPUT]: HTMLInputElement;
    [CHAT_REF_UPLOAD_PREVIEW]: HTMLDivElement;
    [CHAT_REF_VOICE_REMOTE_AUDIO]: HTMLAudioElement;
};

const not = (value: boolean): boolean => !value;
const participantKey = (participant: VoiceParticipant): string =>
    `${participant[VOICE_PARTICIPANT_SENDER_ID]}:${participant[VOICE_PARTICIPANT_SENDER_NAME]}`;
const participantTemplate = (participant: VoiceParticipant) =>
    genTagName(
        'li',
        [genClass($chat__voice_participant)],
        [participant[VOICE_PARTICIPANT_SENDER_NAME]]
    );

export const chatUiTemplate = (
    ctx: Window,
    nicknameKey: string,
    outgoing: ObserverInstance<ClientFramePayload>,
    chatUiObs: ChatUiObs,
    attachFile: () => void,
    state: ChatUiState
) => {
    const welcomeHidden = state[CHAT_UI_STATE_IS_JOINED];
    const chatHidden = mapSignal(not, welcomeHidden);
    const voiceHidden = mapSignal(not, state[CHAT_UI_STATE_VOICE_IN_CALL]);
    const counter = mapSignal(
        (message: string) => `${message.length}/${MAX_MESSAGE_LEN}`,
        state[CHAT_UI_STATE_MESSAGE]
    );
    const sendDisabled = mapSignal(
        ([joined, message]) =>
            !joined || message.length === 0 || message.length > MAX_MESSAGE_LEN,
        combineSignals(
            state[CHAT_UI_STATE_IS_JOINED],
            state[CHAT_UI_STATE_MESSAGE]
        )
    );
    const joinDisabled = mapSignal(
        ([[[joined, joining], [online, nickname]], hasAccess]) =>
            joined ||
            joining ||
            !online ||
            !hasAccess ||
            !isValidNickname(nickname),
        combineSignals(
            combineSignals(
                combineSignals(
                    state[CHAT_UI_STATE_IS_JOINED],
                    state[CHAT_UI_STATE_JOIN_IN_FLIGHT]
                ),
                combineSignals(
                    state[CHAT_UI_STATE_IS_ONLINE],
                    state[CHAT_UI_STATE_NICKNAME]
                )
            ),
            state[CHAT_UI_STATE_HAS_ACTIVE_ACCESS]
        )
    );
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
                [genClass($chat__meta)],
                [
                    genTagName('span', [], ['Status: ']),
                    genTagName('strong', [], [state[CHAT_UI_STATE_STATUS]]),
                ]
            ),
            genTagName(
                'p',
                [genClass($chat__error), genAttr('aria-live', 'polite')],
                [state[CHAT_UI_STATE_ERROR]]
            ),
            genTagName(
                'div',
                [genProp('hidden', welcomeHidden)],
                [
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
                                                state[
                                                    CHAT_UI_STATE_AUTH_IN_FLIGHT
                                                ]
                                            ),
                                            genOn(
                                                'click',
                                                bindArgs(
                                                    [
                                                        ctx,
                                                        nicknameKey,
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
                                bindArgs(
                                    [ctx, outgoing, state],
                                    handleJoinSubmit
                                )
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
                                        genProp(
                                            'value',
                                            state[CHAT_UI_STATE_NICKNAME]
                                        ),
                                        genOn(
                                            'input',
                                            bindArgs(
                                                [ctx, nicknameKey, state],
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
                                'div',
                                [genClass($chat__controls)],
                                [
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
                                                    [ctx, nicknameKey, state],
                                                    handlePayAndUnlock
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
                                        ['Join room']
                                    ),
                                ]
                            ),
                        ]
                    ),
                ]
            ),
            genTagName(
                'div',
                [genProp('hidden', chatHidden)],
                [
                    genTagName(
                        'div',
                        [genClass($chat__voice_bar)],
                        [
                            genTagName(
                                'button',
                                [
                                    genClass($chat__button),
                                    genAttr('type', 'button'),
                                    genProp(
                                        'hidden',
                                        state[CHAT_UI_STATE_VOICE_IN_CALL]
                                    ),
                                    genOn(
                                        'click',
                                        bindArg(
                                            bindArg(
                                                [CHAT_UI_VOICE_JOIN] as const,
                                                trigger
                                            ),
                                            chatUiObs
                                        )
                                    ),
                                ],
                                ['Join voice']
                            ),
                            genTagName(
                                'button',
                                [
                                    genClass($chat__button),
                                    genAttr('type', 'button'),
                                    genProp('hidden', voiceHidden),
                                    genOn(
                                        'click',
                                        bindArg(
                                            bindArg(
                                                [CHAT_UI_VOICE_MUTE] as const,
                                                trigger
                                            ),
                                            chatUiObs
                                        )
                                    ),
                                ],
                                [
                                    mapSignal(
                                        (muted: boolean) =>
                                            muted ? 'Unmute' : 'Mute',
                                        state[CHAT_UI_STATE_VOICE_MUTED]
                                    ),
                                ]
                            ),
                            genTagName(
                                'button',
                                [
                                    genClass($chat__button),
                                    genAttr('type', 'button'),
                                    genProp('hidden', voiceHidden),
                                    genOn(
                                        'click',
                                        bindArg(
                                            bindArg(
                                                [CHAT_UI_VOICE_LEAVE] as const,
                                                trigger
                                            ),
                                            chatUiObs
                                        )
                                    ),
                                ],
                                ['Leave']
                            ),
                            genTagName(
                                'span',
                                [genClass($chat__voice_status)],
                                [state[CHAT_UI_STATE_VOICE_STATUS]]
                            ),
                            genTagName(
                                'ul',
                                [genClass($chat__voice_participants)],
                                [
                                    domList(
                                        state[CHAT_UI_STATE_VOICE_PARTICIPANTS],
                                        participantKey,
                                        participantTemplate
                                    ),
                                ]
                            ),
                            genTagName('audio', [
                                genRef(CHAT_REF_VOICE_REMOTE_AUDIO),
                                genAttr('autoplay', 'autoplay'),
                                genAttr('hidden', 'hidden'),
                            ]),
                        ]
                    ),
                    genTagName('ul', [
                        genClass($chat__messages),
                        genRef(CHAT_REF_MESSAGES),
                        genAttr('aria-live', 'polite'),
                    ]),
                    genTagName(
                        'form',
                        [
                            genClass($chat__form),
                            genOn(
                                'submit',
                                bindArgs(
                                    [ctx, outgoing, chatUiObs, state],
                                    handleMessageSubmit
                                )
                            ),
                        ],
                        [
                            genTagName('div', [
                                genClass($chat__upload_preview),
                                genRef(CHAT_REF_UPLOAD_PREVIEW),
                                genProp(
                                    'hidden',
                                    mapSignal(
                                        not,
                                        state[CHAT_UI_STATE_UPLOAD_VISIBLE]
                                    )
                                ),
                            ]),
                            genTagName(
                                'label',
                                [genClass($chat__label)],
                                [
                                    genTagName('span', [], ['Message']),
                                    genTagName('textarea', [
                                        genClass([
                                            $chat__input,
                                            $chat__textarea,
                                        ]),
                                        genProp(
                                            'value',
                                            state[CHAT_UI_STATE_MESSAGE]
                                        ),
                                        genOn(
                                            'input',
                                            bindArg(state, handleMessageInput)
                                        ),
                                        genOn('keydown', handleMessageKeydown),
                                        genAttr('maxlength', MAX_MESSAGE_LEN),
                                        genAttr(
                                            'placeholder',
                                            'Write a message...'
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
                                        [counter]
                                    ),
                                    genTagName(
                                        'button',
                                        [
                                            genClass($chat__button),
                                            genAttr('type', 'button'),
                                            genOn('click', attachFile),
                                        ],
                                        ['Attach']
                                    ),
                                    genTagName('input', [
                                        genRef(CHAT_REF_FILE_INPUT),
                                        genAttr('type', 'file'),
                                        genAttr('hidden', 'hidden'),
                                        genOn(
                                            'change',
                                            bindArg(
                                                chatUiObs,
                                                handleFileSelected
                                            )
                                        ),
                                    ]),
                                    genTagName(
                                        'button',
                                        [
                                            genClass($chat__button),
                                            genAttr('type', 'submit'),
                                            genProp('disabled', sendDisabled),
                                        ],
                                        ['Send']
                                    ),
                                ]
                            ),
                        ]
                    ),
                ]
            ),
        ]
    );
};

export const mountChatUi = (
    ctx: Window,
    root: HTMLDivElement,
    nicknameKey: string,
    outgoing: ObserverInstance<ClientFramePayload>,
    chatUiObs: ChatUiObs,
    state: ChatUiState
): ChatUiRefs => {
    cleanHtml(root);
    const attachFile = () => refs[CHAT_REF_FILE_INPUT].click();
    const refs = domCreatorRef(
        ctx,
        root,
        chatUiTemplate(ctx, nicknameKey, outgoing, chatUiObs, attachFile, state)
    ) as unknown as ChatUiRefs;
    return refs;
};
