/**
 * telemetry.test.ts — Real Chromium + Rust server E2E verification of binary Protobuf
 * client error telemetry over `POST /telemetry`, structured OpenTelemetry-aligned stdout
 * output, offline localStorage persistence & reload flush, and Closure ADVANCED bundle audit.
 *
 * All browser/DOM interactions go strictly through `ChatOnboardingPage`.
 */
import * as fs from 'fs';
import * as path from 'path';
import puppeteer, { Browser } from 'puppeteer';
import { startServer } from '../helpers/server';
import type { ServerHandle } from '../helpers/server';
import { installMockWallet } from '../helpers/wallet';
import { ChatOnboardingPage, createIsolatedPageSession } from '../pages';

let browser: Browser;
let telemetryServer: ServerHandle;

const serverBaseUrl = () => `http://127.0.0.1:${telemetryServer.port}`;

async function waitForStdoutMatch(
    predicate: (stdout: string) => boolean,
    timeoutMs = 8000
): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
        const out = telemetryServer.getStdout();
        if (predicate(out)) return out;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(
        `Timed out waiting for server stdout match.\nCurrent stdout:\n${telemetryServer.getStdout()}`
    );
}

beforeAll(async () => {
    telemetryServer = await startServer({ skipBuild: true });
    browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
});

afterAll(async () => {
    if (browser) await browser.close();
    if (telemetryServer) await telemetryServer.stop();
});

describe('client error telemetry E2E (POST /telemetry -> server stdout)', () => {
    test('unauthenticated Phantom personal_sign -32000 failure on /chat posts binary batch and logs structured ERROR to server stdout', async () => {
        const session = await createIsolatedPageSession(browser);
        try {
            await installMockWallet(session.page, {
                rpcUrl: telemetryServer.rpcUrl,
                providerFlags: { isPhantom: true },
                signError: {
                    code: -32000,
                    message:
                        "The app's signature request cannot be shown as the address does not match",
                },
            });

            const onboarding = new ChatOnboardingPage(
                session.page,
                serverBaseUrl()
            );
            await onboarding.openLanding();
            await onboarding.connectWallet();
            await onboarding.waitForNotice(
                "The app's signature request cannot be shown"
            );

            // Verify no session cookie exists (telemetry works pre-auth!)
            const cookies = await onboarding.cookies();
            expect(
                cookies.find((c) => c.name === 'month_session')
            ).toBeUndefined();

            const stdout = await waitForStdoutMatch(
                (s) =>
                    s.includes('ERROR telemetry] event=browser.error') &&
                    s.includes('kind=wallet_rpc') &&
                    s.includes('op=personal_sign') &&
                    s.includes('code="-32000"')
            );

            expect(stdout).toContain('severity=ERROR');
            expect(stdout).toContain('chain_id=1');
            expect(stdout).toContain('providers=ethereum,phantom');
            expect(stdout).toContain('path="/chat"');
        } finally {
            await session.close();
        }
    });

    test('offline uncaught runtime error persists in localStorage across reload, flushes once online, and clears on 204', async () => {
        const session = await createIsolatedPageSession(browser);
        try {
            const onboarding = new ChatOnboardingPage(
                session.page,
                serverBaseUrl()
            );
            await onboarding.openLanding('secret-room');

            const marker = `offline_crash_${Date.now()}`;
            await onboarding.setNetworkOffline(true);
            await onboarding.triggerUncaughtRuntimeError(marker);

            // Persisted in localStorage while offline, and NOT yet sent to server
            await new Promise((r) => setTimeout(r, 250));
            const persistedB64 = await onboarding.localStorageItem('telemetry');
            expect(persistedB64).toBeTruthy();
            expect(telemetryServer.getStdout()).not.toContain(marker);

            // Simulate closing tab, coming back online, and opening a fresh /chat page in the same BrowserContext
            const freshPage = await session.context.newPage();
            await session.page.close();
            const reloadedOnboarding = new ChatOnboardingPage(
                freshPage,
                serverBaseUrl()
            );
            await reloadedOnboarding.openLanding();

            const stdout = await waitForStdoutMatch((s) => s.includes(marker));
            expect(stdout).toContain(
                'ERROR telemetry] event=browser.error severity=ERROR'
            );
            expect(stdout).toContain('kind=uncaught_error');
            // Query string `?room=secret-room` is never leaked in telemetry path
            expect(stdout).not.toContain('secret-room');

            // Once server returns 204 No Content, `telemetry` is purged from localStorage
            await new Promise((r) => setTimeout(r, 150));
            expect(
                await reloadedOnboarding.localStorageItem('telemetry')
            ).toBeFalsy();
        } finally {
            await session.close();
        }
    });

    test('compiled Closure ADVANCED chat-bundle.js contains zero debug logger or enum identifier strings', () => {
        const root = path.resolve(__dirname, '..', '..', '..');
        const bundlePath = path.join(
            root,
            'bazel-bin',
            'assets',
            'js',
            'chat-bundle.js'
        );
        const bundleSrc = fs.readFileSync(bundlePath, 'utf8');

        expect(bundleSrc).not.toContain('upload_ready');
        expect(bundleSrc).not.toContain('download_chunk');
        expect(bundleSrc).not.toMatch(/getItem\(['"]debug['"]\)/);
        expect(bundleSrc).not.toMatch(
            /TELEMETRY_(SEVERITY|KIND|OP|PROVIDER_FLAG)_/
        );
        expect(bundleSrc).not.toContain('indexedDB');
        expect(bundleSrc).not.toContain('/ws/telemetry');
    });
});
