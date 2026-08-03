import {
    cleanHtml,
    domCreatorRef,
    genAttr,
    genClass,
    genRef,
    genTagName,
    genText,
} from '@month/utils';
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
} from '@month/gen/styles';

export const CHAT_REF_STATUS = 0 as const;
export const CHAT_REF_ERROR = 1 as const;
export const CHAT_REF_WELCOME = 2 as const;
export const CHAT_REF_CHAT_SCREEN = 3 as const;
export const CHAT_REF_JOIN_FORM = 4 as const;
export const CHAT_REF_NICKNAME = 5 as const;
export const CHAT_REF_JOIN_BUTTON = 6 as const;
export const CHAT_REF_MESSAGES = 7 as const;
export const CHAT_REF_MESSAGE_FORM = 8 as const;
export const CHAT_REF_MESSAGE = 9 as const;
export const CHAT_REF_COUNTER = 10 as const;
export const CHAT_REF_SEND = 11 as const;
export const CHAT_REF_ATTACH_BUTTON = 12 as const;
export const CHAT_REF_FILE_INPUT = 13 as const;
export const CHAT_REF_UPLOAD_PREVIEW = 14 as const;
export const CHAT_REF_VOICE_JOIN = 15 as const;
export const CHAT_REF_VOICE_MUTE = 16 as const;
export const CHAT_REF_VOICE_LEAVE = 17 as const;
export const CHAT_REF_VOICE_STATUS = 18 as const;
export const CHAT_REF_VOICE_PARTICIPANTS = 19 as const;
export const CHAT_REF_VOICE_REMOTE_AUDIO = 20 as const;

export type ChatUiRefs = {
    [CHAT_REF_STATUS]: HTMLElement;
    [CHAT_REF_ERROR]: HTMLParagraphElement;
    [CHAT_REF_WELCOME]: HTMLDivElement;
    [CHAT_REF_CHAT_SCREEN]: HTMLDivElement;
    [CHAT_REF_JOIN_FORM]: HTMLFormElement;
    [CHAT_REF_MESSAGES]: HTMLUListElement;
    [CHAT_REF_NICKNAME]: HTMLInputElement;
    [CHAT_REF_JOIN_BUTTON]: HTMLButtonElement;
    [CHAT_REF_MESSAGE_FORM]: HTMLFormElement;
    [CHAT_REF_MESSAGE]: HTMLTextAreaElement;
    [CHAT_REF_COUNTER]: HTMLSpanElement;
    [CHAT_REF_SEND]: HTMLButtonElement;
    [CHAT_REF_ATTACH_BUTTON]: HTMLButtonElement;
    [CHAT_REF_FILE_INPUT]: HTMLInputElement;
    [CHAT_REF_UPLOAD_PREVIEW]: HTMLDivElement;
    [CHAT_REF_VOICE_JOIN]: HTMLButtonElement;
    [CHAT_REF_VOICE_MUTE]: HTMLButtonElement;
    [CHAT_REF_VOICE_LEAVE]: HTMLButtonElement;
    [CHAT_REF_VOICE_STATUS]: HTMLSpanElement;
    [CHAT_REF_VOICE_PARTICIPANTS]: HTMLUListElement;
    [CHAT_REF_VOICE_REMOTE_AUDIO]: HTMLAudioElement;
};

