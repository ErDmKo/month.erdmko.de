/** Exercise the shipped ADVANCED bundles strictly through Page Objects. */
import puppeteer, { Browser } from 'puppeteer';
import {
    ChatOnboardingPage,
    createIsolatedPageSession,
    HomePage,
    MonthGamePage,
    TennisGamePage,
    TetrisGamePage,
} from '../pages';
import type { IsolatedPageSession } from '../pages';

let browser: Browser;
let session: IsolatedPageSession;

const baseUrl = () => `http://127.0.0.1:${process.env.E2E_SERVER_PORT}`;

beforeAll(async () => {
    browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
        ],
    });
});

afterAll(async () => {
    await browser.close();
});

beforeEach(async () => {
    session = await createIsolatedPageSession(browser);
});

afterEach(async () => {
    await session.close();
});

describe('optimized browser bundles', () => {
    test('month mounts, starts its reactive game, and disposes it on exit', async () => {
        const month = new MonthGamePage(session.page, baseUrl());
        await month.open();
        await month.startTrainer();
        expect(await month.optionButtonCount()).toBeGreaterThanOrEqual(12);
        await month.exitTrainer();
        expect(await month.isGameMounted()).toBe(false);
        await month.startTrainer();
        expect(session.errors).toEqual([]);
    });

    test('tennis updates signal-bound scores and its keyed history', async () => {
        const tennis = new TennisGamePage(session.page, baseUrl());
        await tennis.open();
        await tennis.scoreFirst();
        await tennis.waitForScore('1:0');
        await tennis.scoreSecond();
        await tennis.waitForScore('1:1');
        expect(await tennis.historyEntryCount()).toBe(2);
        await tennis.undoLastPoint();
        expect(await tennis.historyEntryCount()).toBe(1);
        expect(session.errors).toEqual([]);
    });

    test('tetris retains string-keyed keyboard and phone controls', async () => {
        const tetris = new TetrisGamePage(session.page, baseUrl());
        await tetris.open();
        await tetris.startGameWithSpace();
        await tetris.moveLeftWithKey();
        await tetris.rotateRightWithButton();
        await tetris.softDropWithButton();
        expect(session.errors).toEqual([]);
    });

    test('tennis preserves speech grammar words and recognized command lookup', async () => {
        const tennis = new TennisGamePage(session.page, baseUrl());
        await tennis.installMockSpeechRecognition();
        await tennis.open();
        const grammar = await tennis.capturedSpeechGrammar();
        expect(grammar).toContain('first');
        expect(grammar).toContain('second');
        await tennis.emitSpeechTranscript('first second');
        await tennis.waitForScore('1:1');
        expect(session.errors).toEqual([]);
    });

    test('snowflake keeps native canvas and explicit Window APIs intact', async () => {
        const home = new HomePage(session.page, baseUrl());
        await home.openEnsuringSnowflakeBundle();
        const dimensions = await home.snowflakeCanvasDimensions();
        expect(dimensions.every((value) => value > 0)).toBe(true);
        expect(session.errors).toEqual([]);
    });

    test('chat preserves dataset room IDs and binary message exchange', async () => {
        const roomId = `closure-${Date.now()}`;
        const nick = `closure_${Date.now()}`;
        const onboarding = new ChatOnboardingPage(session.page, baseUrl());
        const { roomPage } = await onboarding.onboardAndEnterRoom(roomId, {
            nickname: nick,
        });

        expect(await roomPage.storedRoomNickname(roomId)).toBe(nick);
        await roomPage.sendMessage('advanced message');
        await roomPage.waitForMessage('advanced message');
        expect(session.errors).toEqual([]);
    });

    test('chat voice preserves native media and WebRTC option properties', async () => {
        const onboarding = new ChatOnboardingPage(session.page, baseUrl());
        const { roomPage } = await onboarding.onboardAndEnterRoom(
            `closure-voice-${Date.now()}`
        );
        await roomPage.joinVoice();
        await roomPage.muteVoice();
        await roomPage.leaveVoice();
        expect(session.errors).toEqual([]);
    });
});
