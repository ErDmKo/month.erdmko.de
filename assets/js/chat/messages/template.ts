import { genAttr, genClass, genRef, genTagName, genText } from '@month/utils';
import type { AttachmentItem } from '../generated/chat';

export type { AttachmentItem } from '../generated/chat';

export const MESSAGE_REF_ATTACHMENTS = 0 as const;

export type MessageRefs = {
    [MESSAGE_REF_ATTACHMENTS]: HTMLUListElement;
};

export const chatMessageTemplate = (
    id: number,
    senderName: string,
    body: string,
    attachments: readonly AttachmentItem[] = [],
    createdAt?: string,
    isOwn: boolean = false
) =>
    genTagName(
        'li',
        [
            genClass(
                isOwn ? 'chat__message chat__message--own' : 'chat__message'
            ),
            genAttr('data-message-id', id),
        ],
        [
            genTagName(
                'div',
                [genClass('chat__message-head')],
                [
                    genTagName('span', [
                        genClass('chat__message-meta'),
                        genText(
                            `${senderName}${createdAt ? ` • ${createdAt}` : ''}`
                        ),
                    ]),
                    genTagName('button', [
                        genClass('chat__delete'),
                        genAttr('type', 'button'),
                        genAttr('data-delete-id', id),
                        genAttr('aria-label', 'Delete message'),
                        genAttr('title', 'Delete message'),
                        genText('×'),
                    ]),
                ]
            ),
            genTagName('div', [genClass('chat__message-body'), genText(body)]),
            ...(attachments.length > 0
                ? [
                      genTagName('ul', [
                          genClass('chat__attachments'),
                          genRef(MESSAGE_REF_ATTACHMENTS),
                      ]),
                  ]
                : []),
        ]
    );