export const chatUiTemplate = (maxMessageLen: number) =>
    genTagName(
        'div',
        [],
        [
            genTagName(
                'div',
                [genClass($chat__meta)],
                [
                    genTagName('span', [genText('Status: ')]),
                    genTagName('strong', [
                        genRef(CHAT_REF_STATUS),
                        genText('connecting'),
                    ]),
                ]
            ),
            genTagName('p', [
                genClass($chat__error),
                genRef(CHAT_REF_ERROR),
                genAttr('aria-live', 'polite'),
            ]),
            genTagName(
                'div',
                [genRef(CHAT_REF_WELCOME)],
                [
                    genTagName(
                        'form',
                        [genClass($chat__form), genRef(CHAT_REF_JOIN_FORM)],
                        [
                            genTagName(
                                'label',
                                [genClass($chat__label)],
                                [
                                    genTagName('span', [genText('Nickname')]),
                                    genTagName('input', [
                                        genClass($chat__input),
                                        genRef(CHAT_REF_NICKNAME),
                                        genAttr('type', 'text'),
                                        genAttr('maxlength', 32),
                                        genAttr('placeholder', 'guest'),
                                        genAttr('required', 'required'),
                                    ]),
                                ]
                            ),
                            genTagName(
                                'div',
                                [genClass($chat__controls)],
                                [
                                    genTagName('button', [
                                        genClass($chat__button),
                                        genRef(CHAT_REF_JOIN_BUTTON),
                                        genAttr('type', 'submit'),
                                        genText('Join room'),
                                    ]),
                                ]
                            ),
                        ]
                    ),
                ]
            ),
            genTagName(
                'div',
                [genRef(CHAT_REF_CHAT_SCREEN), genAttr('hidden', 'hidden')],
                [
                    genTagName(
                        'div',
                        [genClass($chat__voice_bar)],
                        [
                            genTagName('button', [
                                genClass($chat__button),
                                genRef(CHAT_REF_VOICE_JOIN),
                                genAttr('type', 'button'),
                                genText('Join voice'),
                            ]),
                            genTagName('button', [
                                genClass($chat__button),
                                genRef(CHAT_REF_VOICE_MUTE),
                                genAttr('type', 'button'),
                                genAttr('hidden', 'hidden'),
                                genText('Mute'),
                            ]),
                            genTagName('button', [
                                genClass($chat__button),
                                genRef(CHAT_REF_VOICE_LEAVE),
                                genAttr('type', 'button'),
                                genAttr('hidden', 'hidden'),
                                genText('Leave'),
                            ]),
                            genTagName('span', [
                                genClass($chat__voice_status),
                                genRef(CHAT_REF_VOICE_STATUS),
                            ]),
                            genTagName('ul', [
                                genClass($chat__voice_participants),
                                genRef(CHAT_REF_VOICE_PARTICIPANTS),
                            ]),
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
                        [genClass($chat__form), genRef(CHAT_REF_MESSAGE_FORM)],
                        [
                            genTagName('div', [
                                genClass($chat__upload_preview),
                                genRef(CHAT_REF_UPLOAD_PREVIEW),
                                genAttr('hidden', 'hidden'),
                            ]),
                            genTagName(
                                'label',
                                [genClass($chat__label)],
                                [
                                    genTagName('span', [genText('Message')]),
                                    genTagName('textarea', [
                                        genClass(
                                            `${$chat__input} ${$chat__textarea}`
                                        ),
                                        genRef(CHAT_REF_MESSAGE),
                                        genAttr('maxlength', maxMessageLen),
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
                                    genTagName('span', [
                                        genClass($chat__counter),
                                        genRef(CHAT_REF_COUNTER),
                                        genText(`0/${maxMessageLen}`),
                                    ]),
                                    genTagName('button', [
                                        genClass($chat__button),
                                        genRef(CHAT_REF_ATTACH_BUTTON),
                                        genAttr('type', 'button'),
                                        genText('Attach'),
                                    ]),
                                    genTagName('input', [
                                        genRef(CHAT_REF_FILE_INPUT),
                                        genAttr('type', 'file'),
                                        genAttr('hidden', 'hidden'),
                                    ]),
                                    genTagName('button', [
                                        genClass($chat__button),
                                        genRef(CHAT_REF_SEND),
                                        genAttr('type', 'submit'),
                                        genText('Send'),
                                    ]),
                                ]
                            ),
                        ]
                    ),
                ]
            ),
        ]
    );

export const mountChatUi = (
    ctx: Window,
    root: HTMLDivElement,
    maxMessageLen: number
): ChatUiRefs => {
    cleanHtml(root);
    return domCreatorRef(
        ctx,
        root,
        chatUiTemplate(maxMessageLen)
    ) as unknown as ChatUiRefs;
};
