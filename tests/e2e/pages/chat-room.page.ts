import * as os from 'os';
import type { ElementHandle, Page } from 'puppeteer';
import {
    $chat__attachment_item,
    $chat__attachment_name,
    $chat__button,
    $chat__button__download,
    $chat__button__remove,
    $chat__messages,
    $chat__textarea,
    $chat__upload_filename,
    $chat__upload_progress,
} from '../../../assets/js/gen/styles';
import { PAGE_TIMEOUT_MS } from '../helpers/constants';
import { BasePage } from './base.page';

const COMPOSER_TEXTAREA = `.${$chat__textarea}`;
const MESSAGE_LIST = `.${$chat__messages}`;
const FILE_INPUT = 'input[type="file"]';
const UPLOAD_PREVIEW_FILENAME = `.${$chat__upload_filename}`;
const UPLOAD_PROGRESS = `.${$chat__upload_progress}`;
const REMOVE_UPLOAD_BUTTON = `.${$chat__button}.${$chat__button__remove}`;
const ATTACHMENT_ITEM = `.${$chat__attachment_item}`;
const ATTACHMENT_NAME = `.${$chat__attachment_name}`;
const DOWNLOAD_BUTTON = `.${$chat__button}.${$chat__button__download}`;

export class ChatRoomPage extends BasePage {
    constructor(page: Page, baseUrl: string) {
        super(page, baseUrl);
    }

    async openRoom(roomId: string): Promise<number> {
        const status = await this.gotoPath(
            `/chat/${encodeURIComponent(roomId)}`
        );
        await this.waitUntilReady();
        return status;
    }

    async waitUntilReady(timeoutMs = PAGE_TIMEOUT_MS): Promise<void> {
        await this.page.waitForFunction(
            (sel) => {
                const ta = document.querySelector(
                    sel
                ) as HTMLTextAreaElement | null;
                return Boolean(ta && !ta.closest('[hidden]'));
            },
            { timeout: timeoutMs },
            COMPOSER_TEXTAREA
        );
    }

    async sendMessage(body: string): Promise<void> {
        await this.page.focus(COMPOSER_TEXTAREA);
        await this.page.type(COMPOSER_TEXTAREA, body);
        await this.page.keyboard.press('Enter');
    }

    async typeComposerText(body: string): Promise<void> {
        await this.page.focus(COMPOSER_TEXTAREA);
        await this.page.type(COMPOSER_TEXTAREA, body);
    }

    async submitComposerWithEnter(): Promise<void> {
        await this.page.focus(COMPOSER_TEXTAREA);
        await this.page.keyboard.press('Enter');
    }

    async waitForMessage(text: string): Promise<void> {
        await this.waitForContainerText(MESSAGE_LIST, text);
    }

    async storedRoomNickname(roomId: string): Promise<string | null> {
        return this.localStorageItem(`chat-nickname-${roomId}`);
    }

    // ── File attachments ────────────────────────────────────────────────────

    async selectAttachmentFile(filePath: string): Promise<void> {
        const fileInput = (await this.page.$(
            FILE_INPUT
        )) as ElementHandle<HTMLInputElement> | null;
        if (!fileInput) {
            throw new Error('Attachment <input type="file"> not found');
        }
        await fileInput.uploadFile(filePath);
    }

    async waitForUploadPreviewFilename(): Promise<string> {
        await this.page.waitForFunction(
            (sel) => Boolean(document.querySelector(sel)?.textContent),
            { timeout: PAGE_TIMEOUT_MS },
            UPLOAD_PREVIEW_FILENAME
        );
        return this.page.$eval(
            UPLOAD_PREVIEW_FILENAME,
            (el) => el.textContent ?? ''
        );
    }

    async removeSelectedAttachment(): Promise<void> {
        await this.page.click(REMOVE_UPLOAD_BUTTON);
    }

