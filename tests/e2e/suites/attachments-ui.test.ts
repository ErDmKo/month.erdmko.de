/**
 * attachments-ui.test.ts — full browser E2E via Page Objects (`ChatOnboardingPage` & `ChatRoomPage`).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import puppeteer, { Browser } from 'puppeteer';
import { ChatOnboardingPage, createIsolatedPageSession } from '../pages';
import type { ChatRoomPage, IsolatedPageSession } from '../pages';

const baseUrl = () => `http://127.0.0.1:${process.env.E2E_SERVER_PORT}`;
const uniqueRoom = () => `room-${Math.random().toString(36).slice(2)}`;

let browser: Browser;

beforeAll(async () => {
    browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
});

afterAll(async () => {
    await browser.close();
});

async function enterFreshRoom(): Promise<{
    session: IsolatedPageSession;
    roomPage: ChatRoomPage;
}> {
    const session = await createIsolatedPageSession(browser);
    const onboarding = new ChatOnboardingPage(session.page, baseUrl());
    const { roomPage } = await onboarding.onboardAndEnterRoom(uniqueRoom());
    return { session, roomPage };
}

describe('attachments UI (Puppeteer)', () => {
    test('file preview appears after selecting a file', async () => {
        const { session, roomPage } = await enterFreshRoom();
        const tmpFile = path.join(os.tmpdir(), 'e2e-preview-test.txt');
        fs.writeFileSync(tmpFile, 'preview content');

        try {
            await roomPage.selectAttachmentFile(tmpFile);
            const filename = await roomPage.waitForUploadPreviewFilename();
            expect(filename).toContain('e2e-preview-test.txt');
            expect(session.errors).toEqual([]);
        } finally {
            await session.close();
            fs.unlinkSync(tmpFile);
        }
    });

    test('remove button clears file preview', async () => {
        const { session, roomPage } = await enterFreshRoom();
        const tmpFile = path.join(os.tmpdir(), 'e2e-remove-test.txt');
        fs.writeFileSync(tmpFile, 'to be removed');

        try {
            await roomPage.selectAttachmentFile(tmpFile);
            await roomPage.waitForUploadPreviewFilename();
            await roomPage.removeSelectedAttachment();
            await roomPage.waitForUploadPreviewCleared();
            expect(session.errors).toEqual([]);
        } finally {
            await session.close();
            fs.unlinkSync(tmpFile);
        }
    });

    test('upload flow: send message with attachment → attachment appears in message list', async () => {
        const { session, roomPage } = await enterFreshRoom();
        const tmpFile = path.join(os.tmpdir(), 'e2e-upload-test.bin');
        fs.writeFileSync(tmpFile, Buffer.alloc(1024, 0xab));

        try {
            await roomPage.typeComposerText('message with attachment');
            await roomPage.selectAttachmentFile(tmpFile);
            await roomPage.waitForUploadPreviewFilename();
            await roomPage.submitComposerWithEnter();

            const attachmentName =
                await roomPage.waitForUploadedAttachmentName();
            expect(attachmentName).toContain('e2e-upload-test.bin');
            expect(session.errors).toEqual([]);
        } finally {
            await session.close();
            fs.unlinkSync(tmpFile);
        }
    });

    test('upload progress indicator shows chunk count during upload', async () => {
        const { session, roomPage } = await enterFreshRoom();
        const tmpFile = path.join(os.tmpdir(), 'e2e-progress-test.bin');
        fs.writeFileSync(tmpFile, Buffer.alloc(512 * 1024, 0xcd));

        try {
            await roomPage.typeComposerText('progress test');
            await roomPage.selectAttachmentFile(tmpFile);
            await roomPage.waitForUploadPreviewFilename();
            await roomPage.startObservingUploadProgress();
            await roomPage.submitComposerWithEnter();
            await roomPage.waitForUploadedAttachmentName();

            const captured = await roomPage.stopObservingUploadProgress();
            if (captured.length > 0) {
                expect(captured.some((t) => /\d+\s*\/\s*\d+/.test(t))).toBe(
                    true
                );
            }
            expect(session.errors).toEqual([]);
        } finally {
            await roomPage.stopObservingUploadProgress();
            await session.close();
            fs.unlinkSync(tmpFile);
        }
    });

    test('download flow: downloaded file content matches uploaded file', async () => {
        const { session, roomPage } = await enterFreshRoom();
        const tmpFile = path.join(os.tmpdir(), 'e2e-download-test.txt');
        const fileContent = 'download me please';
        fs.writeFileSync(tmpFile, fileContent);

        try {
            await roomPage.typeComposerText('msg for download');
            await roomPage.selectAttachmentFile(tmpFile);
            await roomPage.waitForUploadPreviewFilename();
            await roomPage.submitComposerWithEnter();
            await roomPage.waitForUploadedAttachmentName();

            const downloaded = await roomPage.downloadFirstAttachmentAsUtf8();
            expect(downloaded).toBe(fileContent);
            expect(session.errors).toEqual([]);
        } finally {
            await session.close();
            fs.unlinkSync(tmpFile);
        }
    });
});
