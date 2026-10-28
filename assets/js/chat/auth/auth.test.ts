import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    pipe,
    observer,
    on,
    bindArg,
    SIGNAL_GET,
    SIGNAL_SET,
    taskFork,
} from '../../utils';
import type { Task } from '../../utils';
import {
    CLIENT_FRAME_JOIN,
    CLIENT_FRAME_PAYLOAD_VALUE,
    CLIENT_FRAME_PAYLOAD_VARIANT,
    CLIENT_JOIN_NICKNAME,
} from '@month/gen/chat';
import type { ClientFramePayload } from '@month/gen/chat';
import { CHAT_UI_AUTH_VERIFIED, CHAT_UI_EVENT_TYPE } from '../chat-ui/events';
import type { ChatUiEvent } from '../chat-ui/events';
import {
    formatAuthError,
    handleConnectWallet,
    handleJoinSubmit,
    handlePayAndUnlock,
} from '../chat-ui/join-form-handler';
import {
    CHAT_UI_STATE_HAS_ACTIVE_ACCESS,
    CHAT_UI_STATE_IS_ONLINE,
    CHAT_UI_STATE_NICKNAME,
    CHAT_UI_STATE_WALLET_ADDRESS,
    createChatUiState,
} from '../chat-ui/state';
import {
    buildSiweMessage,
    claimPaymentTask,
    connectAndSignInTask,
    DEFAULT_PAYMENT_VALUE_HEX,
    fetchNonceTask,
    fetchSessionTask,
    NONCE_CHALLENGE_EXPIRES_AT,
    NONCE_CHALLENGE_NONCE,
    NONCE_CHALLENGE_WALLET,
    normalizeTxHash,
    normalizeWalletAddress,
    payAndClaimTask,
    RECIPIENT_WALLET_ADDRESS,
    requestAccountsTask,
    sendPaymentTransactionTask,
    SESSION_STATUS_ACCESS_UNTIL,
    SESSION_STATUS_HAS_ACTIVE_ACCESS,
    SESSION_STATUS_NICKNAME,
    SESSION_STATUS_WALLET,
    signSiweMessageTask,
    verifySiweTask,
} from './index';
import type { EthereumRequestArgs } from './wallet';

const SAMPLE_WALLET_MIXED = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const SAMPLE_WALLET_LOWER = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';
const SAMPLE_NONCE = 'a1b2c3d4e5f60123456789abcdef0123';
const SAMPLE_SIG = `0x${'11'.repeat(64)}1b`;
const SAMPLE_TX_HASH = `0x${'ab'.repeat(32)}`;

const runTask = <T>(task: Task<T>): Promise<T> =>
    new Promise((resolve, reject) => {
        pipe(task, taskFork(resolve, reject));
    });

test('wallet address and tx hash normalization validate hex format', () => {
    assert.equal(
        normalizeWalletAddress(`  ${SAMPLE_WALLET_MIXED} `),
        SAMPLE_WALLET_LOWER
    );
    assert.throws(
        () => normalizeWalletAddress('0x1234'),
        /Invalid Ethereum wallet/
    );

    assert.equal(normalizeTxHash(`  0x${'AB'.repeat(32)} `), SAMPLE_TX_HASH);
    assert.throws(
        () => normalizeTxHash('0x1234'),
        /Invalid Ethereum transaction/
    );
});

test('buildSiweMessage formats a valid EIP-4361 message string', () => {
    const ctx = {
        location: {
            host: 'erdmko.dev',
            href: 'https://erdmko.dev/chat/general',
            protocol: 'https:',
        },
        Date: class {
            toISOString() {
                return '2026-10-28T12:00:00.000Z';
            }
        },
    } as unknown as Window;

    const msg = buildSiweMessage(ctx, SAMPLE_WALLET_MIXED, SAMPLE_NONCE, 1);
    assert.ok(
        msg.startsWith(
            `erdmko.dev wants you to sign in with your Ethereum account:\n${SAMPLE_WALLET_LOWER}\n\n`
        )
    );
    assert.ok(msg.includes('URI: https://erdmko.dev/chat/general\n'));
    assert.ok(msg.includes('Version: 1\n'));
    assert.ok(msg.includes('Chain ID: 1\n'));
    assert.ok(msg.includes(`Nonce: ${SAMPLE_NONCE}\n`));
    assert.ok(msg.includes('Issued At: 2026-10-28T12:00:00.000Z'));
});

