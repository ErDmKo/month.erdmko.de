import type { Page } from 'puppeteer';
import { PAGE_TIMEOUT_MS } from '../helpers/constants';
import { installMockWallet } from '../helpers/wallet';
import type {
    InstalledMockWallet,
    WalletBehaviorOptions,
} from '../helpers/wallet';
import { BasePage } from './base.page';
import { ChatRoomPage } from './chat-room.page';

const ONBOARDING_ROOT = '.js-chat-onboarding';
const NICKNAME_INPUT = '.js-chat-onboarding form input[type="text"]';

export class ChatOnboardingPage extends BasePage {
    constructor(page: Page, baseUrl: string) {
        super(page, baseUrl);
    }

    async openLanding(roomQuery?: string): Promise<number> {
        const suffix = roomQuery
            ? `/chat?room=${encodeURIComponent(roomQuery)}`
            : '/chat';
        return this.gotoPath(suffix);
    }

    async openRoomExpectingRedirect(roomId: string): Promise<void> {
        await this.gotoPath(`/chat/${encodeURIComponent(roomId)}`);
    }

    async connectWallet(): Promise<void> {
        await this.clickButton('Connect Wallet');
    }

    async waitForConnectedWallet(walletAddress: string): Promise<void> {
        await this.waitForContainerText(ONBOARDING_ROOT, walletAddress);
    }

    async enterNickname(nickname: string): Promise<void> {
        await this.page.waitForFunction(
            (sel) => {
                const input = document.querySelector(
                    sel
                ) as HTMLInputElement | null;
                return Boolean(input && !input.closest('[hidden]'));
            },
            { timeout: PAGE_TIMEOUT_MS },
            NICKNAME_INPUT
        );
        await this.page.$eval(NICKNAME_INPUT, (el) => {
            (el as HTMLInputElement).value = '';
        });
        await this.page.type(NICKNAME_INPUT, nickname);
    }

    async payAndUnlock(): Promise<void> {
        await this.clickButton('Pay & Unlock Chat');
    }

    async waitForNotice(
        expectedSubstring: string,
        timeoutMs = PAGE_TIMEOUT_MS
    ): Promise<void> {
        await this.waitForContainerText(
            ONBOARDING_ROOT,
            expectedSubstring,
            timeoutMs
        );
    }

    async attemptAnonymousWebSocket(
        roomId: string
    ): Promise<{ opened: boolean; messages: number }> {
        return this.page.evaluate(async (targetRoom) => {
            return await new Promise<{ opened: boolean; messages: number }>(
                (resolve) => {
                    let opened = false;
                    let messages = 0;
                    const proto =
                        location.protocol === 'https:' ? 'wss:' : 'ws:';
                    const ws = new WebSocket(
                        `${proto}//${location.host}/ws/chat/${targetRoom}`
                    );
                    ws.onopen = () => {
                        opened = true;
                    };
                    ws.onmessage = () => {
                        messages += 1;
                    };
                    ws.onerror = () => resolve({ opened, messages });
                    ws.onclose = () => resolve({ opened, messages });
                }
            );
        }, roomId);
    }

    /**
     * Install a deterministic EIP-1193 wallet fixture, navigate to `/chat/{roomId}`,
     * complete SIWE sign-in + on-chain ETH payment + `/auth/claim-payment`, and return
     * the ready `ChatRoomPage`.
     */
    async onboardAndEnterRoom(
        roomId: string,
        options: WalletBehaviorOptions & { nickname?: string } = {}
    ): Promise<{
        roomPage: ChatRoomPage;
        wallet: InstalledMockWallet;
        nickname: string;
    }> {
        const wallet = await installMockWallet(this.page, options);
        const resolvedNickname =
            options.nickname ??
            `user_${wallet.address.slice(2, 10).toLowerCase()}`;

        await this.openRoomExpectingRedirect(roomId);
        await this.connectWallet();
        await this.waitForConnectedWallet(wallet.address);
        await this.enterNickname(resolvedNickname);
        await this.payAndUnlock();

        const roomPage = new ChatRoomPage(this.page, this.baseUrl);
        await roomPage.waitUntilReady();
        return { roomPage, wallet, nickname: resolvedNickname };
    }
}
