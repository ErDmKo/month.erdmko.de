import type { Browser, BrowserContext, Cookie, Page } from 'puppeteer';
import { PAGE_TIMEOUT_MS } from '../helpers/constants';

export interface IsolatedPageSession {
    readonly context: BrowserContext;
    readonly page: Page;
    readonly errors: string[];
    close: () => Promise<void>;
}

/**
 * Create an incognito BrowserContext + Page so cookies (`month_session`) and
 * `localStorage` never leak across E2E test cases.
 */
export async function createIsolatedPageSession(
    browser: Browser
): Promise<IsolatedPageSession> {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    return {
        context,
        page,
        errors,
        close: () => context.close(),
    };
}

export abstract class BasePage {
    constructor(
        protected readonly page: Page,
        protected readonly baseUrl: string
    ) {}

    async gotoPath(path: string): Promise<number> {
        const res = await this.page.goto(`${this.baseUrl}${path}`, {
            waitUntil: 'load',
            timeout: PAGE_TIMEOUT_MS,
        });
        return res?.status() ?? 0;
    }

    async reload(): Promise<void> {
        await this.page.reload({
            waitUntil: 'load',
            timeout: PAGE_TIMEOUT_MS,
        });
    }

    currentUrl(): string {
        return this.page.url();
    }

    async htmlContent(): Promise<string> {
        return this.page.content();
    }

    async cookies(): Promise<Cookie[]> {
        return this.page.cookies(this.baseUrl);
    }

    async setSessionCookie(
        token: string,
        targetBaseUrl?: string
    ): Promise<void> {
        await this.page.setCookie({
            name: 'month_session',
            value: token,
            url: targetBaseUrl ?? this.baseUrl,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
        });
    }

    async localStorageItem(key: string): Promise<string | null> {
        return this.page.evaluate((k) => localStorage.getItem(k), key);
    }

    protected async clickButton(
        label: string,
        timeoutMs = PAGE_TIMEOUT_MS
    ): Promise<void> {
        await this.page.waitForFunction(
            (expected) =>
                Array.from(document.querySelectorAll('button')).some(
                    (b) =>
                        b.textContent === expected && !b.hidden && !b.disabled
                ),
            { timeout: timeoutMs },
            label
        );
        await this.page.$$eval(
            'button',
            (buttons, expected) => {
                const btn = buttons.find(
                    (b) =>
                        b.textContent === expected && !b.hidden && !b.disabled
                );
                if (!btn) {
                    throw new Error(`Enabled button not found: ${expected}`);
                }
                btn.click();
            },
            label
        );
    }

    protected async waitForContainerText(
        containerSelector: string,
        expectedText: string,
        timeoutMs = PAGE_TIMEOUT_MS
    ): Promise<void> {
        await this.page.waitForFunction(
            (sel, text) =>
                Boolean(
                    document.querySelector(sel)?.textContent?.includes(text)
                ),
            { timeout: timeoutMs },
            containerSelector,
            expectedText
        );
    }
}
