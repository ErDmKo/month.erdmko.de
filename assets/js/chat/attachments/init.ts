import {
    bindArg,
    cleanHtml,
    createStore,
    domCreator,
    domCreatorRef,
    domDispose,
    genClass,
    genRef,
    genTagName,
    SIGNAL_SET,
    on,
    trigger,
    pipe,
    taskMap,
    taskFork,
    noop,
    Task,
} from '../../utils';
import type { DomScope, Signal } from '../../utils';
import type { ChatSocket } from '../protocol/incoming';
import type { ServerFramePayload, ClientFramePayload } from '@month/gen/chat';
import {
    SERVER_FRAME_PAYLOAD_VARIANT,
    SERVER_FRAME_PAYLOAD_VALUE,
    SERVER_FRAME_UPLOAD_DONE,
    CLIENT_FRAME_PAYLOAD_VARIANT,
    CLIENT_FRAME_PAYLOAD_VALUE,
    CLIENT_FRAME_MESSAGE,
    CLIENT_MESSAGE_REQUEST_ID,
} from '@month/gen/chat';
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
    UPLOAD_READY,
    UPLOAD_PROGRESS,
    UPLOAD_DONE,
    UPLOAD_ERROR,
    UPLOAD_EVENT_TYPE,
    UPLOAD_PROGRESS_SENT,
    UPLOAD_PROGRESS_TOTAL,
    renderAttachmentFromUploadDone,
    getUploadDoneMessageId,
    startUpload,
    uploadPreviewTemplate,
} from './handler';
import type { UploadEvent } from './handler';
import {
    CHAT_UI_EVENT_TYPE,
    CHAT_UI_INIT,
    CHAT_UI_INIT_REFS,
    CHAT_UI_INIT_STATE,
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
import { CHAT_UI_STATE_UPLOAD_VISIBLE } from '../chat-ui/state';
import { $chat__attachments } from '@month/gen/styles';

// ── local ref constant for on-the-fly <ul> ────────────────────────────────────

const UPLOAD_DONE_UL_REF = 0 as const;

// ── initAttachments ───────────────────────────────────────────────────────────

export const initAttachments =
    (
        ctx: Window,
        socket: ChatSocket,
        chatUiObs: ChatUiObs,
        msgsObs: MsgsObs
    ): Task<void> =>
    (resolve) => {
        const outgoing = socket[CHAT_SOCKET_OUTGOING];
        const incoming = socket[CHAT_SOCKET_INCOMING];
        let pendingFile: File | null = null;
        let pendingProgress: Signal<string> | null = null;
        const previewScope: DomScope = [];
        let waitForMessageId: ((requestId: string) => Task<number>) | null =
            null;
        let clearUploadPreview: (() => void) | null = null;

        // ── chatUiObs: INIT → wire DOM refs and file-selected ─────────────────

        chatUiObs(
            bindArg((event: ChatUiEvent) => {
                if (event[CHAT_UI_EVENT_TYPE] !== CHAT_UI_INIT) return;
                const refs = event[CHAT_UI_INIT_REFS];
                const state = event[CHAT_UI_INIT_STATE];

                clearUploadPreview = () => {
                    pendingFile = null;
                    pendingProgress = null;
                    state[CHAT_UI_STATE_UPLOAD_VISIBLE][SIGNAL_SET](false);
                    domDispose(previewScope);
                    cleanHtml(refs[CHAT_REF_UPLOAD_PREVIEW]);
                    refs[CHAT_REF_FILE_INPUT].value = '';
                };

                const showUploadPreview = (file: File) => {
                    domDispose(previewScope);
                    cleanHtml(refs[CHAT_REF_UPLOAD_PREVIEW]);
                    const progress = createStore('');
                    domCreator(
                        ctx,
                        refs[CHAT_REF_UPLOAD_PREVIEW],
                        uploadPreviewTemplate(
                            file.name,
                            file.size,
                            clearUploadPreview!,
                            progress
                        ),
                        previewScope
                    );
                    state[CHAT_UI_STATE_UPLOAD_VISIBLE][SIGNAL_SET](true);
                    return progress;
                };

                // WS_UPLOAD_DONE — attach new attachment to existing message
                on((wsEvent: ServerFramePayload) => {
                    if (
                        wsEvent[SERVER_FRAME_PAYLOAD_VARIANT] !==
                        SERVER_FRAME_UPLOAD_DONE
                    )
                        return;
                    const uploadDone = wsEvent[SERVER_FRAME_PAYLOAD_VALUE];
                    const messageId = getUploadDoneMessageId(uploadDone);
                    const msgEl = refs[CHAT_REF_MESSAGES].querySelector(
                        `[data-message-id="${messageId}"]`
                    );
                    if (!msgEl) return;
                    let ulEl = msgEl.querySelector(
                        `.${$chat__attachments}`
                    ) as HTMLUListElement | null;
                    if (!ulEl) {
                        const ulRefs = domCreatorRef(
                            ctx,
                            msgEl,
                            genTagName('ul', [
                                genClass($chat__attachments),
                                genRef(UPLOAD_DONE_UL_REF),
                            ])
                        ) as unknown as {
                            [UPLOAD_DONE_UL_REF]: HTMLUListElement;
                        };
                        ulEl = ulRefs[UPLOAD_DONE_UL_REF];
                    }
                    renderAttachmentFromUploadDone(
                        ctx,
                        socket,
                        ulEl,
                        uploadDone
                    );
                }, incoming);

                // CHAT_UI_FILE_SELECTED — show upload preview
                chatUiObs(
                    bindArg((fileEvent: ChatUiEvent) => {
                        if (
                            fileEvent[CHAT_UI_EVENT_TYPE] !==
                            CHAT_UI_FILE_SELECTED
                        )
                            return;
                        const file = fileEvent[CHAT_UI_FILE_SELECTED_FILE];
                        if (file.size === 0 || file.size > MAX_UPLOAD_SIZE) {
                            chatUiObs(
                                bindArg(
                                    [
                                        CHAT_UI_ERROR,
                                        `File must be between 1 byte and ${MAX_UPLOAD_SIZE} bytes.`,
                                    ] as const,
                                    trigger
                                )
                            );
                            return;
                        }
                        chatUiObs(
                            bindArg([CHAT_UI_ERROR, ''] as const, trigger)
                        );
                        pendingFile = file;
                        pendingProgress = showUploadPreview(file);
                    }, on)
                );
            }, on)
        );

        // ── outgoing: MESSAGE_TYPE → clear preview and start upload ───────────

        outgoing(
            bindArg((command: ClientFramePayload) => {
                if (
                    command[CLIENT_FRAME_PAYLOAD_VARIANT] !==
                    CLIENT_FRAME_MESSAGE
                )
                    return;
                const msgRequestId =
                    command[CLIENT_FRAME_PAYLOAD_VALUE][
                        CLIENT_MESSAGE_REQUEST_ID
                    ];
                const fileToUpload = pendingFile;
                const progress = pendingProgress;
                pendingFile = null;
                pendingProgress = null;
                if (!fileToUpload || !waitForMessageId) {
                    if (clearUploadPreview) clearUploadPreview();
                    return;
                }
                // Keep the preview container visible for upload progress;
                // reset only the file input so the user can select a new file.
                // The preview will be cleared on UPLOAD_DONE or UPLOAD_ERROR.
                pipe(
                    waitForMessageId(msgRequestId),
                    taskMap((messageId: number) => {
                        const uploadObs = startUpload(
                            ctx,
                            socket,
                            `upload-${ctx.Date.now()}`,
                            messageId,
                            fileToUpload
                        );
                        uploadObs(
                            bindArg((event: UploadEvent) => {
                                if (!progress) return;
                                if (event[UPLOAD_EVENT_TYPE] === UPLOAD_READY) {
                                    progress[SIGNAL_SET]('0 chunks sent');
                                } else if (
                                    event[UPLOAD_EVENT_TYPE] === UPLOAD_PROGRESS
                                ) {
                                    progress[SIGNAL_SET](
                                        `${event[UPLOAD_PROGRESS_SENT]} / ${event[UPLOAD_PROGRESS_TOTAL]} chunks sent`
                                    );
                                } else if (
                                    event[UPLOAD_EVENT_TYPE] === UPLOAD_DONE
                                ) {
                                    if (clearUploadPreview)
                                        clearUploadPreview();
                                } else if (
                                    event[UPLOAD_EVENT_TYPE] === UPLOAD_ERROR
                                ) {
                                    progress[SIGNAL_SET]('Upload error');
                                }
                            }, on)
                        );
                    }),
                    taskFork(noop, (e) =>
                        chatUiObs(
                            bindArg(
                                [CHAT_UI_ERROR, String(e)] as const,
                                trigger
                            )
                        )
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
