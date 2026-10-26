import {
    genTagName,
    genAttr,
    genClass,
    genOn,
    genProp,
    mapSignal,
} from '@month/utils';
import type { ReadonlySignal } from '@month/utils';
import {
    $chat__button,
    $chat__attachment_item,
    $chat__attachment_icon,
    $chat__attachment_name,
    $chat__attachment_size,
    $chat__attachment_progress,
    $chat__upload_preview_item,
    $chat__upload_filename,
    $chat__upload_size,
    $chat__upload_progress,
    $chat__button__download,
    $chat__button__remove,
} from '@month/gen/styles';

export const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const progressTemplate = (
    className: string,
    progress: ReadonlySignal<string>
) =>
    genTagName(
        'span',
        [
            genClass(className),
            genProp(
                'hidden',
                mapSignal((text: string) => !text, progress)
            ),
        ],
        [progress]
    );

export const attachmentItemTemplate = (
    filename: string,
    size: number,
    _mimeType: string,
    onDownloadClick: () => void,
    progress: ReadonlySignal<string>
) =>
    genTagName(
        'div',
        [genClass($chat__attachment_item)],
        [
            genTagName('span', [genClass($chat__attachment_icon)], ['📎']),
            genTagName('span', [genClass($chat__attachment_name)], [filename]),
            genTagName(
                'span',
                [genClass($chat__attachment_size)],
                [formatFileSize(size)]
            ),
            genTagName(
                'button',
                [
                    genClass([$chat__button, $chat__button__download]),
                    genAttr('type', 'button'),
                    genOn('click', onDownloadClick),
                ],
                ['Download']
            ),
            progressTemplate($chat__attachment_progress, progress),
        ]
    );

export const uploadPreviewTemplate = (
    filename: string,
    size: number,
    onRemove: () => void,
    progress: ReadonlySignal<string>
) =>
    genTagName(
        'div',
        [genClass($chat__upload_preview_item)],
        [
            genTagName('span', [genClass($chat__attachment_icon)], ['📎']),
            genTagName('span', [genClass($chat__upload_filename)], [filename]),
            genTagName(
                'span',
                [genClass($chat__upload_size)],
                [formatFileSize(size)]
            ),
            genTagName(
                'button',
                [
                    genClass([$chat__button, $chat__button__remove]),
                    genAttr('type', 'button'),
                    genAttr('aria-label', 'Remove attachment'),
                    genOn('click', onRemove),
                ],
                ['×']
            ),
            progressTemplate($chat__upload_progress, progress),
        ]
    );
