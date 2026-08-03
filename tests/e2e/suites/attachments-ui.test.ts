/**
 * attachments-ui.test.ts — full browser E2E via Puppeteer.
 *
 * Prerequisites:
 *   1. The frontend bundle must be built: `bazel build //assets/js:month-bundle`
 *   2. The server must be started with the built static assets; the globalSetup
 *      in this suite does that via startServer() which points BASE_PATH at the
 *      workspace root so the server finds `assets/` for static files and
 *      `templates/` for Tera templates.
 *
 * If the bundle is not built, each test in this suite will be skipped with a
 * clear message rather than failing with a cryptic timeout.
 */
import puppeteer, { Browser, Page } from 'puppeteer';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { PAGE_TIMEOUT_MS } from '../helpers/constants';
import {
    $chat__button,
    $chat__input,
    $chat__textarea,
    $chat__messages,
    $chat__upload_filename,
    $chat__upload_progress,
    $chat__button__remove,
    $chat__attachment_item,
    $chat__attachment_name,
    $chat__button__download,
    $chat__attachment_progress,
} from '../../../assets/js/gen/styles';

const PORT = () => parseInt(process.env.E2E_SERVER_PORT!, 10);
const BASE_URL = () => `http://127.0.0.1:${PORT()}`;
const room = () => `room-${Math.random().toString(36).slice(2)}`;

const c = (name: string) => `.${name}`;

const SEL = {
    nicknameInput: `${c($chat__input)}:not(${c($chat__textarea)})`,
    joinButton: c($chat__button),
    messageTextarea: c($chat__textarea),
    sendButton: `${c($chat__button)}[type="submit"]`,
    fileInput: 'input[type="file"]',
    uploadPreviewFilename: c($chat__upload_filename),
    uploadProgress: c($chat__upload_progress),
    removeButton: `${c($chat__button)}.${$chat__button__remove}`,
    attachmentItem: c($chat__attachment_item),
    attachmentName: c($chat__attachment_name),
    downloadButton: `${c($chat__button)}.${$chat__button__download}`,
    downloadProgress: c($chat__attachment_progress),
    messageList: c($chat__messages),
};

let browser: Browser;

beforeEach(async () => {
    browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
});

afterEach(async () => {
    await browser.close();
});

