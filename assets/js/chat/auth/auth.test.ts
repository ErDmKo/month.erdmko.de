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
    CLAIM_PAYMENT_REQUEST_NICKNAME,
    CLAIM_PAYMENT_REQUEST_TX_HASH,
    CLAIM_PAYMENT_RESPONSE_ACTIVATED,
    CLAIM_PAYMENT_RESPONSE_INVALID_TRANSACTION,
    CLAIM_PAYMENT_RESPONSE_NICKNAME_TAKEN,
    CLAIM_PAYMENT_RESPONSE_PENDING,
    CLAIM_PAYMENT_RESPONSE_REVERTED,
    CLIENT_FRAME_JOIN,
    CLIENT_FRAME_PAYLOAD_VALUE,
    CLIENT_FRAME_PAYLOAD_VARIANT,
    CLIENT_JOIN_NICKNAME,
    decodeClaimPaymentRequest,
    encodeClaimPaymentResponse,
} from '@month/gen/chat';
import type {
    ClaimPaymentResponsePayload,
    ClientFramePayload,
} from '@month/gen/chat';
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
    CHAT_UI_STATE_PENDING_TX_HASH,
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
    loadPendingPaymentTx,
    NONCE_CHALLENGE_EXPIRES_AT,
    NONCE_CHALLENGE_NONCE,
    NONCE_CHALLENGE_WALLET,
    normalizeTxHash,
    normalizeWalletAddress,
    payAndClaimTask,
    RECIPIENT_WALLET_ADDRESS,
    requestAccountsTask,
    savePendingPaymentTx,
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

const protoCtx = {
    Uint8Array,
    TextEncoder,
    TextDecoder,
} as unknown as Window;

