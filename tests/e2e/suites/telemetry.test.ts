/**
 * telemetry.test.ts — Real Chromium + Rust server E2E verification of binary Protobuf
 * client error telemetry over `/ws/telemetry`, structured OpenTelemetry-aligned stdout
 * output, offline buffering & reconnect flush, and Closure ADVANCED bundle string audit.
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

describe('client error telemetry E2E (/ws/telemetry -> server stdout)', () => {
    test('unauthenticated Phantom personal_sign -32000 failure on /chat streams binary batch and logs structured ERROR to server stdout', async () => {
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

            expect(stdout).toContain('severity=17');
            expect(stdout).toContain('chain_id=1');
            expect(stdout).toContain('providers=ethereum,phantom');
            expect(stdout).toContain('path="/chat"');
        } finally {
            await session.close();
        }
    });

    test('offline uncaught runtime error queues while disconnected and flushes over /ws/telemetry once online', async () => {
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

            // Give the page 300ms while offline — server stdout must NOT contain marker yet
            await new Promise((r) => setTimeout(r, 300));
            expect(telemetryServer.getStdout()).not.toContain(marker);

            // Restore network connectivity -> queued frame flushes over /ws/telemetry
            await onboarding.setNetworkOffline(false);
            const stdout = await waitForStdoutMatch((s) => s.includes(marker));

            expect(stdout).toContain('ERROR telemetry] event=browser.error');
            expect(stdout).toContain('kind=uncaught_error');
            // Query string `?room=secret-room` is never leaked in telemetry path
            expect(stdout).not.toContain('secret-room');
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
    });
});