test('requestAccountsTask, signSiweMessageTask, and sendPaymentTransactionTask call window.ethereum', async () => {
    const calls: EthereumRequestArgs[] = [];
    const ctx = {
        ['ethereum']: {
            ['request']: async (args: EthereumRequestArgs) => {
                calls.push(args);
                if (args['method'] === 'eth_requestAccounts') {
                    return [SAMPLE_WALLET_MIXED];
                }
                if (args['method'] === 'personal_sign') {
                    return SAMPLE_SIG;
                }
                if (args['method'] === 'eth_sendTransaction') {
                    return SAMPLE_TX_HASH.toUpperCase().replace('0X', '0x');
                }
                throw new Error(`Unexpected method: ${args['method']}`);
            },
        },
    } as unknown as Window;

    const account = await runTask<string>(requestAccountsTask(ctx));
    assert.equal(account, SAMPLE_WALLET_LOWER);
    assert.equal(calls[0]?.['method'], 'eth_requestAccounts');

    const sig = await runTask<string>(
        signSiweMessageTask(ctx, SAMPLE_WALLET_MIXED, 'hello siwe')
    );
    assert.equal(sig, SAMPLE_SIG);
    assert.deepEqual(calls[1], {
        ['method']: 'personal_sign',
        ['params']: ['hello siwe', SAMPLE_WALLET_LOWER],
    });

    const txHash = await runTask<string>(
        sendPaymentTransactionTask(
            ctx,
            SAMPLE_WALLET_MIXED,
            RECIPIENT_WALLET_ADDRESS,
            DEFAULT_PAYMENT_VALUE_HEX
        )
    );
    assert.equal(txHash, SAMPLE_TX_HASH);
    assert.deepEqual(calls[2], {
        ['method']: 'eth_sendTransaction',
        ['params']: [
            {
                ['from']: SAMPLE_WALLET_LOWER,
                ['to']: RECIPIENT_WALLET_ADDRESS.toLowerCase(),
                ['value']: DEFAULT_PAYMENT_VALUE_HEX,
            },
        ],
    });
});

test('connectAndSignInTask and payAndClaimTask execute full connect -> sign -> payment -> claim pipeline', async () => {
    const ethCalls: EthereumRequestArgs[] = [];
    const fetchCalls: { url: string; method: string; body?: any }[] = [];

    const ctx = {
        JSON,
        Date: class {
            toISOString() {
                return '2026-10-28T12:00:00.000Z';
            }
        },
        location: {
            host: 'erdmko.dev',
            href: 'https://erdmko.dev/chat/general',
            protocol: 'https:',
        },
        ['ethereum']: {
            ['request']: async (args: EthereumRequestArgs) => {
                ethCalls.push(args);
                if (args['method'] === 'eth_requestAccounts') {
                    return [SAMPLE_WALLET_MIXED];
                }
                if (args['method'] === 'personal_sign') {
                    return SAMPLE_SIG;
                }
                if (args['method'] === 'eth_sendTransaction') {
                    return SAMPLE_TX_HASH;
                }
                throw new Error(`Unexpected method: ${args['method']}`);
            },
        },
        fetch: async (url: string, init?: RequestInit) => {
            const body = init?.body ? JSON.parse(String(init.body)) : undefined;
            fetchCalls.push({
                url,
                method: init?.method || 'GET',
                body,
            });

            if (url === '/auth/nonce') {
                return {
                    ok: true,
                    status: 200,
                    text: async () =>
                        JSON.stringify({
                            nonce: SAMPLE_NONCE,
                            walletAddress: SAMPLE_WALLET_LOWER,
                            expiresAt: 1_793_000_300,
                        }),
                } as Response;
            }

            if (url === '/auth/verify') {
                return {
                    ok: true,
                    status: 200,
                    text: async () =>
                        JSON.stringify({
                            walletAddress: SAMPLE_WALLET_LOWER,
                            nickname: null,
                            accessUntil: 0,
                            hasActiveAccess: false,
                        }),
                } as Response;
            }

            if (url === '/auth/claim-payment') {
                return {
                    ok: true,
                    status: 200,
                    text: async () =>
                        JSON.stringify({
                            walletAddress: SAMPLE_WALLET_LOWER,
                            nickname: body.nickname,
                            accessUntil: 1_795_592_000,
                            hasActiveAccess: true,
                        }),
                } as Response;
            }

            if (url === '/auth/session') {
                return {
                    ok: true,
                    status: 200,
                    text: async () =>
                        JSON.stringify({
                            walletAddress: SAMPLE_WALLET_LOWER,
                            nickname: 'alice_eth',
                            accessUntil: 1_795_592_000,
                            hasActiveAccess: true,
                        }),
                } as Response;
            }

            throw new Error(`Unexpected URL: ${url}`);
        },
    } as unknown as Window;

    // 1. Connect + SIWE verify (unpaid profile)
    const connectedStatus = await runTask(connectAndSignInTask(ctx));
    assert.equal(connectedStatus[SESSION_STATUS_WALLET], SAMPLE_WALLET_LOWER);
    assert.equal(connectedStatus[SESSION_STATUS_NICKNAME], null);
    assert.equal(connectedStatus[SESSION_STATUS_HAS_ACTIVE_ACCESS], false);

    assert.equal(ethCalls[0]?.['method'], 'eth_requestAccounts');
    assert.equal(ethCalls[1]?.['method'], 'personal_sign');
    assert.equal(fetchCalls[0]?.url, '/auth/nonce');
    assert.equal(fetchCalls[1]?.url, '/auth/verify');
    assert.equal(fetchCalls[1]?.body.signature, SAMPLE_SIG);

    // 2. Send ETH payment + claim txHash + register nickname
    const paidStatus = await runTask(
        payAndClaimTask(ctx, SAMPLE_WALLET_LOWER, 'alice_eth')
    );
    assert.equal(paidStatus[SESSION_STATUS_WALLET], SAMPLE_WALLET_LOWER);
    assert.equal(paidStatus[SESSION_STATUS_NICKNAME], 'alice_eth');
    assert.equal(paidStatus[SESSION_STATUS_ACCESS_UNTIL], 1_795_592_000);
    assert.equal(paidStatus[SESSION_STATUS_HAS_ACTIVE_ACCESS], true);

    assert.equal(ethCalls[2]?.['method'], 'eth_sendTransaction');
    assert.equal(fetchCalls[2]?.url, '/auth/claim-payment');
    assert.deepEqual(fetchCalls[2]?.body, {
        txHash: SAMPLE_TX_HASH,
        nickname: 'alice_eth',
    });

    // 3. Session check returns active profile
    const session = await runTask(fetchSessionTask(ctx));
    assert.ok(session);
    assert.equal(session[SESSION_STATUS_NICKNAME], 'alice_eth');
    assert.equal(session[SESSION_STATUS_HAS_ACTIVE_ACCESS], true);
});

