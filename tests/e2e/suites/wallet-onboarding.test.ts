/**
 * wallet-onboarding.test.ts — Real Chromium E2E verification of paid wallet onboarding,
 * binary Protobuf /auth/* endpoints, SIWE secp256k1 verification, pending/reverted/conflict
 * recovery, unauthorized WebSocket rejection, and SQLite persistence across server restart.
 *
 * All DOM/navigation interactions go strictly through `ChatOnboardingPage` and `ChatRoomPage`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import puppeteer, { Browser } from 'puppeteer';
import { setMockRpcConfig, startMockEthRpcServer } from '../helpers/mock-rpc';
import { startServer } from '../helpers/server';
import { startTlsReverseProxy } from '../helpers/tls-proxy';
import { installMockWallet } from '../helpers/wallet';
import {
    ChatOnboardingPage,
    ChatRoomPage,
    createIsolatedPageSession,
} from '../pages';

const baseUrl = () => `http://127.0.0.1:${process.env.E2E_SERVER_PORT}`;
const rpcUrl = () =>
    process.env.E2E_RPC_URL || `http://127.0.0.1:${process.env.E2E_RPC_PORT}`;

let browser: Browser;

beforeAll(async () => {
    browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--ignore-certificate-errors',
        ],
    });
});

afterAll(async () => {
    await browser.close();
});

describe('paid wallet onboarding & security E2E', () => {
    test('room invite redirects anonymous visitor, completes SIWE + ETH payment, auto-joins room, and restores returning session without re-paying', async () => {
        const roomId = `invite-${Date.now()}`;
        const nick = `alice_${Date.now()}`;
        const session = await createIsolatedPageSession(browser);

        try {
            const wallet = await installMockWallet(session.page);
            const onboarding = new ChatOnboardingPage(session.page, baseUrl());

            // 1. Visiting /chat/{room} anonymously redirects to /chat?room={room}
            await onboarding.openRoomExpectingRedirect(roomId);
            expect(onboarding.currentUrl()).toBe(
                `${baseUrl()}/chat?room=${roomId}`
            );
            await onboarding.waitForNotice(
                `Authorization required to join #${roomId}`
            );

            // 2. Connect Wallet -> real EIP-4361 SIWE personal_sign + binary protobuf /auth/nonce & /auth/verify
            await onboarding.connectWallet();
            await onboarding.waitForConnectedWallet(wallet.address);
            expect(wallet.signedMessages.length).toBe(1);

            // Verify HttpOnly session cookie was issued
            const cookies = await onboarding.cookies();
            const sessionCookie = cookies.find(
                (c) => c.name === 'month_session'
            );
            expect(sessionCookie).toBeDefined();
            expect(sessionCookie?.httpOnly).toBe(true);

            // 3. Enter nickname & Pay & Unlock Chat -> auto-redirects to /chat/{room}
            await onboarding.enterNickname(nick);
            await onboarding.payAndUnlock();

            const roomPage = new ChatRoomPage(session.page, baseUrl());
            await roomPage.waitUntilReady();
            expect(roomPage.currentUrl()).toBe(`${baseUrl()}/chat/${roomId}`);
            expect(wallet.sentTxs.length).toBe(1);
            expect(wallet.sentTxs[0]?.value).toBe('0x38d7ea4c68000');

            // 4. Send a chat message as the authorized member
            await roomPage.sendMessage('hello from paid wallet');
            await roomPage.waitForMessage('hello from paid wallet');

            // 5. Returning paid user: reload room — restores session & auto-joins with zero additional payments
            await roomPage.reload();
            await roomPage.waitUntilReady();
            await roomPage.waitForMessage('hello from paid wallet');
            expect(wallet.sentTxs.length).toBe(1);
            expect(session.errors).toEqual([]);
        } finally {
            await session.close();
        }
    });

    test('pending payment survives browser reload, handles nickname conflict, and activates without a second ETH transfer', async () => {
        const roomId = `pending-${Date.now()}`;
        const takenNick = `taken_${Date.now()}`;
        const freeNick = `free_${Date.now()}`;

        // Seed `takenNick` via first wallet
        const seedSession = await createIsolatedPageSession(browser);
        try {
            const seedOnboarding = new ChatOnboardingPage(
                seedSession.page,
                baseUrl()
            );
            await seedOnboarding.onboardAndEnterRoom(roomId, {
                nickname: takenNick,
            });
        } finally {
            await seedSession.close();
        }

        const session = await createIsolatedPageSession(browser);
        try {
            const wallet = await installMockWallet(session.page, {
                nextTxStatus: 'pending',
            });
            const onboarding = new ChatOnboardingPage(session.page, baseUrl());
            const roomPage = new ChatRoomPage(session.page, baseUrl());

            await onboarding.openLanding(roomId);
            await onboarding.connectWallet();
            await onboarding.waitForConnectedWallet(wallet.address);
            await onboarding.enterNickname(takenNick);
            await onboarding.payAndUnlock();

            // Polling exhausts while tx is still pending -> shows pending notice & persists txHash
            await onboarding.waitForNotice('pending confirmation', 15_000);
            expect(wallet.sentTxs.length).toBe(1);
            const savedTxHash = wallet.sentTxs[0]!.hash;

            // Reload page: pending txHash banner is restored from localStorage
            await onboarding.reload();
            await onboarding.waitForNotice(
                `Pending payment (${savedTxHash.slice(0, 10)}`
            );

            // Transaction confirms onchain, but `takenNick` is owned by seedSession -> NicknameTaken without 2nd transfer!
            await wallet.setTxStatus(savedTxHash, 'confirmed');
            await onboarding.enterNickname(takenNick);
            await onboarding.payAndUnlock();
            await onboarding.waitForNotice('already registered');
            expect(wallet.sentTxs.length).toBe(1);

            // User picks `freeNick` and clicks Pay & Unlock Chat -> reuses savedTxHash, activates, and enters room!
            await onboarding.enterNickname(freeNick);
            await onboarding.payAndUnlock();
            await roomPage.waitUntilReady();
            expect(roomPage.currentUrl()).toBe(`${baseUrl()}/chat/${roomId}`);
            expect(wallet.sentTxs.length).toBe(1);
            expect(session.errors).toEqual([]);
        } finally {
            await session.close();
        }
    });

    test('wrong chain, rejected signature, RPC failure, and reverted payment surface actionable errors cleanly', async () => {
        const roomId = `errors-${Date.now()}`;
        const session = await createIsolatedPageSession(browser);

        try {
            const wallet = await installMockWallet(session.page, {
                initialChainIdHex: '0x2105', // Base instead of Mainnet
                rejectChainSwitch: true,
            });
            const onboarding = new ChatOnboardingPage(session.page, baseUrl());
            const roomPage = new ChatRoomPage(session.page, baseUrl());

            await onboarding.openLanding(roomId);

            // 1. Wrong chain with rejected switch stops before signing
            await onboarding.connectWallet();
            await onboarding.waitForNotice(
                'Switch your wallet network to Ethereum Mainnet (chain ID 1)'
            );
            expect(wallet.signedMessages.length).toBe(0);
            expect(wallet.sentTxs.length).toBe(0);

            // 2. Allow chain switch, but reject SIWE signature
            wallet.setBehavior({ rejectChainSwitch: false, rejectSign: true });
            await onboarding.connectWallet();
            await onboarding.waitForNotice('User rejected message signature');

            // 3. Allow SIWE signature, then test upstream RPC failure followed by reverted tx recovery
            wallet.setBehavior({
                rejectSign: false,
                nextTxStatus: 'reverted',
            });
            await onboarding.connectWallet();
            await onboarding.waitForConnectedWallet(wallet.address);
            await onboarding.enterNickname(`rev_${Date.now()}`);

            await setMockRpcConfig(rpcUrl(), { failNextRpc: true });
            await onboarding.payAndUnlock();
            await onboarding.waitForNotice('Error:');
            expect(wallet.sentTxs.length).toBe(1);

            // Retry hits the reverted receipt -> clears saved txHash so next click can send a fresh confirmed tx
            await onboarding.payAndUnlock();
            await onboarding.waitForNotice('reverted');
            expect(wallet.sentTxs.length).toBe(1);

            // Fresh confirmed payment succeeds
            wallet.setBehavior({ nextTxStatus: 'confirmed' });
            await onboarding.payAndUnlock();
            await roomPage.waitUntilReady();
            expect(wallet.sentTxs.length).toBe(2);
            expect(session.errors).toEqual([]);
        } finally {
            await session.close();
        }
    });

    test('anonymous and unpaid clients cannot open room HTML or WebSocket, and SQLite state persists across server restart', async () => {
        // 1. Anonymous HTTP GET /chat/general returns 303 redirect (not room HTML)
        const anonRoomRes = await fetch(`${baseUrl()}/chat/general`, {
            redirect: 'manual',
        });
        expect(anonRoomRes.status).toBe(303);
        expect(anonRoomRes.headers.get('location')).toBe('/chat?room=general');

        // 2. Anonymous WebSocket upgrade in isolated browser context fails immediately without delivering room frames
        const anonSession = await createIsolatedPageSession(browser);
        try {
            const anonOnboarding = new ChatOnboardingPage(
                anonSession.page,
                baseUrl()
            );
            await anonOnboarding.openLanding();
            const wsOutcome =
                await anonOnboarding.attemptAnonymousWebSocket('general');
            expect(wsOutcome).toEqual({ opened: false, messages: 0 });
        } finally {
            await anonSession.close();
        }

        // 3. Dedicated persistent BASE_PATH server restart test (with custom Sepolia config)
        const persistentDir = fs.mkdtempSync(
            path.join(os.tmpdir(), 'e2e_persist_db_')
        );
        const dedicatedRpc = await startMockEthRpcServer('0xaa36a7'); // Sepolia (11155111)
        const customEnv = {
            ETH_CHAIN_ID: '11155111',
            MIN_PAYMENT_WEI: '0x71afd498d0000', // 0.002 ETH
            ACCESS_DURATION_SECS: '604800', // 7 days
        };

        let srv = await startServer({
            baseDir: persistentDir,
            keepBaseDirOnStop: true,
            rpcUrl: dedicatedRpc.url,
            envOverrides: customEnv,
            skipBuild: true,
        });

        const session = await createIsolatedPageSession(browser);
        const roomSlug = `persist-${Date.now()}`;
        const nick = `sepolia_${Date.now()}`;

        try {
            const srv1BaseUrl = `http://127.0.0.1:${srv.port}`;
            const wallet = await installMockWallet(session.page, {
                rpcUrl: dedicatedRpc.url,
                initialChainIdHex: '0x1', // Starts on Mainnet -> auto-switches to Sepolia (0xaa36a7)
            });
            const onboarding1 = new ChatOnboardingPage(
                session.page,
                srv1BaseUrl
            );
            const room1 = new ChatRoomPage(session.page, srv1BaseUrl);

            await onboarding1.openRoomExpectingRedirect(roomSlug);
            const htmlText = await onboarding1.htmlContent();
            expect(htmlText).toContain('Sepolia Testnet');
            expect(htmlText).toContain('0.002 ETH');
            expect(htmlText).toContain('7 days');

            await onboarding1.connectWallet();
            await onboarding1.waitForConnectedWallet(wallet.address);
            await onboarding1.enterNickname(nick);
            await onboarding1.payAndUnlock();

            await room1.waitUntilReady();
            expect(wallet.sentTxs[0]?.value).toBe('0x71afd498d0000');

            await room1.sendMessage('persisted across restart');
            await room1.waitForMessage('persisted across restart');

            const cookies = await room1.cookies();
            const savedCookieValue =
                cookies.find((c) => c.name === 'month_session')?.value ?? '';
            expect(savedCookieValue.length).toBeGreaterThan(16);

            // Stop server 1 and start server 2 against the SAME persistent SQLite directory
            await srv.stop();
            srv = await startServer({
                baseDir: persistentDir,
                keepBaseDirOnStop: true,
                rpcUrl: dedicatedRpc.url,
                envOverrides: customEnv,
                skipBuild: true,
            });

            const srv2BaseUrl = `http://127.0.0.1:${srv.port}`;
            const room2 = new ChatRoomPage(session.page, srv2BaseUrl);
            await room2.setSessionCookie(savedCookieValue, srv2BaseUrl);
            await room2.openRoom(roomSlug);
            await room2.waitForMessage('persisted across restart');
            expect(wallet.sentTxs.length).toBe(1);
            expect(session.errors).toEqual([]);
        } finally {
            await session.close();
            await srv.stop();
            await dedicatedRpc.stop();
            fs.rmSync(persistentDir, { recursive: true, force: true });
        }
    });

    test('HTTPS reverse proxy preserves Secure HttpOnly session cookie and upgrades wss:// chat WebSocket', async () => {
        const proxy = await startTlsReverseProxy(
            Number(process.env.E2E_SERVER_PORT)
        );
        const session = await createIsolatedPageSession(browser);
        const roomId = `tls-wss-${Date.now()}`;

        try {
            const onboarding = new ChatOnboardingPage(session.page, proxy.url);

            // Anonymous wss:// upgrade through TLS proxy is rejected cleanly
            await onboarding.openLanding();
            const anonWss =
                await onboarding.attemptAnonymousWebSocket('general');
            expect(anonWss).toEqual({ opened: false, messages: 0 });

            // Full SIWE + ETH payment + Secure cookie + wss:// auto-join over https://
            const { roomPage, wallet } =
                await onboarding.onboardAndEnterRoom(roomId);
            expect(roomPage.currentUrl()).toBe(`${proxy.url}/chat/${roomId}`);
            expect(wallet.sentTxs.length).toBe(1);

            const cookies = await roomPage.cookies();
            const sessionCookie = cookies.find(
                (c) => c.name === 'month_session'
            );
            expect(sessionCookie).toBeDefined();
            expect(sessionCookie?.secure).toBe(true);
            expect(sessionCookie?.httpOnly).toBe(true);
            expect(sessionCookie?.sameSite).toBe('Lax');

            // Binary protobuf messaging over wss://
            await roomPage.sendMessage('encrypted transport over wss');
            await roomPage.waitForMessage('encrypted transport over wss');
            expect(session.errors).toEqual([]);
        } finally {
            await session.close();
            await proxy.stop();
        }
    });
});
