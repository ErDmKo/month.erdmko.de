import {
    bindArg,
    noop,
    observer,
    once,
    pipe,
    taskChain,
    taskFork,
    trigger,
} from '@month/utils';
import type { ObserverState } from '@month/utils';
import type { ChatSocket } from './protocol/incoming';
import type { ServerFramePayload, ClientFramePayload } from '@month/gen/chat';
import {
    TELEMETRY_KIND_UNCAUGHT_ERROR,
    TELEMETRY_OP_CHAT_INIT,
    TELEMETRY_SEVERITY_ERROR,
} from '@month/gen/telemetry';
import { detectProviderFlags } from '@month/telemetry';
import { getActivePaymentConfig, PAYMENT_CONFIG_CHAIN_ID } from './auth';
import { initChatUi, CHAT_UI_ERROR, CHAT_UI_TELEMETRY } from './chat-ui/init';
import { initChatOnboarding } from './chat-ui/onboarding';
import type { ChatUiObs } from './chat-ui/events';
import { initMessages } from './messages/init';
import type { MsgsObs } from './messages/handler';
import { initAttachments } from './attachments/init';
import { initVoice } from './voice/index';
import {
    emitChatTelemetry,
    initChatTelemetry,
    wireChatUiTelemetry,
    wireIncomingTelemetry,
} from './telemetry';

declare global {
    interface Window {
        WebSocket: typeof WebSocket;
        JSON: typeof JSON;
        FileReader: typeof FileReader;
        Uint8Array: typeof Uint8Array;
        Date: typeof Date;
    }
}

const resolveChatChainId = (ctx: Window): number =>
    detectProviderFlags(ctx)
        ? getActivePaymentConfig(ctx)[PAYMENT_CONFIG_CHAIN_ID]
        : 0;

const reportFeatureInitError = (chatUiObs: ChatUiObs, err: unknown): void => {
    chatUiObs(
        bindArg(
            [
                CHAT_UI_TELEMETRY,
                [
                    TELEMETRY_SEVERITY_ERROR,
                    TELEMETRY_KIND_UNCAUGHT_ERROR,
                    TELEMETRY_OP_CHAT_INIT,
                    err,
                ],
            ] as const,
            trigger
        )
    );
    chatUiObs(bindArg([CHAT_UI_ERROR, String(err)] as const, trigger));
};

const reportRootInitError = (err: unknown): void => {
    emitChatTelemetry([
        TELEMETRY_SEVERITY_ERROR,
        TELEMETRY_KIND_UNCAUGHT_ERROR,
        TELEMETRY_OP_CHAT_INIT,
        err,
    ]);
};

const initTemplate = (ctx: Window, root: Element) => {
    const incoming: ObserverState<ServerFramePayload> = [];
    const outgoing = observer<ClientFramePayload>();
    const socket: ChatSocket = [outgoing, incoming];
    wireIncomingTelemetry(incoming);

    pipe(
        initChatUi(ctx, root, socket),
        taskFork((chatUiObs: ChatUiObs) => {
            wireChatUiTelemetry(chatUiObs);
            pipe(
                initMessages(ctx, socket, chatUiObs),
                taskChain((msgsObs: MsgsObs) =>
                    initAttachments(ctx, socket, chatUiObs, msgsObs)
                ),
                taskFork(noop, bindArg(chatUiObs, reportFeatureInitError))
            );
            pipe(
                initVoice(ctx, socket, chatUiObs),
                taskFork(noop, bindArg(chatUiObs, reportFeatureInitError))
            );
        }, reportRootInitError)
    );
};

export const initChatEffect = once((ctx: Window): void => {
    initChatTelemetry(ctx, resolveChatChainId);
    const onboardingTags = ctx.document.querySelectorAll('.js-chat-onboarding');
    ctx.Array.from(onboardingTags).forEach((el) => initChatOnboarding(ctx, el));
    const tags = ctx.document.querySelectorAll('.js-chat');
    ctx.Array.from(tags).forEach((el) => initTemplate(ctx, el));
});
