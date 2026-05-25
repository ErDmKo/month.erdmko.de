import {
    genAttr,
    genClass,
    genProp,
    genRef,
    genTagName,
    genText,
} from '@month/utils';
import { $chat__button } from '@month/gen/styles';

// ── Attachment item refs ──────────────────────────────────────────────────────

export const ATTACHMENT_REF_PROGRESS = 0 as const;

export type AttachmentItemRefs = {
    [ATTACHMENT_REF_PROGRESS]: HTMLSpanElement;
};

// ── Upload preview refs ───────────────────────────────────────────────────────

export const UPLOAD_PREVIEW_REF_REMOVE = 0 as const;
export const UPLOAD_PREVIEW_REF_PROGRESS = 1 as const;

export type UploadPreviewRefs = {
    [UPLOAD_PREVIEW_REF_REMOVE]: HTMLButtonElement;
    [UPLOAD_PREVIEW_REF_PROGRESS]: HTMLSpanElement;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// ── Templates ─────────────────────────────────────────────────────────────────

/**
 * Template for a single attachment item rendered inside a message.
 * onDownloadClick is bound in closure by the caller — no attachment id needed here.
 * Caller should use domCreatorRef to extract AttachmentItemRefs (progress span).
 */
export const attachmentItemTemplate = (
    filename: string,
    size: number,
    _mimeType: string,
    onDownloadClick: () => void
) =>
    genTagName(
        'div',
        [genClass('chat__attachment-item')],
        [
            genTagName('span', [
                genClass('chat__attachment-icon'),
                genText('\uD83D\uDCCE'),
            ]),
            genTagName('span', [
                genClass('chat__attachment-name'),
                genText(filename),
            ]),
            genTagName('span', [
                genClass('chat__attachment-size'),
                genText(formatFileSize(size)),
            ]),
            genTagName('button', [
                genClass(`${$chat__button} chat__button--download`),
                genAttr('type', 'button'),
                genProp('onclick', onDownloadClick),
                genText('Download'),
            ]),
            genTagName('span', [
                genClass('chat__attachment-progress'),
                genRef(ATTACHMENT_REF_PROGRESS),
                genAttr('hidden', 'hidden'),
            ]),
        ]
    );

/**
 * Template for upload preview shown above composer.
 * Caller should use domCreatorRef to extract UploadPreviewRefs.
 */
export const uploadPreviewTemplate = (filename: string, size: number) =>
    genTagName(
        'div',
        [genClass('chat__upload-preview-item')],
        [
            genTagName('span', [
                genClass('chat__attachment-icon'),
                genText('\uD83D\uDCCE'),
            ]),
            genTagName('span', [
                genClass('chat__upload-filename'),
                genText(filename),
            ]),
            genTagName('span', [
                genClass('chat__upload-size'),
                genText(formatFileSize(size)),
            ]),
            genTagName('button', [
                genClass(`${$chat__button} chat__button--remove`),
                genRef(UPLOAD_PREVIEW_REF_REMOVE),
                genAttr('type', 'button'),
                genAttr('aria-label', 'Remove attachment'),
                genText('\u00D7'),
            ]),
            genTagName('span', [
                genClass('chat__upload-progress'),
                genRef(UPLOAD_PREVIEW_REF_PROGRESS),
                genAttr('hidden', 'hidden'),
            ]),
        ]
    );