    async waitForUploadPreviewCleared(): Promise<void> {
        await this.page.waitForFunction(
            (sel) => !document.querySelector(sel),
            { timeout: PAGE_TIMEOUT_MS },
            UPLOAD_PREVIEW_FILENAME
        );
    }

    async startObservingUploadProgress(): Promise<void> {
        await this.page.evaluate((sel) => {
            (window as any).__progressTexts = [];
            const obs = new MutationObserver(() => {
                const el = document.querySelector(sel);
                if (el && el.textContent) {
                    (window as any).__progressTexts.push(el.textContent);
                }
            });
            obs.observe(document.body, {
                subtree: true,
                childList: true,
                characterData: true,
            });
            (window as any).__progressObserver = obs;
        }, UPLOAD_PROGRESS);
    }

    async stopObservingUploadProgress(): Promise<string[]> {
        return this.page.evaluate(() => {
            if ((window as any).__progressObserver) {
                (window as any).__progressObserver.disconnect();
            }
            return ((window as any).__progressTexts as string[]) ?? [];
        });
    }

    async waitForUploadedAttachmentName(): Promise<string> {
        await this.page.waitForFunction(
            (itemSel, nameSel) =>
                Boolean(
                    document.querySelector(itemSel) &&
                    document.querySelector(nameSel)?.textContent
                ),
            { timeout: PAGE_TIMEOUT_MS },
            ATTACHMENT_ITEM,
            ATTACHMENT_NAME
        );
        return this.page.$eval(ATTACHMENT_NAME, (el) => el.textContent ?? '');
    }

    async downloadFirstAttachmentAsUtf8(): Promise<string> {
        await this.page.waitForFunction(
            (sel) => Boolean(document.querySelector(sel)),
            { timeout: PAGE_TIMEOUT_MS },
            DOWNLOAD_BUTTON
        );

        const cdp = await this.page.createCDPSession();
        await cdp.send('Browser.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: os.tmpdir(),
            eventsEnabled: false,
        });

        await this.page.evaluate(() => {
            (window as any).__downloadedBase64 = null;
            (window as any).__downloadRevoked = false;

            const origCreate = URL.createObjectURL.bind(URL);
            const origRevoke = URL.revokeObjectURL.bind(URL);

            URL.createObjectURL = (blob: Blob) => {
                const url = origCreate(blob);
                const reader = new FileReader();
                reader.onload = () => {
                    (window as any).__downloadedBase64 = (
                        reader.result as string
                    ).split(',')[1];
                };
                reader.readAsDataURL(blob);
                return url;
            };

            URL.revokeObjectURL = (url: string) => {
                origRevoke(url);
                (window as any).__downloadRevoked = true;
            };
        });

        await this.page.click(DOWNLOAD_BUTTON);

        await this.page.waitForFunction(
            () =>
                (window as any).__downloadRevoked === true &&
                (window as any).__downloadedBase64 !== null,
            { timeout: PAGE_TIMEOUT_MS }
        );

        const base64 = await this.page.evaluate(
            () => (window as any).__downloadedBase64 as string
        );
        return Buffer.from(base64, 'base64').toString('utf8');
    }

    // ── WebRTC Voice controls ───────────────────────────────────────────────

    async joinVoice(): Promise<void> {
        await this.clickButton('Join voice');
        await this.page.waitForFunction(
            () =>
                Array.from(document.querySelectorAll('button')).some(
                    (el) => el.textContent === 'Mute' && !el.hidden
                ),
            { timeout: PAGE_TIMEOUT_MS }
        );
    }

    async muteVoice(): Promise<void> {
        await this.clickButton('Mute');
        await this.page.waitForFunction(
            () =>
                Array.from(document.querySelectorAll('button')).some(
                    (el) => el.textContent === 'Unmute' && !el.hidden
                ),
            { timeout: PAGE_TIMEOUT_MS }
        );
    }

    async leaveVoice(): Promise<void> {
        await this.clickButton('Leave');
    }
}