const makeProtoResponse = (payload: ClaimPaymentResponsePayload): Response => {
    const encoded = encodeClaimPaymentResponse(protoCtx, payload);
    return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
            encoded.buffer.slice(
                encoded.byteOffset,
                encoded.byteOffset + encoded.byteLength
            ),
    } as Response;
};

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
                if (args['method'] === 'eth_chainId') {
                    return '0x1';
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
    assert.equal(calls[2]?.['method'], 'eth_chainId');
    assert.deepEqual(calls[3], {
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
        Uint8Array,
        TextEncoder,
        TextDecoder,
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
                if (args['method'] === 'eth_chainId') {
                    return '0x1';
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
            if (url === '/auth/claim-payment') {
                const decodedReq = decodeClaimPaymentRequest(
                    protoCtx,
                    init?.body as Uint8Array
                )!;
                fetchCalls.push({
                    url,
                    method: init?.method || 'POST',
                    body: {
                        txHash: decodedReq[CLAIM_PAYMENT_REQUEST_TX_HASH],
                        nickname: decodedReq[CLAIM_PAYMENT_REQUEST_NICKNAME],
                    },
                });
                return makeProtoResponse([
                    CLAIM_PAYMENT_RESPONSE_ACTIVATED,
                    [
                        SAMPLE_WALLET_LOWER,
                        decodedReq[CLAIM_PAYMENT_REQUEST_NICKNAME],
                        1_795_592_000,
                        true,
                    ],
                ]);
            }

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
    assert.equal(ethCalls[1]?.['method'], 'eth_chainId');
    assert.equal(ethCalls[2]?.['method'], 'personal_sign');
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

    assert.equal(ethCalls[3]?.['method'], 'eth_chainId');
    assert.equal(ethCalls[4]?.['method'], 'eth_sendTransaction');
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
        Uint8Array,
        TextEncoder,
        TextDecoder,
        fetch: async () =>
            makeProtoResponse([
                CLAIM_PAYMENT_RESPONSE_NICKNAME_TAKEN,
                ['Nickname is already registered to another wallet.'],
            ]),
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
        Uint8Array,
        TextEncoder,
        TextDecoder,
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
            removeItem: (key: string) => storage.delete(key),
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
                if (args['method'] === 'eth_chainId') {
                    return '0x1';
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
            if (url === '/auth/claim-payment') {
                const decodedReq = decodeClaimPaymentRequest(
                    protoCtx,
                    init?.body as Uint8Array
                )!;
                return makeProtoResponse([
                    CLAIM_PAYMENT_RESPONSE_ACTIVATED,
                    [
                        SAMPLE_WALLET_LOWER,
                        decodedReq[CLAIM_PAYMENT_REQUEST_NICKNAME],
                        1_795_592_000,
                        true,
                    ],
                ]);
            }
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

test('payAndClaimTask persists txHash before claiming, polls Pending, reuses txHash on NicknameTaken/retry, and clears on Reverted/InvalidTransaction', async () => {
    const storage = new Map<string, string>();
    let sendTxCount = 0;
    let claimResponses: ClaimPaymentResponsePayload[] = [];
    const claimedNicknames: string[] = [];

    const ctx = {
        JSON,
        Uint8Array,
        TextEncoder,
        TextDecoder,
        localStorage: {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
            removeItem: (key: string) => storage.delete(key),
        },
        ['ethereum']: {
            ['request']: async (args: EthereumRequestArgs) => {
                if (args['method'] === 'eth_chainId') {
                    return '0x1';
                }
                if (args['method'] === 'eth_sendTransaction') {
                    sendTxCount += 1;
                    return SAMPLE_TX_HASH;
                }
                throw new Error(`Unexpected method: ${args['method']}`);
            },
        },
        fetch: async (url: string, init?: RequestInit) => {
            if (url === '/auth/claim-payment') {
                // Verify txHash was persisted in localStorage BEFORE /auth/claim-payment was called
                assert.equal(
                    loadPendingPaymentTx(ctx, SAMPLE_WALLET_LOWER),
                    SAMPLE_TX_HASH
                );
                const req = decodeClaimPaymentRequest(
                    protoCtx,
                    init?.body as Uint8Array
                )!;
                claimedNicknames.push(req[CLAIM_PAYMENT_REQUEST_NICKNAME]);
                const next = claimResponses.shift();
                if (!next) {
                    throw new Error('No mock claim response queued');
                }
                return makeProtoResponse(next);
            }
            throw new Error(`Unexpected URL: ${url}`);
        },
    } as unknown as Window;

    // 1. First attempt: Pending -> Pending -> NicknameTaken (sendTxCount === 1, txHash remains saved!)
    claimResponses = [
        [CLAIM_PAYMENT_RESPONSE_PENDING, ['Still in mempool']],
        [CLAIM_PAYMENT_RESPONSE_PENDING, ['Waiting for block']],
        [
            CLAIM_PAYMENT_RESPONSE_NICKNAME_TAKEN,
            ['Nickname is already registered to another wallet.'],
        ],
    ];
    await assert.rejects(
        () => runTask(payAndClaimTask(ctx, SAMPLE_WALLET_LOWER, 'taken_nick')),
        /Nickname is already registered to another wallet/
    );
    assert.equal(sendTxCount, 1);
    assert.equal(
        loadPendingPaymentTx(ctx, SAMPLE_WALLET_LOWER),
        SAMPLE_TX_HASH
    );
    assert.deepEqual(claimedNicknames, [
        'taken_nick',
        'taken_nick',
        'taken_nick',
    ]);

    // 2. User changes nickname to 'alice_free' and retries -> reuses saved SAMPLE_TX_HASH without calling eth_sendTransaction!
    claimResponses = [
        [CLAIM_PAYMENT_RESPONSE_PENDING, ['Almost mined']],
        [
            CLAIM_PAYMENT_RESPONSE_ACTIVATED,
            [SAMPLE_WALLET_LOWER, 'alice_free', 1_795_592_000, true],
        ],
    ];
    const activated = await runTask(
        payAndClaimTask(ctx, SAMPLE_WALLET_LOWER, 'alice_free')
    );
    assert.equal(sendTxCount, 1, 'must NOT call eth_sendTransaction again');
    assert.equal(activated[SESSION_STATUS_NICKNAME], 'alice_free');
    assert.equal(activated[SESSION_STATUS_HAS_ACTIVE_ACCESS], true);
    assert.equal(
        loadPendingPaymentTx(ctx, SAMPLE_WALLET_LOWER),
        '',
        'pending txHash must be cleared on Activated'
    );

    // 3. Terminal Reverted failure clears the stored txHash so a fresh payment can be sent later
    claimResponses = [
        [
            CLAIM_PAYMENT_RESPONSE_REVERTED,
            ['Payment transaction failed or reverted onchain.'],
        ],
    ];
    await assert.rejects(
        () => runTask(payAndClaimTask(ctx, SAMPLE_WALLET_LOWER, 'alice_free')),
        /reverted onchain/
    );
    assert.equal(sendTxCount, 2);
    assert.equal(
        loadPendingPaymentTx(ctx, SAMPLE_WALLET_LOWER),
        '',
        'pending txHash must be cleared on Reverted'
    );

    // 4. Terminal InvalidTransaction failure also clears the stored txHash
    savePendingPaymentTx(ctx, SAMPLE_WALLET_LOWER, SAMPLE_TX_HASH);
    claimResponses = [
        [
            CLAIM_PAYMENT_RESPONSE_INVALID_TRANSACTION,
            ['Transaction value is below the minimum required payment.'],
        ],
    ];
    await assert.rejects(
        () => runTask(payAndClaimTask(ctx, SAMPLE_WALLET_LOWER, 'alice_free')),
        /below the minimum/
    );
    assert.equal(sendTxCount, 2);
    assert.equal(loadPendingPaymentTx(ctx, SAMPLE_WALLET_LOWER), '');
});

test('payAndClaimTask recovers via fetchSessionTask when /auth/claim-payment HTTP response is lost after server commit', async () => {
    const storage = new Map<string, string>();
    savePendingPaymentTx(
        {
            localStorage: {
                setItem: (k: string, v: string) => storage.set(k, v),
            },
        } as unknown as Window,
        SAMPLE_WALLET_LOWER,
        SAMPLE_TX_HASH
    );

    let sendTxCount = 0;
    const ctx = {
        JSON,
        Uint8Array,
        TextEncoder,
        TextDecoder,
        localStorage: {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
            removeItem: (key: string) => storage.delete(key),
        },
        ['ethereum']: {
            ['request']: async () => {
                sendTxCount += 1;
                return SAMPLE_TX_HASH;
            },
        },
        fetch: async (url: string) => {
            if (url === '/auth/claim-payment') {
                throw new Error('Network connection lost');
            }
            if (url === '/auth/session') {
                return {
                    ok: true,
                    status: 200,
                    text: async () =>
                        JSON.stringify({
                            walletAddress: SAMPLE_WALLET_LOWER,
                            nickname: 'alice_recovered',
                            accessUntil: 1_795_592_000,
                            hasActiveAccess: true,
                        }),
                } as Response;
            }
            throw new Error(`Unexpected URL: ${url}`);
        },
    } as unknown as Window;

    const status = await runTask(
        payAndClaimTask(ctx, SAMPLE_WALLET_LOWER, 'alice_recovered')
    );
    assert.equal(sendTxCount, 0, 'reused saved txHash without new transfer');
    assert.equal(status[SESSION_STATUS_NICKNAME], 'alice_recovered');
    assert.equal(status[SESSION_STATUS_HAS_ACTIVE_ACCESS], true);
    assert.equal(loadPendingPaymentTx(ctx, SAMPLE_WALLET_LOWER), '');
});

test('wrong-chain wallet requests wallet_switchEthereumChain and sends no transfer if switch is rejected', async () => {
    let currentChainHex = '0x2105'; // Base (8453) instead of Mainnet (1)
    let allowSwitch = false;
    let sendTxCount = 0;
    const ethMethods: string[] = [];

    const ctx = {
        ['ethereum']: {
            ['request']: async (args: EthereumRequestArgs) => {
                ethMethods.push(args['method']);
                if (args['method'] === 'eth_chainId') {
                    return currentChainHex;
                }
                if (args['method'] === 'wallet_switchEthereumChain') {
                    if (!allowSwitch) {
                        throw {
                            code: 4001,
                            message: 'User rejected chain switch.',
                        };
                    }
                    currentChainHex = '0x1';
                    return null;
                }
                if (args['method'] === 'eth_sendTransaction') {
                    sendTxCount += 1;
                    return SAMPLE_TX_HASH;
                }
                throw new Error(`Unexpected method: ${args['method']}`);
            },
        },
    } as unknown as Window;

    // 1. Rejected chain switch stops before eth_sendTransaction with actionable message
    await assert.rejects(
        () =>
            runTask(
                sendPaymentTransactionTask(
                    ctx,
                    SAMPLE_WALLET_LOWER,
                    RECIPIENT_WALLET_ADDRESS,
                    DEFAULT_PAYMENT_VALUE_HEX
                )
            ),
        /Switch your wallet network to Ethereum Mainnet \(chain ID 1\) to continue\./
    );
    assert.equal(
        sendTxCount,
        0,
        'must not call eth_sendTransaction on wrong chain'
    );
    assert.deepEqual(ethMethods, ['eth_chainId', 'wallet_switchEthereumChain']);

    // 2. Approved chain switch switches to 0x1, re-verifies eth_chainId, and sends payment
    allowSwitch = true;
    ethMethods.length = 0;
    const txHash = await runTask(
        sendPaymentTransactionTask(
            ctx,
            SAMPLE_WALLET_LOWER,
            RECIPIENT_WALLET_ADDRESS,
            DEFAULT_PAYMENT_VALUE_HEX
        )
    );
    assert.equal(txHash, SAMPLE_TX_HASH);
    assert.equal(sendTxCount, 1);
    assert.deepEqual(ethMethods, [
        'eth_chainId',
        'wallet_switchEthereumChain',
        'eth_chainId',
        'eth_sendTransaction',
    ]);
});

test('non-default server payment config drives SIWE chainId, chain switch, transfer params, and pending tx scoping', async () => {
    const customRecipient = '0x2222222222222222222222222222222222222222';
    const customWeiHex = '0x71afd498d0000'; // 0.002 ETH
    const sepoliaChainId = 11_155_111; // 0xaa36a7
    let walletChainHex = '0x1';
    const ethCalls: EthereumRequestArgs[] = [];
    let signedMessage = '';
    const storage = new Map<string, string>();

    const ctx = {
        JSON,
        Uint8Array,
        TextEncoder,
        TextDecoder,
        Date: class {
            toISOString() {
                return '2026-10-28T12:00:00.000Z';
            }
        },
        localStorage: {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
            removeItem: (key: string) => storage.delete(key),
        },
        location: {
            host: 'erdmko.dev',
            href: 'https://erdmko.dev/chat',
            protocol: 'https:',
        },
        ['ethereum']: {
            ['request']: async (args: EthereumRequestArgs) => {
                ethCalls.push(args);
                if (args['method'] === 'eth_requestAccounts') {
                    return [SAMPLE_WALLET_MIXED];
                }
                if (args['method'] === 'eth_chainId') {
                    return walletChainHex;
                }
                if (args['method'] === 'wallet_switchEthereumChain') {
                    walletChainHex = '0xaa36a7';
                    return null;
                }
                if (args['method'] === 'personal_sign') {
                    signedMessage = String(args['params']?.[0] ?? '');
                    return SAMPLE_SIG;
                }
                if (args['method'] === 'eth_sendTransaction') {
                    return SAMPLE_TX_HASH;
                }
                throw new Error(`Unexpected method: ${args['method']}`);
            },
        },
        fetch: async (url: string, init?: RequestInit) => {
            if (url === '/auth/nonce') {
                return {
                    ok: true,
                    status: 200,
                    text: async () =>
                        JSON.stringify({
                            nonce: SAMPLE_NONCE,
                            walletAddress: SAMPLE_WALLET_LOWER,
                            expiresAt: 1_793_000_300,
                            chainId: sepoliaChainId,
                            recipientAddress: customRecipient,
                            minPaymentWei: customWeiHex,
                            accessDurationSecs: 604_800,
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
                            chainId: sepoliaChainId,
                            recipientAddress: customRecipient,
                            minPaymentWei: customWeiHex,
                            accessDurationSecs: 604_800,
                        }),
                } as Response;
            }
            if (url === '/auth/claim-payment') {
                const decodedReq = decodeClaimPaymentRequest(
                    protoCtx,
                    init?.body as Uint8Array
                )!;
                return makeProtoResponse([
                    CLAIM_PAYMENT_RESPONSE_ACTIVATED,
                    [
                        SAMPLE_WALLET_LOWER,
                        decodedReq[CLAIM_PAYMENT_REQUEST_NICKNAME],
                        1_795_592_000,
                        true,
                    ],
                ]);
            }
            throw new Error(`Unexpected URL: ${url}`);
        },
    } as unknown as Window;

    await runTask(connectAndSignInTask(ctx));
    assert.ok(
        signedMessage.includes(`Chain ID: ${sepoliaChainId}\n`),
        'SIWE message must use server configured chainId'
    );
    assert.ok(
        ethCalls.some(
            (c) =>
                c['method'] === 'wallet_switchEthereumChain' &&
                (c['params']?.[0] as any)?.['chainId'] === '0xaa36a7'
        ),
        'must switch wallet to 0xaa36a7 before signing'
    );

    // Simulate user switching wallet back to mainnet (0x1) between sign-in and payment
    walletChainHex = '0x1';
    await runTask(payAndClaimTask(ctx, SAMPLE_WALLET_LOWER, 'sepolia_user'));

    const sendTxCall = ethCalls.find(
        (c) => c['method'] === 'eth_sendTransaction'
    );
    assert.deepEqual(sendTxCall?.['params'], [
        {
            ['from']: SAMPLE_WALLET_LOWER,
            ['to']: customRecipient,
            ['value']: customWeiHex,
        },
    ]);
});
