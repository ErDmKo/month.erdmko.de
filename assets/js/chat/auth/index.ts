import { bindArg, bindArgs, cont, pipe, taskChain } from '@month/utils';
import type { Task } from '@month/utils';
import {
    CLAIM_PAYMENT_RESPONSE_ACTIVATED,
    CLAIM_PAYMENT_RESPONSE_INVALID_TRANSACTION,
    CLAIM_PAYMENT_RESPONSE_PAYLOAD_VALUE,
    CLAIM_PAYMENT_RESPONSE_PAYLOAD_VARIANT,
    CLAIM_PAYMENT_RESPONSE_PENDING,
    CLAIM_PAYMENT_RESPONSE_REVERTED,
} from '@month/gen/chat';
import type { ClaimPaymentResponsePayload } from '@month/gen/chat';
import {
    buildSiweMessage,
    DEFAULT_ACCESS_DURATION_SECS,
    DEFAULT_CHAIN_ID,
    DEFAULT_PAYMENT_VALUE_HEX,
    ensureWalletChainTask,
    formatChainIdHex,
    formatChainName,
    formatWeiAsEth,
    normalizeTxHash,
    normalizeWalletAddress,
    parseChainId,
    RECIPIENT_WALLET_ADDRESS,
    requestAccountsTask,
    sendPaymentTransactionTask,
    signSiweMessageTask,
} from './wallet';
import {
    activatedToSessionStatus,
    applyPaymentConfigFromJson,
    claimPaymentOutcomeMessage,
    claimPaymentProtoTask,
    claimPaymentTask,
    fetchNonceTask,
    fetchSessionTask,
    getActivePaymentConfig,
    NONCE_CHALLENGE_EXPIRES_AT,
    NONCE_CHALLENGE_NONCE,
    NONCE_CHALLENGE_WALLET,
    PAYMENT_CONFIG_CHAIN_ID,
    PAYMENT_CONFIG_DURATION_SECS,
    PAYMENT_CONFIG_MIN_WEI_HEX,
    PAYMENT_CONFIG_RECIPIENT,
    SESSION_STATUS_ACCESS_UNTIL,
    SESSION_STATUS_HAS_ACTIVE_ACCESS,
    SESSION_STATUS_NICKNAME,
    SESSION_STATUS_WALLET,
    updateNicknameTask,
    verifySiweTask,
} from './api';
import type { NonceChallenge, PaymentConfig, SessionStatus } from './api';

export const PENDING_PAYMENT_STORAGE_KEY = 'chat-pending-payment';
export const DEFAULT_CLAIM_POLL_ATTEMPTS = 5;
export const DEFAULT_CLAIM_POLL_INTERVAL_MS = 2000;

export {
    activatedToSessionStatus,
    applyPaymentConfigFromJson,
    buildSiweMessage,
    claimPaymentOutcomeMessage,
    claimPaymentProtoTask,
    claimPaymentTask,
    DEFAULT_ACCESS_DURATION_SECS,
    DEFAULT_CHAIN_ID,
    DEFAULT_PAYMENT_VALUE_HEX,
    ensureWalletChainTask,
    fetchNonceTask,
    fetchSessionTask,
    formatChainIdHex,
    formatChainName,
    formatWeiAsEth,
    getActivePaymentConfig,
    NONCE_CHALLENGE_EXPIRES_AT,
    NONCE_CHALLENGE_NONCE,
    NONCE_CHALLENGE_WALLET,
    normalizeTxHash,
    normalizeWalletAddress,
    parseChainId,
    PAYMENT_CONFIG_CHAIN_ID,
    PAYMENT_CONFIG_DURATION_SECS,
    PAYMENT_CONFIG_MIN_WEI_HEX,
    PAYMENT_CONFIG_RECIPIENT,
    RECIPIENT_WALLET_ADDRESS,
    requestAccountsTask,
    sendPaymentTransactionTask,
    SESSION_STATUS_ACCESS_UNTIL,
    SESSION_STATUS_HAS_ACTIVE_ACCESS,
    SESSION_STATUS_NICKNAME,
    SESSION_STATUS_WALLET,
    signSiweMessageTask,
    updateNicknameTask,
    verifySiweTask,
};
export type { NonceChallenge, PaymentConfig, SessionStatus };

