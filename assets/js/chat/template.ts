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
export const CHAT_REF_MESSAGES = 2 as const;
export const CHAT_REF_FORM = 3 as const;
export const CHAT_REF_NICKNAME = 4 as const;
export const CHAT_REF_MESSAGE = 5 as const;
export const CHAT_REF_COUNTER = 6 as const;
export const CHAT_REF_SEND = 7 as const;

export type ChatUiRefs = {
    [CHAT_REF_STATUS]: HTMLElement;
    [CHAT_REF_ERROR]: HTMLParagraphElement;
    [CHAT_REF_MESSAGES]: HTMLUListElement;
    [CHAT_REF_FORM]: HTMLFormElement;
    [CHAT_REF_NICKNAME]: HTMLInputElement;
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
        genTagName('ul', [genClass('chat__messages'), genRef(CHAT_REF_MESSAGES), genAttr('aria-live', 'polite')]),
        genTagName('form', [genClass('chat__form'), genRef(CHAT_REF_FORM)], [
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
    ]);

export const chatMessageTemplate = (
    senderName: string,
    body: string,
    createdAt?: string
) =>
    genTagName('li', [genClass('chat__message')], [
        genTagName('div', [
            genClass('chat__message-head'),
            genText(`${senderName}${createdAt ? ` • ${createdAt}` : ''}`),
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
