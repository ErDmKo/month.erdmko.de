/** Exercise the shipped ADVANCED bundles, not just unoptimized TS modules. */
import puppeteer, { Browser, Page } from 'puppeteer';
import { PAGE_TIMEOUT_MS } from '../helpers/constants';

let browser: Browser;
let page: Page;
let errors: string[];

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
    page = await browser.newPage();
    errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
});

afterEach(async () => {
    await page.close();
});

async function open(path: string) {
    const response = await page.goto(`${baseUrl()}${path}`, {
        waitUntil: 'load',
        timeout: PAGE_TIMEOUT_MS,
    });
    expect(response?.status()).toBe(200);
}

async function clickButton(text: string) {
    await page.$$eval(
        'button',
        (buttons, label) => {
            const button = buttons.find((el) => el.textContent === label);
            if (!button) throw new Error(`Button not found: ${label}`);
            button.click();
        },
        text
    );
}

async function joinChat(roomId: string) {
    await open(`/chat/${roomId}`);
    await page.waitForSelector('.js-chat input[type="text"]');
    await page.type('.js-chat input[type="text"]', 'closure-test');
    await page.waitForFunction(() => {
        const button = Array.from(document.querySelectorAll('button')).find(
            (el) => el.textContent === 'Join room'
        );
        return button && !button.disabled;
    });
    await clickButton('Join room');
    await page.waitForSelector('.js-chat textarea', { visible: true });
}

describe('optimized browser bundles', () => {
    test('month mounts, starts its reactive game, and disposes it on exit', async () => {
        await open('/month');
        await page.waitForSelector('.js-month button');
        await clickButton('Запустить тренажер');
        await page.waitForSelector('.month-game');
        expect(
            await page.$$eval('.month-game button', (els) => els.length)
        ).toBeGreaterThanOrEqual(12);
        await clickButton('Выйти из тренажера');
        expect(await page.$('.month-game')).toBeNull();
        await clickButton('Запустить тренажер');
        await page.waitForSelector('.month-game');
        expect(errors).toEqual([]);
    });

    test('tennis updates signal-bound scores and its keyed history', async () => {
        await open('/tennis');
        await page.waitForSelector('.js-tennis button');
        await clickButton('+1 first');
        await page.waitForFunction(() =>
            document.querySelector('.js-tennis')?.textContent?.includes('1:0')
        );
        await clickButton('+1 second');
        await page.waitForFunction(() =>
            document.querySelector('.js-tennis')?.textContent?.includes('1:1')
        );
        expect(
            await page.$$eval('.js-tennis .log span > div', (els) => els.length)
        ).toBe(2);
        await clickButton('Back');
        expect(
            await page.$$eval('.js-tennis .log span > div', (els) => els.length)
        ).toBe(1);
        expect(errors).toEqual([]);
    });

    test('tetris retains string-keyed keyboard and phone controls', async () => {
        await open('/tetris');
        await page.waitForSelector('.js-tetris canvas');
        await page.keyboard.press('Space');
        await page.waitForFunction(() =>
            document
                .querySelector('.js-tetris')
                ?.textContent?.includes('Score: 0')
        );
        await page.keyboard.press('a');
        await clickButton('Rotate Right (E)');
        await clickButton('Down (S)');
        expect(errors).toEqual([]);
    });

    test('tennis preserves speech grammar words and recognized command lookup', async () => {
        await page.evaluateOnNewDocument(() => {
            const ctx = window as any;
            ctx.webkitSpeechGrammarList = class {
                addFromString(value: string) {
                    ctx.__closureGrammar = value;
                }
            };
            ctx.webkitSpeechRecognition = class {
                constructor() {
                    ctx.__closureRecognition = this;
                }
                start() {}
                stop() {}
            };
        });
        await open('/tennis');
        await page.waitForSelector('.js-tennis button');
        const grammar = await page.evaluate(
            () => (window as any).__closureGrammar as string
        );
        expect(grammar).toContain('first');
        expect(grammar).toContain('second');
        await page.evaluate(() => {
            (window as any).__closureRecognition.onresult({
                resultIndex: 0,
                results: [[{ transcript: 'first second' }]],
            });
        });
        await page.waitForFunction(() =>
            document.querySelector('.js-tennis')?.textContent?.includes('1:1')
        );
        expect(errors).toEqual([]);
    });

    test('snowflake keeps native canvas and explicit Window APIs intact', async () => {
        await open('/');
        if (!(await page.$('.js-header canvas'))) {
            // Snow is seasonal; explicitly exercise its production bundle.
            await page.addScriptTag({
                url: `${baseUrl()}/static/js/snowflake-bundle.js`,
            });
            await page.evaluate(() => window.dispatchEvent(new Event('load')));
        }
        await page.waitForSelector('.js-header canvas');
        const dimensions = await page.$eval('.js-header canvas', (el) => {
            const canvas = el as HTMLCanvasElement;
            return [canvas.width, canvas.height];
        });
        expect(dimensions.every((value) => value > 0)).toBe(true);
        expect(errors).toEqual([]);
    });

    test('chat preserves dataset room IDs and binary message exchange', async () => {
        const roomId = `closure-${Date.now()}`;
        await joinChat(roomId);
        expect(
            await page.evaluate(
                (id) => localStorage.getItem(`chat-nickname-${id}`),
                roomId
            )
        ).toBe('closure-test');
        await page.type('.js-chat textarea', 'advanced message');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() =>
            document
                .querySelector('.js-chat ul[aria-live]')
                ?.textContent?.includes('advanced message')
        );
        expect(errors).toEqual([]);
    });

    test('chat voice preserves native media and WebRTC option properties', async () => {
        await joinChat(`closure-voice-${Date.now()}`);
        await clickButton('Join voice');
        await page.waitForFunction(() =>
            Array.from(document.querySelectorAll('button')).some(
                (el) => el.textContent === 'Mute' && !el.hidden
            )
        );
        await clickButton('Mute');
        await page.waitForFunction(() =>
            Array.from(document.querySelectorAll('button')).some(
                (el) => el.textContent === 'Unmute'
            )
        );
        await clickButton('Leave');
        expect(errors).toEqual([]);
    });
});
