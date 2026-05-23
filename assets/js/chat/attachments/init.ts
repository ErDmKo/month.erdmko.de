import {
    bindArg,
    cleanHtml,
    domCreatorRef,
    genClass,
    genRef,
    genTagName,
    on,
    trigger,
    pipe,
    taskMap,
    taskFork,
    noop,
    Task,
} from '../../utils';
import type { ChatSocket } from '../protocol/incoming';
import type { ServerFramePayload, ClientFramePayload } from '../generated/chat';
import {
    SERVER_FRAME_PAYLOAD_VARIANT,
    SERVER_FRAME_PAYLOAD_VALUE,
    SERVER_FRAME_UPLOAD_DONE,
    CLIENT_FRAME_PAYLOAD_VARIANT,
    CLIENT_FRAME_PAYLOAD_VALUE,
    CLIENT_FRAME_MESSAGE,
    CLIENT_MESSAGE_REQUEST_ID,
} from '../generated/chat';
import {
    CHAT_SOCKET_INCOMING,
    CHAT_SOCKET_OUTGOING,
} from '../protocol/incoming';
import {
    MSGS_EVENT_TYPE,
    MSGS_INIT,
    MSGS_INIT_PAYLOAD,
} from '../messages/handler';
import type { MsgsObs, MsgsInitPayload, MsgsEvent } from '../messages/handler';
import {
    MAX_UPLOAD_SIZE,
    renderAttachmentFromUploadDone,
    getUploadDoneMessageId,
    startUpload,
    uploadPreviewTemplate,
    UPLOAD_PREVIEW_REF_REMOVE,
} from './handler';
import {
    CHAT_UI_EVENT_TYPE,
    CHAT_UI_INIT,
    CHAT_UI_INIT_REFS,
    CHAT_UI_ERROR,
    CHAT_UI_FILE_SELECTED,
    CHAT_UI_FILE_SELECTED_FILE,
} from '../chat-ui/events';
import type { ChatUiObs, ChatUiEvent } from '../chat-ui/events';
import {
    CHAT_REF_MESSAGES,
    CHAT_REF_UPLOAD_PREVIEW,
    CHAT_REF_FILE_INPUT,
} from '../chat-ui/template';

// ── local ref constant for on-the-fly <ul> ────────────────────────────────────

const UPLOAD_DONE_UL_REF = 0 as const;

// ── initAttachments ───────────────────────────────────────────────────────────

