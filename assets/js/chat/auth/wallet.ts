import {
    isArray,
    isFunction,
    isString,
    objectStruct,
    pipe,
    taskMap,
    trim,
    validate,
} from '@month/utils';
import type { Task } from '@month/utils';

export const RECIPIENT_WALLET_ADDRESS =
    '0xEFF121F128e0e64C0E64AE8Eb6eB042a0E5Aa81c';
export const DEFAULT_PAYMENT_VALUE_HEX = '0x38d7ea4c68000';

const FIRST_ACCOUNT_INDEX = 0 as const;
const WIN_ETHEREUM = 0 as const;
const PROVIDER_REQUEST = 0 as const;
const WALLET_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export type EthereumRequestArgs = {
    readonly ['method']: string;
    readonly ['params']?: readonly unknown[];
};

export type EthereumProvider = {
    readonly ['request']: (args: EthereumRequestArgs) => Promise<unknown>;
};

declare global {
    interface Window {
        ['ethereum']?: EthereumProvider;
    }
}

const windowEthereumStruct = objectStruct([
    'ethereum',
    objectStruct(['request', isFunction<EthereumProvider['request']>]),
]);

export const normalizeWalletAddress = (raw: string): string => {
    const trimmed = raw.trim();
    if (!WALLET_ADDRESS_RE.test(trimmed)) {
        throw new Error('Invalid Ethereum wallet address.');
    }
    return trimmed.toLowerCase();
};

export const normalizeTxHash = (raw: string): string => {
    const trimmed = raw.trim();
    if (!TX_HASH_RE.test(trimmed)) {
        throw new Error('Invalid Ethereum transaction hash.');
    }
    return trimmed.toLowerCase();
};

export const buildSiweMessage = (
    ctx: Window,
    walletAddress: string,
    nonce: string,
    chainId: number = 1
): string => {
    const normalizedWallet = normalizeWalletAddress(walletAddress);
    const domain = ctx.location?.host || 'erdmko.dev';
    const uri =
        ctx.location?.href ||
        `${ctx.location?.protocol || 'https:'}//${domain}/`;
    const issuedAt = new ctx.Date().toISOString();
    return (
        `${domain} wants you to sign in with your Ethereum account:\n` +
        `${normalizedWallet}\n\n` +
        `Sign in to month.erdmko.de chat.\n\n` +
        `URI: ${uri}\n` +
        `Version: 1\n` +
        `Chain ID: ${chainId}\n` +
        `Nonce: ${nonce}\n` +
        `Issued At: ${issuedAt}`
    );
};

const ethereumRequestTask =
    (ctx: Window, method: string, params?: readonly unknown[]): Task<unknown> =>
    (resolve, reject) => {
        const eth = validate(ctx, windowEthereumStruct);
        if (!eth) {
            reject(
                new Error(
                    'No Ethereum wallet detected (window.ethereum is missing).'
                )
            );
            return;
        }
        const request = eth[WIN_ETHEREUM][PROVIDER_REQUEST];
        const args: EthereumRequestArgs =
            params === undefined
                ? { ['method']: method }
                : { ['method']: method, ['params']: params };
        request(args).then(resolve, reject);
    };

const extractFirstAccount = (result: unknown): string => {
    const accounts = isArray(result);
    const first = accounts
        ? validate(accounts[FIRST_ACCOUNT_INDEX], isString, trim)
        : undefined;
    if (!first) {
        throw new Error('No wallet account returned by provider.');
    }
    return normalizeWalletAddress(first);
};

const extractSignature = (result: unknown): string => {
    const sig = validate(result, isString, trim);
    if (!sig) {
        throw new Error('Wallet did not return a valid signature.');
    }
    return sig;
};

const extractTxHash = (result: unknown): string => {
    const txHash = validate(result, isString, trim);
    if (!txHash) {
        throw new Error('Wallet did not return a transaction hash.');
    }
    return normalizeTxHash(txHash);
};

export const requestAccountsTask = (ctx: Window): Task<string> =>
    pipe(
        ethereumRequestTask(ctx, 'eth_requestAccounts'),
        taskMap(extractFirstAccount)
    );

export const signSiweMessageTask = (
    ctx: Window,
    walletAddress: string,
    message: string
): Task<string> =>
    pipe(
        ethereumRequestTask(ctx, 'personal_sign', [
            message,
            normalizeWalletAddress(walletAddress),
        ]),
        taskMap(extractSignature)
    );

export const sendPaymentTransactionTask = (
    ctx: Window,
    fromWallet: string,
    toWallet: string = RECIPIENT_WALLET_ADDRESS,
    valueHex: string = DEFAULT_PAYMENT_VALUE_HEX
): Task<string> =>
    pipe(
        ethereumRequestTask(ctx, 'eth_sendTransaction', [
            {
                ['from']: normalizeWalletAddress(fromWallet),
                ['to']: normalizeWalletAddress(toWallet),
                ['value']: valueHex,
            },
        ]),
        taskMap(extractTxHash)
    );