test('tasks surface provider and HTTP error messages cleanly', async () => {
    const noWalletCtx = {} as unknown as Window;
    await assert.rejects(
        () => runTask(requestAccountsTask(noWalletCtx)),
        /No Ethereum wallet detected/
    );

    const errorFetchCtx = {
        JSON,
        fetch: async () =>
            ({
                ok: false,
                status: 409,
                text: async () =>
                    JSON.stringify({
                        code: 'NICKNAME_TAKEN',
                        message:
                            'Nickname is already registered to another wallet.',
                    }),
            }) as Response,
    } as unknown as Window;

    await assert.rejects(
        () => runTask(claimPaymentTask(errorFetchCtx, SAMPLE_TX_HASH, 'alice')),
        /Nickname is already registered to another wallet/
    );

    const nonceChallenge = await runTask(
        fetchNonceTask(
            {
                JSON,
                fetch: async () =>
                    ({
                        ok: true,
                        status: 200,
                        text: async () =>
                            JSON.stringify({
                                nonce: SAMPLE_NONCE,
                                walletAddress: SAMPLE_WALLET_LOWER,
                                expiresAt: 12345,
                            }),
                    }) as Response,
            } as unknown as Window,
            SAMPLE_WALLET_LOWER
        )
    );
    assert.equal(nonceChallenge[NONCE_CHALLENGE_NONCE], SAMPLE_NONCE);
    assert.equal(nonceChallenge[NONCE_CHALLENGE_WALLET], SAMPLE_WALLET_LOWER);
    assert.equal(nonceChallenge[NONCE_CHALLENGE_EXPIRES_AT], 12345);

    const verified = await runTask(
        verifySiweTask(
            {
                JSON,
                fetch: async () =>
                    ({
                        ok: true,
                        status: 200,
                        text: async () =>
                            JSON.stringify({
                                walletAddress: SAMPLE_WALLET_LOWER,
                                nickname: 'bob',
                                accessUntil: 999,
                                hasActiveAccess: true,
                            }),
                    }) as Response,
            } as unknown as Window,
            'msg',
            SAMPLE_SIG
        )
    );
    assert.equal(verified[SESSION_STATUS_NICKNAME], 'bob');

    // EIP-1193 plain-object RPC rejection is formatted into a readable message
    const rpcErrCtx = { JSON } as unknown as Window;
    assert.equal(
        formatAuthError(rpcErrCtx, {
            code: 4001,
            message: 'User rejected the request.',
        }),
        'User rejected the request.'
    );
    assert.equal(
        formatAuthError(rpcErrCtx, { code: -32603 }),
        '{"code":-32603}'
    );
});