export const initAttachments = (
    ctx: Window,
    socket: ChatSocket,
    chatUiObs: ChatUiObs,
    msgsObs: MsgsObs
): Task<void> =>
    (resolve) => {
        const outgoing = socket[CHAT_SOCKET_OUTGOING];
        const incoming = socket[CHAT_SOCKET_INCOMING];
        let pendingFile: File | null = null;
        let waitForMessageId: ((requestId: string) => Task<number>) | null = null;
        let clearUploadPreview: (() => void) | null = null;

        // ── chatUiObs: INIT → wire DOM refs and file-selected ─────────────────

        chatUiObs(
            bindArg((event: ChatUiEvent) => {
                if (event[CHAT_UI_EVENT_TYPE] !== CHAT_UI_INIT) return;
                const refs = event[CHAT_UI_INIT_REFS];

                clearUploadPreview = () => {
                    pendingFile = null;
                    refs[CHAT_REF_UPLOAD_PREVIEW].hidden = true;
                    cleanHtml(refs[CHAT_REF_UPLOAD_PREVIEW]);
                    refs[CHAT_REF_FILE_INPUT].value = '';
                };

                const showUploadPreview = (file: File) => {
                    cleanHtml(refs[CHAT_REF_UPLOAD_PREVIEW]);
                    const previewRefs = domCreatorRef(
                        ctx,
                        refs[CHAT_REF_UPLOAD_PREVIEW],
                        uploadPreviewTemplate(file.name, file.size)
                    ) as unknown as { [UPLOAD_PREVIEW_REF_REMOVE]: HTMLButtonElement };
                    refs[CHAT_REF_UPLOAD_PREVIEW].hidden = false;
                    previewRefs[UPLOAD_PREVIEW_REF_REMOVE].addEventListener(
                        'click',
                        clearUploadPreview!
                    );
                };

                // WS_UPLOAD_DONE — attach new attachment to existing message
                on((wsEvent: ServerFramePayload) => {
                    if (wsEvent[SERVER_FRAME_PAYLOAD_VARIANT] !== SERVER_FRAME_UPLOAD_DONE) return;
                    const uploadDone = wsEvent[SERVER_FRAME_PAYLOAD_VALUE];
                    const messageId = getUploadDoneMessageId(uploadDone);
                    const msgEl = refs[CHAT_REF_MESSAGES].querySelector(
                        `[data-message-id="${messageId}"]`
                    );
                    if (!msgEl) return;
                    let ulEl = msgEl.querySelector('.chat__attachments') as HTMLUListElement | null;
                    if (!ulEl) {
                        const ulRefs = domCreatorRef(
                            ctx,
                            msgEl,
                            genTagName('ul', [
                                genClass('chat__attachments'),
                                genRef(UPLOAD_DONE_UL_REF),
                            ])
                        ) as unknown as { [UPLOAD_DONE_UL_REF]: HTMLUListElement };
                        ulEl = ulRefs[UPLOAD_DONE_UL_REF];
                    }
                    renderAttachmentFromUploadDone(ctx, socket, ulEl, uploadDone);
                }, incoming);

                // CHAT_UI_FILE_SELECTED — show upload preview
                chatUiObs(
                    bindArg((fileEvent: ChatUiEvent) => {
                        if (fileEvent[CHAT_UI_EVENT_TYPE] !== CHAT_UI_FILE_SELECTED) return;
                        const file = fileEvent[CHAT_UI_FILE_SELECTED_FILE];
                        if (file.size === 0 || file.size > MAX_UPLOAD_SIZE) {
                            chatUiObs(
                                bindArg(
                                    [CHAT_UI_ERROR, `File must be between 1 byte and ${MAX_UPLOAD_SIZE} bytes.`] as const,
                                    trigger
                                )
                            );
                            return;
                        }
                        chatUiObs(bindArg([CHAT_UI_ERROR, ''] as const, trigger));
                        pendingFile = file;
                        showUploadPreview(file);
                    }, on)
                );
            }, on)
        );

        // ── outgoing: MESSAGE_TYPE → clear preview and start upload ───────────

        outgoing(
            bindArg((command: ClientFramePayload) => {
                if (command[CLIENT_FRAME_PAYLOAD_VARIANT] !== CLIENT_FRAME_MESSAGE) return;
                const msgRequestId = command[CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_MESSAGE_REQUEST_ID];
                const fileToUpload = pendingFile;
                if (clearUploadPreview) clearUploadPreview();
                if (!fileToUpload || !waitForMessageId) return;
                pipe(
                    waitForMessageId(msgRequestId),
                    taskMap((messageId: number) => {
                        startUpload(ctx, socket, `upload-${Date.now()}`, messageId, fileToUpload);
                    }),
                    taskFork(noop, (e) =>
                        chatUiObs(bindArg([CHAT_UI_ERROR, String(e)] as const, trigger))
                    )
                );
            }, on)
        );

        // ── msgsObs: INIT → store waitForMessageId, then resolve ─────────────

        msgsObs(
            bindArg((event: MsgsEvent) => {
                if (event[MSGS_EVENT_TYPE] !== MSGS_INIT) return;
                const payload = event[MSGS_INIT_PAYLOAD] as MsgsInitPayload;
                waitForMessageId = payload.waitForMessageId;
                resolve();
            }, on)
        );
    };