export const savePendingPaymentTx = (
    ctx: Window,
    walletAddress: string,
    txHash: string,
    toWallet?: string,
    valueHex?: string,
    chainId?: number
): string => {
    const cfg = getActivePaymentConfig(ctx);
    const normWallet = normalizeWalletAddress(walletAddress);
    const normTx = normalizeTxHash(txHash);
    const normTo = normalizeWalletAddress(
        toWallet ?? cfg[PAYMENT_CONFIG_RECIPIENT]
    );
    const normValue = (valueHex ?? cfg[PAYMENT_CONFIG_MIN_WEI_HEX])
        .trim()
        .toLowerCase();
    const resolvedChainId = chainId ?? cfg[PAYMENT_CONFIG_CHAIN_ID];
    ctx.localStorage?.setItem(
        PENDING_PAYMENT_STORAGE_KEY,
        `${normTx}|${normWallet}|${normTo}|${normValue}|${resolvedChainId}`
    );
    return normTx;
};

export const loadPendingPaymentTx = (
    ctx: Window,
    walletAddress: string,
    toWallet?: string,
    valueHex?: string,
    chainId?: number
): string => {
    const raw = ctx.localStorage?.getItem(PENDING_PAYMENT_STORAGE_KEY);
    if (!raw) return '';
    const cfg = getActivePaymentConfig(ctx);
    const expectedTo = (toWallet ?? cfg[PAYMENT_CONFIG_RECIPIENT])
        .trim()
        .toLowerCase();
    const expectedValue = (valueHex ?? cfg[PAYMENT_CONFIG_MIN_WEI_HEX])
        .trim()
        .toLowerCase();
    const expectedChainId = String(chainId ?? cfg[PAYMENT_CONFIG_CHAIN_ID]);
    const [storedTx, storedWallet, storedTo, storedValue, storedChain] =
        raw.split('|');
    if (
        storedTx &&
        storedWallet === walletAddress.trim().toLowerCase() &&
        storedTo === expectedTo &&
        storedValue === expectedValue &&
        (storedChain ?? String(DEFAULT_CHAIN_ID)) === expectedChainId
    ) {
        return storedTx;
    }
    return '';
};

export const clearPendingPaymentTx = (ctx: Window): void => {
    ctx.localStorage?.setItem(PENDING_PAYMENT_STORAGE_KEY, '');
};

const signAndVerifyChallengeTask = (
    ctx: Window,
    challenge: NonceChallenge,
    verifiedChainId: number
): Task<SessionStatus> => {
    const wallet = challenge[NONCE_CHALLENGE_WALLET];
    const message = buildSiweMessage(
        ctx,
        wallet,
        challenge[NONCE_CHALLENGE_NONCE],
        verifiedChainId
    );
    return pipe(
        signSiweMessageTask(ctx, wallet, message),
        taskChain(bindArgs([ctx, message], verifySiweTask))
    );
};

const verifyChallengeOnChainTask = (
    ctx: Window,
    challenge: NonceChallenge
): Task<SessionStatus> =>
    pipe(
        ensureWalletChainTask(
            ctx,
            getActivePaymentConfig(ctx)[PAYMENT_CONFIG_CHAIN_ID]
        ),
        taskChain(bindArgs([ctx, challenge], signAndVerifyChallengeTask))
    );

export const connectAndSignInTask = (ctx: Window): Task<SessionStatus> =>
    pipe(
        requestAccountsTask(ctx),
        taskChain(bindArg(ctx, fetchNonceTask)),
        taskChain(bindArg(ctx, verifyChallengeOnChainTask))
    );

