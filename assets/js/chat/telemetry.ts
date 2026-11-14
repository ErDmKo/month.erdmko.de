import { bindArg, on, trigger } from '@month/utils';
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
import type { TelemetryObs } from '@month/telemetry';
import {
    CHAT_UI_EVENT_TYPE,
    CHAT_UI_TELEMETRY,
    CHAT_UI_TELEMETRY_INPUT,
} from './chat-ui/events';
import type { ChatUiEvent, ChatUiObs } from './chat-ui/events';

const handleIncomingServerFrame = (
    telemetryObs: TelemetryObs,
    frame: ServerFramePayload
): void => {
    const variant = frame[SERVER_FRAME_PAYLOAD_VARIANT];
    if (variant === SERVER_FRAME_ERROR) {
        const errVal = frame[SERVER_FRAME_PAYLOAD_VALUE];
        telemetryObs(
            bindArg(
                [
                    TELEMETRY_SEVERITY_WARN,
                    TELEMETRY_KIND_WS,
                    TELEMETRY_OP_WS_SERVER_ERROR,
                    errVal[SERVER_ERROR_MESSAGE] || 'Server error',
                    errVal[SERVER_ERROR_CODE],
                ] as const,
                trigger
            )
        );
    } else if (variant === SERVER_FRAME_VOICE_ERROR) {
        const code = frame[SERVER_FRAME_PAYLOAD_VALUE][SERVER_VOICE_ERROR_CODE];
        telemetryObs(
            bindArg(
                [
                    TELEMETRY_SEVERITY_WARN,
                    TELEMETRY_KIND_WEBRTC,
                    TELEMETRY_OP_VOICE_SIGNALING,
                    code,
                    code,
                ] as const,
                trigger
            )
        );
    }
};

const handleChatUiEvent = (
    telemetryObs: TelemetryObs,
    event: ChatUiEvent
): void => {
    if (event[CHAT_UI_EVENT_TYPE] === CHAT_UI_TELEMETRY) {
        telemetryObs(bindArg(event[CHAT_UI_TELEMETRY_INPUT], trigger));
    }
};

export const wireIncomingTelemetry = (
    telemetryObs: TelemetryObs,
    incoming: ObserverState<ServerFramePayload>
): void => {
    on(bindArg(telemetryObs, handleIncomingServerFrame), incoming);
};

export const wireChatUiTelemetry = (
    telemetryObs: TelemetryObs,
    chatUiObs: ChatUiObs
): void => {
    chatUiObs(bindArg(bindArg(telemetryObs, handleChatUiEvent), on));
};
