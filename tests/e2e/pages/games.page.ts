import type { Page } from 'puppeteer';
import { PAGE_TIMEOUT_MS } from '../helpers/constants';
import { BasePage } from './base.page';

export class MonthGamePage extends BasePage {
    constructor(page: Page, baseUrl: string) {
        super(page, baseUrl);
    }

    async open(): Promise<void> {
        const status = await this.gotoPath('/month');
        if (status !== 200)
            throw new Error(`Expected 200 on /month, got ${status}`);
        await this.page.waitForFunction(
            () => Boolean(document.querySelector('.js-month button')),
            { timeout: PAGE_TIMEOUT_MS }
        );
    }

    async startTrainer(): Promise<void> {
        await this.clickButton('Запустить тренажер');
        await this.page.waitForFunction(
            () => Boolean(document.querySelector('.month-game')),
            { timeout: PAGE_TIMEOUT_MS }
        );
    }

    async exitTrainer(): Promise<void> {
        await this.clickButton('Выйти из тренажера');
    }

    async isGameMounted(): Promise<boolean> {
        return this.page.evaluate(() =>
            Boolean(document.querySelector('.month-game'))
        );
    }

    async optionButtonCount(): Promise<number> {
        return this.page.$$eval('.month-game button', (els) => els.length);
    }
}

export class TennisGamePage extends BasePage {
    constructor(page: Page, baseUrl: string) {
        super(page, baseUrl);
    }

    async installMockSpeechRecognition(): Promise<void> {
        await this.page.evaluateOnNewDocument(() => {
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
    }

    async open(): Promise<void> {
        const status = await this.gotoPath('/tennis');
        if (status !== 200)
            throw new Error(`Expected 200 on /tennis, got ${status}`);
        await this.page.waitForFunction(
            () => Boolean(document.querySelector('.js-tennis button')),
            { timeout: PAGE_TIMEOUT_MS }
        );
    }

    async scoreFirst(): Promise<void> {
        await this.clickButton('+1 first');
    }

    async scoreSecond(): Promise<void> {
        await this.clickButton('+1 second');
    }

    async undoLastPoint(): Promise<void> {
        await this.clickButton('Back');
    }

    async waitForScore(score: string): Promise<void> {
        await this.waitForContainerText('.js-tennis', score);
    }

    async historyEntryCount(): Promise<number> {
        return this.page.$$eval(
            '.js-tennis .log span > div',
            (els) => els.length
        );
    }

    async capturedSpeechGrammar(): Promise<string> {
        return this.page.evaluate(
            () => (window as any).__closureGrammar as string
        );
    }

    async emitSpeechTranscript(transcript: string): Promise<void> {
        await this.page.evaluate((t) => {
            (window as any).__closureRecognition.onresult({
                resultIndex: 0,
                results: [[{ transcript: t }]],
            });
        }, transcript);
    }
}

export class TetrisGamePage extends BasePage {
    constructor(page: Page, baseUrl: string) {
        super(page, baseUrl);
    }

    async open(): Promise<void> {
        const status = await this.gotoPath('/tetris');
        if (status !== 200)
            throw new Error(`Expected 200 on /tetris, got ${status}`);
        await this.page.waitForFunction(
            () => Boolean(document.querySelector('.js-tetris canvas')),
            { timeout: PAGE_TIMEOUT_MS }
        );
    }

    async startGameWithSpace(): Promise<void> {
        await this.page.keyboard.press('Space');
        await this.waitForContainerText('.js-tetris', 'Score: 0');
    }

    async moveLeftWithKey(): Promise<void> {
        await this.page.keyboard.press('a');
    }

    async rotateRightWithButton(): Promise<void> {
        await this.clickButton('Rotate Right (E)');
    }

    async softDropWithButton(): Promise<void> {
        await this.clickButton('Down (S)');
    }
}

export class HomePage extends BasePage {
    constructor(page: Page, baseUrl: string) {
        super(page, baseUrl);
    }

    async openEnsuringSnowflakeBundle(): Promise<void> {
        const status = await this.gotoPath('/');
        if (status !== 200) throw new Error(`Expected 200 on /, got ${status}`);
        const hasCanvas = await this.page.evaluate(() =>
            Boolean(document.querySelector('.js-header canvas'))
        );
        if (!hasCanvas) {
            await this.page.addScriptTag({
                url: `${this.baseUrl}/static/js/snowflake-bundle.js`,
            });
            await this.page.evaluate(() =>
                window.dispatchEvent(new Event('load'))
            );
        }
        await this.page.waitForFunction(
            () => Boolean(document.querySelector('.js-header canvas')),
            { timeout: PAGE_TIMEOUT_MS }
        );
    }

    async snowflakeCanvasDimensions(): Promise<[number, number]> {
        return this.page.$eval('.js-header canvas', (el) => {
            const canvas = el as HTMLCanvasElement;
            return [canvas.width, canvas.height] as [number, number];
        });
    }
}
