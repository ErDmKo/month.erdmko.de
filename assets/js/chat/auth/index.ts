import { pipe, taskChain } from '@month/utils';
import type { Task } from '@month/utils';
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

export {
    buildSiweMessage,
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

export const payAndClaimTask = (
    ctx: Window,
    fromWallet: string,
    nickname: string,
    toWallet: string = RECIPIENT_WALLET_ADDRESS,
    valueHex: string = DEFAULT_PAYMENT_VALUE_HEX
): Task<SessionStatus> =>
    pipe(
        sendPaymentTransactionTask(ctx, fromWallet, toWallet, valueHex),
        taskChain((txHash: string) => claimPaymentTask(ctx, txHash, nickname))
    );