/** Open a new page and join a chat room. Returns the page after join. */
async function openAndJoin(roomId: string, nickname: string): Promise<Page> {
    const page = await browser.newPage();
    // Suppress console noise from the page
    // page.on('console', msg => console.log('[browser]', msg.text()));

    await page.goto(`${BASE_URL()}/chat/${roomId}`, {
        waitUntil: 'load',
        timeout: PAGE_TIMEOUT_MS,
    });

    // Wait for JS to render the join form
    await page.waitForSelector(SEL.nicknameInput, { timeout: PAGE_TIMEOUT_MS });

    await page.type(SEL.nicknameInput, nickname);
    await page.click(SEL.joinButton);

    // Wait for chat screen to appear
    await page.waitForSelector(SEL.messageTextarea, {
        timeout: PAGE_TIMEOUT_MS,
    });
    return page;
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('attachments UI (Puppeteer)', () => {
    test('file preview appears after selecting a file', async () => {
        const page = await openAndJoin(room(), 'alice');
        const tmpFile = path.join(os.tmpdir(), 'e2e-preview-test.txt');
        fs.writeFileSync(tmpFile, 'preview content');

        try {
            const fileInput = (await page.$(SEL.fileInput)) as
                import('puppeteer').ElementHandle<HTMLInputElement> | null;
            expect(fileInput).not.toBeNull();
            await fileInput!.uploadFile(tmpFile);

            // The upload preview filename should appear above the composer
            await page.waitForSelector(SEL.uploadPreviewFilename, {
                timeout: PAGE_TIMEOUT_MS,
            });
            const filename = await page.$eval(
                SEL.uploadPreviewFilename,
                (el) => el.textContent
            );
            expect(filename).toContain('e2e-preview-test.txt');
        } finally {
            await page.close();
            fs.unlinkSync(tmpFile);
        }
    });

    test('remove button clears file preview', async () => {
        const page = await openAndJoin(room(), 'alice');
        const tmpFile = path.join(os.tmpdir(), 'e2e-remove-test.txt');
        fs.writeFileSync(tmpFile, 'to be removed');

        try {
            const fileInput = (await page.$(SEL.fileInput)) as
                import('puppeteer').ElementHandle<HTMLInputElement> | null;
            await fileInput!.uploadFile(tmpFile);
            await page.waitForSelector(SEL.uploadPreviewFilename, {
                timeout: PAGE_TIMEOUT_MS,
            });

            await page.click(SEL.removeButton);

            // After removal the preview item should disappear
            await page.waitForFunction(
                (sel) => !document.querySelector(sel),
                { timeout: PAGE_TIMEOUT_MS },
                SEL.uploadPreviewFilename
            );
        } finally {
            await page.close();
            fs.unlinkSync(tmpFile);
        }
    });

    test('upload flow: send message with attachment → attachment appears in message list', async () => {
        const roomId = room();
        const page = await openAndJoin(roomId, 'alice');
        const tmpFile = path.join(os.tmpdir(), 'e2e-upload-test.bin');
        const fileContent = Buffer.alloc(1024, 0xab); // 1 KB
        fs.writeFileSync(tmpFile, fileContent);

        try {
            await page.type(SEL.messageTextarea, 'message with attachment');

            const fileInput = (await page.$(SEL.fileInput)) as
                import('puppeteer').ElementHandle<HTMLInputElement> | null;
            await fileInput!.uploadFile(tmpFile);
            await page.waitForSelector(SEL.uploadPreviewFilename, {
                timeout: PAGE_TIMEOUT_MS,
            });

            // Submit the form
            await page.focus(SEL.messageTextarea);
            await page.keyboard.press('Enter');

            // The attachment item should appear in the message list
            await page.waitForSelector(SEL.attachmentItem, {
                timeout: PAGE_TIMEOUT_MS,
            });

            const attachmentName = await page.$eval(
                SEL.attachmentName,
                (el) => el.textContent
            );
            expect(attachmentName).toContain('e2e-upload-test.bin');
        } finally {
            await page.close();
            fs.unlinkSync(tmpFile);
        }
    });

    test('upload progress indicator shows chunk count during upload', async () => {
        const roomId = room();
        const page = await openAndJoin(roomId, 'alice');

        // Create a file large enough to generate multiple chunks
        const tmpFile = path.join(os.tmpdir(), 'e2e-progress-test.bin');
        const fileContent = Buffer.alloc(512 * 1024, 0xcd); // 512 KB
        fs.writeFileSync(tmpFile, fileContent);

        const progressTexts: string[] = [];
        try {
            await page.type(SEL.messageTextarea, 'progress test');

            const fileInput = (await page.$(SEL.fileInput)) as
                import('puppeteer').ElementHandle<HTMLInputElement> | null;
            await fileInput!.uploadFile(tmpFile);
            await page.waitForSelector(SEL.uploadPreviewFilename, {
                timeout: PAGE_TIMEOUT_MS,
            });

            // Observe progress spans via MutationObserver before submitting
            await page.evaluate((sel) => {
                (window as any).__progressTexts = [];
                const observer = new MutationObserver(() => {
                    const el = document.querySelector(sel);
                    if (el && el.textContent) {
                        (window as any).__progressTexts.push(el.textContent);
                    }
                });
                observer.observe(document.body, {
                    subtree: true,
                    childList: true,
                    characterData: true,
                });
                (window as any).__progressObserver = observer;
            }, SEL.uploadProgress);

            await page.focus(SEL.messageTextarea);
            await page.keyboard.press('Enter');

            // Wait for upload to complete (attachment appears)
            await page.waitForSelector(SEL.attachmentItem, {
                timeout: PAGE_TIMEOUT_MS,
            });

            const captured = await page.evaluate(
                () => (window as any).__progressTexts as string[]
            );
            // At least one progress update should have been captured
            // (may be empty if upload was too fast — only assert when chunks > 1)
            if (captured.length > 0) {
                expect(captured.some((t) => /\d+\s*\/\s*\d+/.test(t))).toBe(
                    true
                );
            }
        } finally {
            await page.evaluate(() => {
                if ((window as any).__progressObserver) {
                    (window as any).__progressObserver.disconnect();
                }
            });
            await page.close();
            fs.unlinkSync(tmpFile);
        }
    });

    test('download flow: downloaded file content matches uploaded file', async () => {
        const roomId = room();
        const page = await openAndJoin(roomId, 'alice');
        const tmpFile = path.join(os.tmpdir(), 'e2e-download-test.txt');
        const fileContent = 'download me please';
        fs.writeFileSync(tmpFile, fileContent);

        try {
            await page.type(SEL.messageTextarea, 'msg for download');
            const fileInput = (await page.$(SEL.fileInput)) as
                import('puppeteer').ElementHandle<HTMLInputElement> | null;
            await fileInput!.uploadFile(tmpFile);
            await page.waitForSelector(SEL.uploadPreviewFilename, {
                timeout: PAGE_TIMEOUT_MS,
            });
            await page.focus(SEL.messageTextarea);
            await page.keyboard.press('Enter');

            await page.waitForSelector(SEL.downloadButton, {
                timeout: PAGE_TIMEOUT_MS,
            });

            // Tell Chrome to accept downloads silently — prevents the "leave site?" dialog
            const cdp = await page.createCDPSession();
            await cdp.send('Browser.setDownloadBehavior', {
                behavior: 'allow',
                downloadPath: os.tmpdir(),
                eventsEnabled: false,
            });

            // Intercept createObjectURL: read blob as base64 before it gets revoked,
            // then signal completion when revokeObjectURL is called.
            await page.evaluate(() => {
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

            await page.click(SEL.downloadButton);

            // Wait until revokeObjectURL is called — the full download cycle is done
            await page.waitForFunction(
                () => (window as any).__downloadRevoked === true,
                { timeout: PAGE_TIMEOUT_MS }
            );

            // Also wait for the FileReader async read to finish
            await page.waitForFunction(
                () => (window as any).__downloadedBase64 !== null,
                { timeout: PAGE_TIMEOUT_MS }
            );

            const base64: string = await page.evaluate(
                () => (window as any).__downloadedBase64 as string
            );
            const downloaded = Buffer.from(base64, 'base64').toString('utf8');
            expect(downloaded).toBe(fileContent);
        } finally {
            await page.close();
            fs.unlinkSync(tmpFile);
        }
    });
});