test('UI handlers drive connect -> sign -> payment -> claim -> join end-to-end', async () => {
    const storage = new Map<string, string>();
    const ctx = {
        JSON,
        Date: Object.assign(
            class {
                toISOString() {
                    return '2026-10-28T12:00:00.000Z';
                }
            },
            { now: () => 1_793_102_400_000 }
        ),
        localStorage: {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
        },
        location: {
            host: 'erdmko.dev',
            href: 'https://erdmko.dev/chat/general',
            protocol: 'https:',
        },
        ['ethereum']: {
            ['request']: async (args: EthereumRequestArgs) => {
                if (args['method'] === 'eth_requestAccounts') {
                    return [SAMPLE_WALLET_MIXED];
                }
                if (args['method'] === 'personal_sign') {
                    return SAMPLE_SIG;
                }
                if (args['method'] === 'eth_sendTransaction') {
                    return SAMPLE_TX_HASH;
                }
                throw new Error(`Unexpected method: ${args['method']}`);
            },
        },
        fetch: async (url: string, init?: RequestInit) => {
            const body = init?.body ? JSON.parse(String(init.body)) : undefined;
            if (url === '/auth/nonce') {
                return {
                    ok: true,
                    status: 200,
                    text: async () =>
                        JSON.stringify({
                            nonce: SAMPLE_NONCE,
                            walletAddress: SAMPLE_WALLET_LOWER,
                            expiresAt: 1_793_000_300,
                        }),
                } as Response;
            }
            if (url === '/auth/verify') {
                return {
                    ok: true,
                    status: 200,
                    text: async () =>
                        JSON.stringify({
                            walletAddress: SAMPLE_WALLET_LOWER,
                            nickname: null,
                            accessUntil: 0,
                            hasActiveAccess: false,
                        }),
                } as Response;
            }
            if (url === '/auth/claim-payment') {
                return {
                    ok: true,
                    status: 200,
                    text: async () =>
                        JSON.stringify({
                            walletAddress: SAMPLE_WALLET_LOWER,
                            nickname: body.nickname,
                            accessUntil: 1_795_592_000,
                            hasActiveAccess: true,
                        }),
                } as Response;
            }
            throw new Error(`Unexpected URL: ${url}`);
        },
    } as unknown as Window;

    const state = createChatUiState('');
    state[CHAT_UI_STATE_IS_ONLINE][SIGNAL_SET](true);
    const chatUiObs = observer<ChatUiEvent>();
    const outgoing = observer<ClientFramePayload>();
    const uiEvents: ChatUiEvent[] = [];
    const sentFrames: ClientFramePayload[] = [];
    chatUiObs(bindArg((ev: ChatUiEvent) => uiEvents.push(ev), on));
    outgoing(
        bindArg((frame: ClientFramePayload) => sentFrames.push(frame), on)
    );

    // Step 1: Connect Wallet + SIWE
    handleConnectWallet(ctx, 'chat-nickname-general', chatUiObs, state);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
        state[CHAT_UI_STATE_WALLET_ADDRESS][SIGNAL_GET](),
        SAMPLE_WALLET_LOWER
    );
    assert.equal(state[CHAT_UI_STATE_HAS_ACTIVE_ACCESS][SIGNAL_GET](), false);
    assert.equal(uiEvents.at(-1)?.[CHAT_UI_EVENT_TYPE], CHAT_UI_AUTH_VERIFIED);

    // Step 2: Enter nickname and Pay & Unlock Chat
    state[CHAT_UI_STATE_NICKNAME][SIGNAL_SET]('alice_eth');
    handlePayAndUnlock(ctx, 'chat-nickname-general', state);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(state[CHAT_UI_STATE_HAS_ACTIVE_ACCESS][SIGNAL_GET](), true);
    assert.equal(storage.get('chat-nickname-general'), 'alice_eth');

    // Step 3: Submit Join Room form
    handleJoinSubmit(ctx, outgoing, state, {
        preventDefault() {},
    } as unknown as Event);
    assert.equal(sentFrames.length, 1);
    assert.equal(
        sentFrames[0]?.[CLIENT_FRAME_PAYLOAD_VARIANT],
        CLIENT_FRAME_JOIN
    );
    assert.equal(
        sentFrames[0]?.[CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_JOIN_NICKNAME],
        'alice_eth'
    );
});