export const pollClaimPaymentTask =
    (
        ctx: Window,
        fromWallet: string,
        txHash: string,
        nickname: string,
        maxPollAttempts: number = DEFAULT_CLAIM_POLL_ATTEMPTS,
        pollIntervalMs: number = DEFAULT_CLAIM_POLL_INTERVAL_MS,
        onPendingTx?: (txHash: string) => void
    ): Task<SessionStatus> =>
    (resolve, reject) => {
        const normWallet = normalizeWalletAddress(fromWallet);

        const attemptClaim = (attempt: number): void => {
            claimPaymentProtoTask(
                ctx,
                txHash,
                nickname
            )(
                (outcome: ClaimPaymentResponsePayload) => {
                    const variant =
                        outcome[CLAIM_PAYMENT_RESPONSE_PAYLOAD_VARIANT];
                    if (variant === CLAIM_PAYMENT_RESPONSE_ACTIVATED) {
                        clearPendingPaymentTx(ctx);
                        onPendingTx?.('');
                        resolve(
                            activatedToSessionStatus(
                                outcome[CLAIM_PAYMENT_RESPONSE_PAYLOAD_VALUE]
                            )
                        );
                        return;
                    }
                    if (variant === CLAIM_PAYMENT_RESPONSE_PENDING) {
                        onPendingTx?.(txHash);
                        if (attempt + 1 < maxPollAttempts) {
                            if (typeof ctx.setTimeout === 'function') {
                                ctx.setTimeout(
                                    bindArg(attempt + 1, attemptClaim),
                                    pollIntervalMs
                                );
                            } else {
                                attemptClaim(attempt + 1);
                            }
                            return;
                        }
                        reject(new Error(claimPaymentOutcomeMessage(outcome)));
                        return;
                    }
                    if (
                        variant === CLAIM_PAYMENT_RESPONSE_REVERTED ||
                        variant === CLAIM_PAYMENT_RESPONSE_INVALID_TRANSACTION
                    ) {
                        clearPendingPaymentTx(ctx);
                        onPendingTx?.('');
                        reject(new Error(claimPaymentOutcomeMessage(outcome)));
                        return;
                    }
                    onPendingTx?.(txHash);
                    reject(new Error(claimPaymentOutcomeMessage(outcome)));
                },
                (err: unknown) => {
                    fetchSessionTask(ctx)(
                        (session: SessionStatus | null) => {
                            if (
                                session &&
                                session[SESSION_STATUS_HAS_ACTIVE_ACCESS] &&
                                session[SESSION_STATUS_WALLET] === normWallet
                            ) {
                                clearPendingPaymentTx(ctx);
                                onPendingTx?.('');
                                resolve(session);
                                return;
                            }
                            onPendingTx?.(txHash);
                            reject(err);
                        },
                        () => {
                            onPendingTx?.(txHash);
                            reject(err);
                        }
                    );
                }
            );
        };

        attemptClaim(0);
    };

const saveAndPollClaimTask = (
    ctx: Window,
    fromWallet: string,
    nickname: string,
    toWallet: string,
    valueHex: string,
    chainId: number,
    maxPollAttempts: number,
    pollIntervalMs: number,
    onPendingTx: ((txHash: string) => void) | undefined,
    txHash: string
): Task<SessionStatus> => {
    const savedTx = savePendingPaymentTx(
        ctx,
        fromWallet,
        txHash,
        toWallet,
        valueHex,
        chainId
    );
    onPendingTx?.(savedTx);
    return pollClaimPaymentTask(
        ctx,
        fromWallet,
        savedTx,
        nickname,
        maxPollAttempts,
        pollIntervalMs,
        onPendingTx
    );
};

export const payAndClaimTask = (
    ctx: Window,
    fromWallet: string,
    nickname: string,
    toWallet?: string,
    valueHex?: string,
    onPendingTx?: (txHash: string) => void,
    maxPollAttempts: number = DEFAULT_CLAIM_POLL_ATTEMPTS,
    pollIntervalMs: number = DEFAULT_CLAIM_POLL_INTERVAL_MS,
    targetChainId?: number
): Task<SessionStatus> => {
    const cfg = getActivePaymentConfig(ctx);
    const resolvedTo = toWallet ?? cfg[PAYMENT_CONFIG_RECIPIENT];
    const resolvedValue = valueHex ?? cfg[PAYMENT_CONFIG_MIN_WEI_HEX];
    const resolvedChainId = targetChainId ?? cfg[PAYMENT_CONFIG_CHAIN_ID];
    const existingPendingTx = loadPendingPaymentTx(
        ctx,
        fromWallet,
        resolvedTo,
        resolvedValue,
        resolvedChainId
    );

    return pipe(
        existingPendingTx
            ? cont(existingPendingTx)
            : sendPaymentTransactionTask(
                  ctx,
                  fromWallet,
                  resolvedTo,
                  resolvedValue,
                  resolvedChainId
              ),
        taskChain(
            bindArgs(
                [
                    ctx,
                    fromWallet,
                    nickname,
                    resolvedTo,
                    resolvedValue,
                    resolvedChainId,
                    maxPollAttempts,
                    pollIntervalMs,
                    onPendingTx,
                ],
                saveAndPollClaimTask
            )
        )
    );
};
