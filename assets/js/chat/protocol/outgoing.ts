import {
    encodeClientFrame,
    CLIENT_FRAME_PAYLOAD_VARIANT,
    CLIENT_FRAME_PAYLOAD_VALUE,
    CLIENT_FRAME_JOIN,
    CLIENT_FRAME_MESSAGE,
    CLIENT_FRAME_DELETE,
    CLIENT_FRAME_DOWNLOAD_REQUEST,
    CLIENT_JOIN_NICKNAME,
    CLIENT_MESSAGE_BODY,
    CLIENT_DELETE_MESSAGE_ID,
    CLIENT_DOWNLOAD_REQUEST_ATTACHMENT_ID,
} from '@month/gen/chat';
import type { ClientFramePayload } from '@month/gen/chat';
import { MAX_NICKNAME_LEN } from '../chat-ui/join-form-handler';
import { MAX_MESSAGE_LEN } from '../chat-ui/message-form-handler';
import { logOutgoingFrame } from '../../utils/ws-logger';

export const serializeCommand = (
    ctx: Window,
    command: ClientFramePayload
): ArrayBuffer => {
    logOutgoingFrame(ctx, command);
    return encodeClientFrame(ctx, command).buffer as ArrayBuffer;
};

// ── Validation ────────────────────────────────────────────────────────────────

export const validateOutgoingCommand = (
    command: ClientFramePayload
): string | null => {
    const variant = command[CLIENT_FRAME_PAYLOAD_VARIANT];

    if (variant === CLIENT_FRAME_JOIN) {
        const nickname =
            command[CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_JOIN_NICKNAME].trim();
        if (nickname.length === 0 || nickname.length > MAX_NICKNAME_LEN) {
            return `Nickname must be between 1 and ${MAX_NICKNAME_LEN} characters.`;
        }
        return null;
    }

    if (variant === CLIENT_FRAME_MESSAGE) {
        const body =
            command[CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_MESSAGE_BODY].trim();
        if (body.length === 0 || body.length > MAX_MESSAGE_LEN) {
            return `Message must be between 1 and ${MAX_MESSAGE_LEN} characters.`;
        }
        return null;
    }

    if (variant === CLIENT_FRAME_DELETE) {
        const messageId =
            command[CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_DELETE_MESSAGE_ID];
        if (!Number.isInteger(messageId) || messageId <= 0) {
            return 'Message id must be a positive integer.';
        }
        return null;
    }

    if (variant === CLIENT_FRAME_DOWNLOAD_REQUEST) {
        const attachmentId =
            command[CLIENT_FRAME_PAYLOAD_VALUE][
                CLIENT_DOWNLOAD_REQUEST_ATTACHMENT_ID
            ];
        if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
            return 'Attachment id must be a positive integer.';
        }
        return null;
    }

    return null;
};
