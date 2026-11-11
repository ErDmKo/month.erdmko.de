import * as crypto from 'crypto';
import type { Page } from 'puppeteer';
import {
    signPersonalMessage,
    testPrivateKey,
    walletAddressFromPrivateKey,
} from './eth-crypto';
import { registerMockRpcTx } from './mock-rpc';
import type { MockTxStatus } from './mock-rpc';

export interface WalletBehaviorOptions {
    seed?: number;
    rpcUrl?: string;
    initialChainIdHex?: string;
    rejectChainSwitch?: boolean;
    rejectSign?: boolean;
    rejectTransfer?: boolean;
    nextTxStatus?: MockTxStatus;
}

export interface InstalledMockWallet {
    address: string;
    sentTxs: Array<{ hash: string; from: string; to: string; value: string }>;
    signedMessages: string[];
    setBehavior: (patch: Partial<WalletBehaviorOptions>) => void;
    setTxStatus: (txHash: string, status: MockTxStatus) => Promise<void>;
    emitChainChanged: (page: Page, chainIdHex: string) => Promise<void>;
    emitAccountsChanged: (page: Page, accounts: string[]) => Promise<void>;
}

export async function installMockWallet(
    page: Page,
    options: WalletBehaviorOptions = {}
): Promise<InstalledMockWallet> {
    const seed =
        options.seed ?? crypto.randomInt(1_000_000, 281_474_976_710_655);
    const privKey = testPrivateKey(seed);
    const address = walletAddressFromPrivateKey(privKey);
    const rpcUrl =
        options.rpcUrl ?? `http://127.0.0.1:${process.env.E2E_RPC_PORT}`;

    const state = {
        chainIdHex: options.initialChainIdHex ?? '0x1',
        rejectChainSwitch: options.rejectChainSwitch ?? false,
        rejectSign: options.rejectSign ?? false,
        rejectTransfer: options.rejectTransfer ?? false,
        nextTxStatus: (options.nextTxStatus ?? 'confirmed') as MockTxStatus,
    };

    const sentTxs: Array<{
        hash: string;
        from: string;
        to: string;
        value: string;
    }> = [];
    const signedMessages: string[] = [];

    await page.exposeFunction(
        '__e2eWalletRpc',
        async (method: string, params?: unknown[]) => {
            if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
                return [address];
            }
            if (method === 'eth_chainId') {
                return state.chainIdHex;
            }
            if (method === 'wallet_switchEthereumChain') {
                if (state.rejectChainSwitch) {
                    throw new Error('User rejected chain switch.');
                }
                const target = (params?.[0] as { chainId?: string } | undefined)
                    ?.chainId;
                if (target) {
                    state.chainIdHex = target.toLowerCase();
                }
                return null;
            }
            if (method === 'personal_sign') {
                if (state.rejectSign) {
                    throw new Error('User rejected message signature.');
                }
                const msg = String(params?.[0] ?? '');
                signedMessages.push(msg);
                return signPersonalMessage(privKey, msg);
            }
            if (method === 'eth_sendTransaction') {
                if (state.rejectTransfer) {
                    throw new Error('User rejected transaction.');
                }
                const txReq = (params?.[0] ?? {}) as {
                    from?: string;
                    to?: string;
                    value?: string;
                };
                const txHash = `0x${crypto.randomBytes(32).toString('hex')}`;
                const record = {
                    hash: txHash,
                    from: (txReq.from ?? address).toLowerCase(),
                    to: (txReq.to ?? '').toLowerCase(),
                    value: (txReq.value ?? '0x0').toLowerCase(),
                };
                sentTxs.push(record);
                await registerMockRpcTx(rpcUrl, {
                    ...record,
                    status: state.nextTxStatus,
                });
                return txHash;
            }
            throw new Error(`Unsupported mock wallet method: ${method}`);
        }
    );

    await page.evaluateOnNewDocument(() => {
        const listeners: Record<
            string,
            Array<(...args: unknown[]) => void>
        > = {};
        (window as any).__e2eEmitWalletEvent = (
            event: string,
            payload: unknown
        ) => {
            for (const fn of listeners[event] ?? []) {
                fn(payload);
            }
        };
        (window as any).ethereum = {
            request: (args: { method: string; params?: unknown[] }) =>
                (window as any).__e2eWalletRpc(args.method, args.params),
            on: (event: string, cb: (...args: unknown[]) => void) => {
                (listeners[event] ??= []).push(cb);
            },
        };
    });

    return {
        address,
        sentTxs,
        signedMessages,
        setBehavior: (patch) => {
            if (patch.initialChainIdHex !== undefined) {
                state.chainIdHex = patch.initialChainIdHex;
            }
            if (patch.rejectChainSwitch !== undefined) {
                state.rejectChainSwitch = patch.rejectChainSwitch;
            }
            if (patch.rejectSign !== undefined) {
                state.rejectSign = patch.rejectSign;
            }
            if (patch.rejectTransfer !== undefined) {
                state.rejectTransfer = patch.rejectTransfer;
            }
            if (patch.nextTxStatus !== undefined) {
                state.nextTxStatus = patch.nextTxStatus;
            }
        },
        setTxStatus: async (txHash: string, status: MockTxStatus) => {
            const existing = sentTxs.find(
                (t) => t.hash.toLowerCase() === txHash.toLowerCase()
            );
            if (!existing) {
                throw new Error(`Unknown txHash ${txHash}`);
            }
            await registerMockRpcTx(rpcUrl, { ...existing, status });
        },
        emitChainChanged: async (targetPage: Page, chainIdHex: string) => {
            state.chainIdHex = chainIdHex;
            await targetPage.evaluate(
                (hex) =>
                    (window as any).__e2eEmitWalletEvent?.('chainChanged', hex),
                chainIdHex
            );
        },
        emitAccountsChanged: async (targetPage: Page, accounts: string[]) => {
            await targetPage.evaluate(
                (accs) =>
                    (window as any).__e2eEmitWalletEvent?.(
                        'accountsChanged',
                        accs
                    ),
                accounts
            );
        },
    };
}
