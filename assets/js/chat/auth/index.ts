import { pipe, taskChain } from '@month/utils';
import type { Task } from '@month/utils';
import {
    CLAIM_PAYMENT_RESPONSE_ACTIVATED,
    CLAIM_PAYMENT_RESPONSE_INVALID_TRANSACTION,
    CLAIM_PAYMENT_RESPONSE_NICKNAME_TAKEN,
    CLAIM_PAYMENT_RESPONSE_PAYLOAD_VALUE,
    CLAIM_PAYMENT_RESPONSE_PAYLOAD_VARIANT,
    CLAIM_PAYMENT_RESPONSE_PENDING,
    CLAIM_PAYMENT_RESPONSE_REVERTED,
    CLAIM_PAYMENT_RESPONSE_UNAUTHORIZED,
} from '@month/gen/chat';
import type { ClaimPaymentResponsePayload } from '@month/gen/chat';
import {
    buildSiweMessage,
    DEFAULT_PAYMENT_VALUE_HEX,
    normalizeTxHash,
    normalizeWalletAddress,
    RECIPIENT_WALLET_ADDRESS,
    requestAccountsTask,
    sendPaymentTransactionTask,
    signSiweMessageTask,
} from './wallet';
import {
    activatedToSessionStatus,
    claimPaymentOutcomeMessage,
    claimPaymentProtoTask,
    claimPaymentTask,
    fetchNonceTask,
    fetchSessionTask,
    NONCE_CHALLENGE_EXPIRES_AT,
    NONCE_CHALLENGE_NONCE,
    NONCE_CHALLENGE_WALLET,
    SESSION_STATUS_ACCESS_UNTIL,
    SESSION_STATUS_HAS_ACTIVE_ACCESS,
    SESSION_STATUS_NICKNAME,
    SESSION_STATUS_WALLET,
    updateNicknameTask,
    verifySiweTask,
} from './api';
import type { NonceChallenge, SessionStatus } from './api';

export const PENDING_PAYMENT_STORAGE_KEY = 'chat-pending-payment';
export const DEFAULT_CLAIM_POLL_ATTEMPTS = 5;
export const DEFAULT_CLAIM_POLL_INTERVAL_MS = 2000;

export {
    activatedToSessionStatus,
    buildSiweMessage,
    claimPaymentOutcomeMessage,
    claimPaymentProtoTask,
    claimPaymentTask,
    DEFAULT_PAYMENT_VALUE_HEX,
    fetchNonceTask,
    fetchSessionTask,
    NONCE_CHALLENGE_EXPIRES_AT,
    NONCE_CHALLENGE_NONCE,
    NONCE_CHALLENGE_WALLET,
    normalizeTxHash,
    normalizeWalletAddress,
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
export type { NonceChallenge, SessionStatus };

export const savePendingPaymentTx = (
    ctx: Window,
    walletAddress: string,
    txHash: string,
    toWallet: string = RECIPIENT_WALLET_ADDRESS,
    valueHex: string = DEFAULT_PAYMENT_VALUE_HEX
): string => {
    const normWallet = normalizeWalletAddress(walletAddress);
    const normTx = normalizeTxHash(txHash);
    const normTo = normalizeWalletAddress(toWallet);
    const normValue = valueHex.trim().toLowerCase();
    ctx.localStorage?.setItem(
        PENDING_PAYMENT_STORAGE_KEY,
        `${normTx}|${normWallet}|${normTo}|${normValue}`
    );
    return normTx;
};

export const loadPendingPaymentTx = (
    ctx: Window,
    walletAddress: string,
    toWallet: string = RECIPIENT_WALLET_ADDRESS,
    valueHex: string = DEFAULT_PAYMENT_VALUE_HEX
): string => {
    const raw = ctx.localStorage?.getItem(PENDING_PAYMENT_STORAGE_KEY);
    if (!raw) return '';
    const [storedTx, storedWallet, storedTo, storedValue] = raw.split('|');
    if (
        storedTx &&
        storedWallet === walletAddress.trim().toLowerCase() &&
        storedTo === toWallet.trim().toLowerCase() &&
        storedValue === valueHex.trim().toLowerCase()
    ) {
        return storedTx;
    }
    return '';
};

export const clearPendingPaymentTx = (ctx: Window): void => {
    ctx.localStorage?.setItem(PENDING_PAYMENT_STORAGE_KEY, '');
};

export const connectAndSignInTask = (ctx: Window): Task<SessionStatus> =>
    pipe(
        requestAccountsTask(ctx),
        taskChain((walletAddress: string) =>
            fetchNonceTask(ctx, walletAddress)
        ),
        taskChain((challenge: NonceChallenge) => {
            const wallet = challenge[NONCE_CHALLENGE_WALLET];
            const message = buildSiweMessage(
                ctx,
                wallet,
                challenge[NONCE_CHALLENGE_NONCE]
            );
            return pipe(
                signSiweMessageTask(ctx, wallet, message),
                taskChain((signature: string) =>
                    verifySiweTask(ctx, message, signature)
                )
            );
        })
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
                                    () => attemptClaim(attempt + 1),
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
                    if (
                        variant === CLAIM_PAYMENT_RESPONSE_NICKNAME_TAKEN ||
                        variant === CLAIM_PAYMENT_RESPONSE_UNAUTHORIZED
                    ) {
                        onPendingTx?.(txHash);
                        reject(new Error(claimPaymentOutcomeMessage(outcome)));
                        return;
                    }
                    reject(new Error('Unexpected payment claim outcome.'));
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

export const payAndClaimTask = (
    ctx: Window,
    fromWallet: string,
    nickname: string,
    toWallet: string = RECIPIENT_WALLET_ADDRESS,
    valueHex: string = DEFAULT_PAYMENT_VALUE_HEX,
    onPendingTx?: (txHash: string) => void,
    maxPollAttempts: number = DEFAULT_CLAIM_POLL_ATTEMPTS,
    pollIntervalMs: number = DEFAULT_CLAIM_POLL_INTERVAL_MS
): Task<SessionStatus> => {
    const existingPendingTx = loadPendingPaymentTx(
        ctx,
        fromWallet,
        toWallet,
        valueHex
    );
    const acquireTxHashTask: Task<string> = existingPendingTx
        ? (resolve) => resolve(existingPendingTx)
        : sendPaymentTransactionTask(ctx, fromWallet, toWallet, valueHex);

    return pipe(
        acquireTxHashTask,
        taskChain((txHash: string) => {
            const savedTx = savePendingPaymentTx(
                ctx,
                fromWallet,
                txHash,
                toWallet,
                valueHex
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
        })
    );
};
