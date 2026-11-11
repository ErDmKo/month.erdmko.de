import {
    bindArg,
    bindArgs,
    cont,
    isArray,
    isFunction,
    isNumber,
    isString,
    objectStruct,
    pipe,
    taskCatch,
    taskChain,
    taskMap,
    trim,
    validate,
} from '@month/utils';
import type { Task } from '@month/utils';

export const DEFAULT_CHAIN_ID = 1;
export const RECIPIENT_WALLET_ADDRESS =
    '0xEFF121F128e0e64C0E64AE8Eb6eB042a0E5Aa81c';
export const DEFAULT_PAYMENT_VALUE_HEX = '0x38d7ea4c68000';
export const DEFAULT_ACCESS_DURATION_SECS = 30 * 24 * 60 * 60;

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
    readonly ['on']?: (
        event: string,
        listener: (...args: unknown[]) => void
    ) => void;
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

export const parseChainId = (raw: unknown): number => {
    const num = isNumber(raw);
    if (num !== undefined && num > 0) return num;
    const str = validate(raw, isString, trim);
    if (!str) return 0;
    const parsed =
        str.startsWith('0x') || str.startsWith('0X')
            ? Number.parseInt(str.slice(2), 16)
            : Number.parseInt(str, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

export const formatChainIdHex = (chainId: number): string =>
    `0x${chainId.toString(16)}`;

export const formatChainName = (chainId: number): string =>
    chainId === 1
        ? 'Ethereum Mainnet'
        : chainId === 11155111
          ? 'Sepolia'
          : `Chain ${chainId}`;

export const formatWeiAsEth = (valueHex: string): string => {
    const trimmed = valueHex.trim();
    try {
        const wei = BigInt(
            trimmed.startsWith('0x') || trimmed.startsWith('0X')
                ? trimmed
                : `0x${trimmed}`
        );
        const whole = wei / 1000000000000000000n;
        const frac = (wei % 1000000000000000000n)
            .toString()
            .padStart(18, '0')
            .replace(/0+$/, '');
        return frac ? `${whole}.${frac} ETH` : `${whole} ETH`;
    } catch {
        return '0.001 ETH';
    }
};

export const formatAccessDuration = (durationSecs: number): string => {
    const secs = durationSecs > 0 ? Math.floor(durationSecs) : 0;
    if (secs > 0 && secs % 86400 === 0) {
        const days = secs / 86400;
        return days === 1 ? '1 day' : `${days} days`;
    }
    if (secs > 0 && secs % 3600 === 0) {
        const hours = secs / 3600;
        return hours === 1 ? '1 hour' : `${hours} hours`;
    }
    if (secs > 0 && secs % 60 === 0) {
        const mins = secs / 60;
        return mins === 1 ? '1 minute' : `${mins} minutes`;
    }
    return secs === 1 ? '1 second' : `${secs} seconds`;
};

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

const chainSwitchError = (targetChainId: number): Error =>
    new Error(
        `Switch your wallet network to ${formatChainName(targetChainId)} (chain ID ${targetChainId}) to continue.`
    );

const readChainIdTask = (ctx: Window): Task<number> =>
    pipe(ethereumRequestTask(ctx, 'eth_chainId'), taskMap(parseChainId));

const assertTargetChain = (
    targetChainId: number,
    verifiedChainId: number
): number => {
    if (verifiedChainId !== 0 && verifiedChainId !== targetChainId) {
        throw chainSwitchError(targetChainId);
    }
    return targetChainId;
};

const rejectChainSwitch = (targetChainId: number): never => {
    throw chainSwitchError(targetChainId);
};

const switchToTargetChainTask = (
    ctx: Window,
    targetChainId: number,
    currentChainId: number
): Task<number> =>
    currentChainId === targetChainId
        ? cont(targetChainId)
        : pipe(
              ethereumRequestTask(ctx, 'wallet_switchEthereumChain', [
                  { ['chainId']: formatChainIdHex(targetChainId) },
              ]),
              taskChain(bindArg(ctx, readChainIdTask)),
              taskMap(bindArg(targetChainId, assertTargetChain)),
              taskCatch(bindArg(targetChainId, rejectChainSwitch))
          );

export const ensureWalletChainTask = (
    ctx: Window,
    targetChainId: number = DEFAULT_CHAIN_ID
): Task<number> =>
    pipe(
        readChainIdTask(ctx),
        taskChain(bindArgs([ctx, targetChainId], switchToTargetChainTask))
    );

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

const requestSendTransactionTask = (
    ctx: Window,
    fromWallet: string,
    toWallet: string,
    valueHex: string
): Task<unknown> =>
    ethereumRequestTask(ctx, 'eth_sendTransaction', [
        {
            ['from']: normalizeWalletAddress(fromWallet),
            ['to']: normalizeWalletAddress(toWallet),
            ['value']: valueHex,
        },
    ]);

export const sendPaymentTransactionTask = (
    ctx: Window,
    fromWallet: string,
    toWallet: string = RECIPIENT_WALLET_ADDRESS,
    valueHex: string = DEFAULT_PAYMENT_VALUE_HEX,
    targetChainId: number = DEFAULT_CHAIN_ID
): Task<string> =>
    pipe(
        ensureWalletChainTask(ctx, targetChainId),
        taskChain(
            bindArgs(
                [ctx, fromWallet, toWallet, valueHex],
                requestSendTransactionTask
            )
        ),
        taskMap(extractTxHash)
    );
