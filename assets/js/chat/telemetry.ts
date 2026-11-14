import {
    bindArg,
    noop,
    observer,
    on,
    once,
    pipe,
    taskFork,
    trigger,
} from '@month/utils';
import type { ObserverState } from '@month/utils';
import {
    SERVER_ERROR_CODE,
    SERVER_ERROR_MESSAGE,
    SERVER_FRAME_ERROR,
    SERVER_FRAME_PAYLOAD_VALUE,
    SERVER_FRAME_PAYLOAD_VARIANT,
    SERVER_FRAME_VOICE_ERROR,
    SERVER_VOICE_ERROR_CODE,
} from '@month/gen/chat';
import type { ServerFramePayload } from '@month/gen/chat';
import {
    TELEMETRY_KIND_WEBRTC,
    TELEMETRY_KIND_WS,
    TELEMETRY_OP_VOICE_SIGNALING,
    TELEMETRY_OP_WS_SERVER_ERROR,
    TELEMETRY_SEVERITY_WARN,
} from '@month/gen/telemetry';
import { initTelemetry } from '@month/telemetry';
import type { TelemetryInput, TelemetryObs } from '@month/telemetry';
import {
    CHAT_UI_EVENT_TYPE,
    CHAT_UI_TELEMETRY,
    CHAT_UI_TELEMETRY_INPUT,
} from './chat-ui/events';
import type { ChatUiEvent, ChatUiObs } from './chat-ui/events';

const chatTelemetryObs: TelemetryObs = observer<TelemetryInput>();

export const emitChatTelemetry = (input: TelemetryInput): void => {
    chatTelemetryObs(bindArg(input, trigger));
};

export const initChatTelemetry = once(
    (ctx: Window, resolveChainId: (ctx: Window) => number): void => {
        pipe(
            initTelemetry(ctx, resolveChainId, [], chatTelemetryObs),
            taskFork(noop, noop)
        );
    }
);

const handleIncomingServerFrame = (frame: ServerFramePayload): void => {
    const variant = frame[SERVER_FRAME_PAYLOAD_VARIANT];
    if (variant === SERVER_FRAME_ERROR) {
        const errVal = frame[SERVER_FRAME_PAYLOAD_VALUE];
        emitChatTelemetry([
            TELEMETRY_SEVERITY_WARN,
            TELEMETRY_KIND_WS,
            TELEMETRY_OP_WS_SERVER_ERROR,
            errVal[SERVER_ERROR_MESSAGE] || 'Server error',
            errVal[SERVER_ERROR_CODE],
        ]);
    } else if (variant === SERVER_FRAME_VOICE_ERROR) {
        const code = frame[SERVER_FRAME_PAYLOAD_VALUE][SERVER_VOICE_ERROR_CODE];
        emitChatTelemetry([
            TELEMETRY_SEVERITY_WARN,
            TELEMETRY_KIND_WEBRTC,
            TELEMETRY_OP_VOICE_SIGNALING,
            code,
            code,
        ]);
    }
};

const handleChatUiEvent = (event: ChatUiEvent): void => {
    if (event[CHAT_UI_EVENT_TYPE] === CHAT_UI_TELEMETRY) {
        emitChatTelemetry(event[CHAT_UI_TELEMETRY_INPUT]);
    }
};

export const wireIncomingTelemetry = (
    incoming: ObserverState<ServerFramePayload>
): void => {
    on(handleIncomingServerFrame, incoming);
};

export const wireChatUiTelemetry = (chatUiObs: ChatUiObs): void => {
    chatUiObs(bindArg(handleChatUiEvent, on));
};
