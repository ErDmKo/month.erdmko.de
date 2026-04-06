import {
    cleanHtml,
    domCreatorRef,
    genAttr,
    genClass,
    genRef,
    genTagName,
    genText,
} from '@month/utils';

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
};

export const chatUiTemplate = (maxMessageLen: number) =>
    genTagName('div', [], [
        genTagName('div', [genClass('chat__meta')], [
            genTagName('span', [genText('Status: ')]),
            genTagName('strong', [genRef(CHAT_REF_STATUS), genText('connecting')]),
        ]),
        genTagName('p', [genClass('chat__error'), genRef(CHAT_REF_ERROR), genAttr('aria-live', 'polite')]),
        genTagName('div', [genRef(CHAT_REF_WELCOME)], [
            genTagName('form', [genClass('chat__form'), genRef(CHAT_REF_JOIN_FORM)], [
                genTagName('label', [genClass('chat__label')], [
                    genTagName('span', [genText('Nickname')]),
                    genTagName('input', [
                        genClass('chat__input'),
                        genRef(CHAT_REF_NICKNAME),
                        genAttr('type', 'text'),
                        genAttr('maxlength', 32),
                        genAttr('placeholder', 'guest'),
                        genAttr('required', 'required'),
                    ]),
                ]),
                genTagName('div', [genClass('chat__controls')], [
                    genTagName('button', [
                        genClass('chat__button'),
                        genRef(CHAT_REF_JOIN_BUTTON),
                        genAttr('type', 'submit'),
                        genText('Join room'),
                    ]),
                ]),
            ]),
        ]),
        genTagName('div', [genRef(CHAT_REF_CHAT_SCREEN), genAttr('hidden', 'hidden')], [
            genTagName('ul', [genClass('chat__messages'), genRef(CHAT_REF_MESSAGES), genAttr('aria-live', 'polite')]),
            genTagName('form', [genClass('chat__form'), genRef(CHAT_REF_MESSAGE_FORM)], [
                genTagName('label', [genClass('chat__label')], [
                    genTagName('span', [genText('Message')]),
                    genTagName('textarea', [
                        genClass('chat__input chat__textarea'),
                        genRef(CHAT_REF_MESSAGE),
                        genAttr('maxlength', maxMessageLen),
                        genAttr('placeholder', 'Write a message...'),
                        genAttr('required', 'required'),
                    ]),
                ]),
                genTagName('div', [genClass('chat__controls')], [
                    genTagName('span', [genClass('chat__counter'), genRef(CHAT_REF_COUNTER), genText(`0/${maxMessageLen}`)]),
                    genTagName('button', [
                        genClass('chat__button'),
                        genRef(CHAT_REF_SEND),
                        genAttr('type', 'submit'),
                        genText('Send'),
                    ]),
                ]),
            ]),
        ]),
    ]);

export const chatMessageTemplate = (
    id: number,
    senderName: string,
    body: string,
    createdAt?: string,
    isOwn: boolean = false
) =>
    genTagName('li', [
        genClass(isOwn ? 'chat__message chat__message--own' : 'chat__message'),
        genAttr('data-message-id', id),
    ], [
        genTagName('div', [genClass('chat__message-head')], [
            genTagName('span', [genClass('chat__message-meta'), genText(`${senderName}${createdAt ? ` • ${createdAt}` : ''}`)]),
            genTagName('button', [
                genClass('chat__delete'),
                genAttr('type', 'button'),
                genAttr('data-delete-id', id),
                genAttr('aria-label', 'Delete message'),
                genAttr('title', 'Delete message'),
                genText('×'),
            ]),
        ]),
        genTagName('div', [genClass('chat__message-body'), genText(body)]),
    ]);

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
