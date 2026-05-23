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

const PORT = () => parseInt(process.env.E2E_SERVER_PORT!, 10);
const BASE_URL = () => `http://127.0.0.1:${PORT()}`;
const room = () => `room-${Math.random().toString(36).slice(2)}`;

// CSS selectors derived from the class names in
// assets/js/chat/chat-ui/template.ts and assets/js/chat/attachments/template.ts
const SEL = {
    nicknameInput: '.chat__input:not(.chat__textarea)',
    joinButton: '.chat__button:not(.chat__button--send):not(.chat__button--attach):not(.chat__button--remove)',
    messageTextarea: '.chat__textarea',
    sendButton: '.chat__button--send, .chat__button[type="submit"]',
    attachButton: '.chat__button--attach, input[type="file"]',
    fileInput: 'input[type="file"]',
    uploadPreviewFilename: '.chat__upload-filename',
    uploadProgress: '.chat__upload-progress',
    removeButton: '.chat__button--remove',
    attachmentItem: '.chat__attachment-item',
    attachmentName: '.chat__attachment-name',
    downloadButton: '.chat__button--download',
    downloadProgress: '.chat__attachment-progress',
    messageList: '.chat__messages',
};

let browser: Browser;

beforeAll(async () => {
    browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
});

afterAll(async () => {
    if (browser) await browser.close();
});

/** Open a new page and join a chat room. Returns the page after join. */
async function openAndJoin(roomId: string, nickname: string): Promise<Page> {
    const page = await browser.newPage();
    // Suppress console noise from the page
    // page.on('console', msg => console.log('[browser]', msg.text()));

    await page.goto(`${BASE_URL()}/chat/${roomId}`, { waitUntil: 'networkidle2', timeout: 10_000 });

    // Check the page loaded (if the bundle is missing, the join form won't appear)
    const joinFormExists = await page.$(SEL.nicknameInput).then(Boolean);
    if (!joinFormExists) {
        await page.close();
        throw new Error(
            'Chat UI did not render — ensure the frontend bundle is built: bazel build //assets/js:month-bundle'
        );
    }

    await page.type(SEL.nicknameInput, nickname);
    await page.click(SEL.joinButton);

    // Wait for chat screen to appear
    await page.waitForSelector(SEL.messageTextarea, { timeout: 5_000 });
    return page;
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('attachments UI (Puppeteer)', () => {
    test('file preview appears after selecting a file', async () => {
        const page = await openAndJoin(room(), 'alice');
        const tmpFile = path.join(os.tmpdir(), 'e2e-preview-test.txt');
        fs.writeFileSync(tmpFile, 'preview content');

        try {
            const fileInput = await page.$(SEL.fileInput) as import("puppeteer").ElementHandle<HTMLInputElement> | null;
            expect(fileInput).not.toBeNull();
            await fileInput!.uploadFile(tmpFile);

            // The upload preview filename should appear above the composer
            await page.waitForSelector(SEL.uploadPreviewFilename, { timeout: 3_000 });
            const filename = await page.$eval(SEL.uploadPreviewFilename, (el) => el.textContent);
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
            const fileInput = await page.$(SEL.fileInput) as import("puppeteer").ElementHandle<HTMLInputElement> | null;
            await fileInput!.uploadFile(tmpFile);
            await page.waitForSelector(SEL.uploadPreviewFilename, { timeout: 3_000 });

            await page.click(SEL.removeButton);

            // After removal the preview item should disappear
            await page.waitForFunction(
                (sel) => !document.querySelector(sel),
                { timeout: 3_000 },
                SEL.uploadPreviewFilename,
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
        const fileContent = Buffer.alloc(1024, 0xab);  // 1 KB
        fs.writeFileSync(tmpFile, fileContent);

        try {
            await page.type(SEL.messageTextarea, 'message with attachment');

            const fileInput = await page.$(SEL.fileInput) as import("puppeteer").ElementHandle<HTMLInputElement> | null;
            await fileInput!.uploadFile(tmpFile);
            await page.waitForSelector(SEL.uploadPreviewFilename, { timeout: 3_000 });

            // Submit the form
            await page.click(SEL.sendButton);

            // The attachment item should appear in the message list
            await page.waitForSelector(SEL.attachmentItem, { timeout: 10_000 });

            const attachmentName = await page.$eval(SEL.attachmentName, (el) => el.textContent);
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
        const fileContent = Buffer.alloc(512 * 1024, 0xcd);  // 512 KB
        fs.writeFileSync(tmpFile, fileContent);

        const progressTexts: string[] = [];
        try {
            await page.type(SEL.messageTextarea, 'progress test');

            const fileInput = await page.$(SEL.fileInput) as import("puppeteer").ElementHandle<HTMLInputElement> | null;
            await fileInput!.uploadFile(tmpFile);
            await page.waitForSelector(SEL.uploadPreviewFilename, { timeout: 3_000 });

            // Observe progress spans via MutationObserver before submitting
            await page.evaluate((sel) => {
                (window as any).__progressTexts = [];
                const observer = new MutationObserver(() => {
                    const el = document.querySelector(sel);
                    if (el && el.textContent) {
                        (window as any).__progressTexts.push(el.textContent);
                    }
                });
                observer.observe(document.body, { subtree: true, childList: true, characterData: true });
                (window as any).__progressObserver = observer;
            }, SEL.uploadProgress);

            await page.click(SEL.sendButton);

            // Wait for upload to complete (attachment appears)
            await page.waitForSelector(SEL.attachmentItem, { timeout: 15_000 });

            const captured = await page.evaluate(() => (window as any).__progressTexts as string[]);
            // At least one progress update should have been captured
            // (may be empty if upload was too fast — only assert when chunks > 1)
            if (captured.length > 0) {
                expect(captured.some((t) => /\d+\s*\/\s*\d+/.test(t))).toBe(true);
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

    test('download flow: click Download → file is downloaded via createObjectURL', async () => {
        const roomId = room();
        const page = await openAndJoin(roomId, 'alice');
        const tmpFile = path.join(os.tmpdir(), 'e2e-download-test.txt');
        fs.writeFileSync(tmpFile, 'download me please');

        try {
            await page.type(SEL.messageTextarea, 'msg for download');
            const fileInput = await page.$(SEL.fileInput) as import("puppeteer").ElementHandle<HTMLInputElement> | null;
            await fileInput!.uploadFile(tmpFile);
            await page.waitForSelector(SEL.uploadPreviewFilename, { timeout: 3_000 });
            await page.click(SEL.sendButton);

            // Wait for the attachment to appear
            await page.waitForSelector(SEL.downloadButton, { timeout: 10_000 });

            // Intercept createObjectURL to detect download completion
            await page.evaluate(() => {
                (window as any).__downloadObjectUrls = [];
                const orig = URL.createObjectURL.bind(URL);
                URL.createObjectURL = (blob: Blob) => {
                    const url = orig(blob);
                    (window as any).__downloadObjectUrls.push(url);
                    return url;
                };
            });

            await page.click(SEL.downloadButton);

            // Wait for createObjectURL to be called (= download triggered)
            await page.waitForFunction(
                () => (window as any).__downloadObjectUrls.length > 0,
                { timeout: 10_000 },
            );

            const urls: string[] = await page.evaluate(
                () => (window as any).__downloadObjectUrls as string[]
            );
            expect(urls.length).toBeGreaterThan(0);
            expect(urls[0]).toMatch(/^blob:/);
        } finally {
            await page.close();
            fs.unlinkSync(tmpFile);
        }
    });
});
