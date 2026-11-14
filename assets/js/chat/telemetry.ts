import {
    bindArg,
    isObject,
    objectStruct,
    on,
    once,
    validate,
} from '@month/utils';
import type { ObserverState, ReadonlyTupleOf } from '@month/utils';
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
    TELEMETRY_PROVIDER_FLAG_BRAVE,
    TELEMETRY_PROVIDER_FLAG_COINBASE,
    TELEMETRY_PROVIDER_FLAG_ETHEREUM,
    TELEMETRY_PROVIDER_FLAG_METAMASK,
    TELEMETRY_PROVIDER_FLAG_NONE,
    TELEMETRY_PROVIDER_FLAG_PHANTOM,
    TELEMETRY_PROVIDER_FLAG_RABBY,
    TELEMETRY_SEVERITY_WARN,
} from '@month/gen/telemetry';
import {
    initTelemetry,
    recordTelemetry,
    TELEM_INPUT_CODE,
    TELEM_INPUT_COL,
    TELEM_INPUT_ERROR,
    TELEM_INPUT_KIND,
    TELEM_INPUT_LINE,
    TELEM_INPUT_OP,
    TELEM_INPUT_SEVERITY,
} from '@month/telemetry';
import type { TelemetryInput } from '@month/telemetry';
import { getActivePaymentConfig, PAYMENT_CONFIG_CHAIN_ID } from './auth/api';
import {
    CHAT_UI_EVENT_TYPE,
    CHAT_UI_TELEMETRY,
    CHAT_UI_TELEMETRY_INPUT,
} from './chat-ui/events';
import type { ChatUiEvent, ChatUiObs } from './chat-ui/events';

const FLAG_KEY = 0 as const;
const FLAG_BIT = 1 as const;

type ProviderFlagEntry = ReadonlyTupleOf<{
    [FLAG_KEY]: string;
    [FLAG_BIT]: number;
}>;

const PROVIDER_FLAGS: readonly ProviderFlagEntry[] = [
    ['isMetaMask', TELEMETRY_PROVIDER_FLAG_METAMASK],
    ['isPhantom', TELEMETRY_PROVIDER_FLAG_PHANTOM],
    ['isCoinbaseWallet', TELEMETRY_PROVIDER_FLAG_COINBASE],
    ['isRabby', TELEMETRY_PROVIDER_FLAG_RABBY],
    ['isBraveWallet', TELEMETRY_PROVIDER_FLAG_BRAVE],
];

const WIN_ETH_OBJ = 0 as const;
const ethereumObjStruct = objectStruct(['ethereum', isObject]);

export const detectProviderFlags = (ctx: Window): number => {
    const parsed = validate(ctx, ethereumObjStruct);
    if (!parsed) return TELEMETRY_PROVIDER_FLAG_NONE;
    const eth = parsed[WIN_ETH_OBJ];
    let flags: number = TELEMETRY_PROVIDER_FLAG_ETHEREUM;
    for (const rule of PROVIDER_FLAGS) {
        if (eth[rule[FLAG_KEY]] === true) flags |= rule[FLAG_BIT];
    }
    return flags;
};

export const initChatTelemetry = once(initTelemetry);

export const emitChatTelemetry = (ctx: Window, input: TelemetryInput): void => {
    const providerFlags = detectProviderFlags(ctx);
    const chainId = providerFlags
        ? getActivePaymentConfig(ctx)[PAYMENT_CONFIG_CHAIN_ID]
        : 0;
    recordTelemetry(
        ctx,
        [
            input[TELEM_INPUT_SEVERITY],
            input[TELEM_INPUT_KIND],
            input[TELEM_INPUT_OP],
            input[TELEM_INPUT_ERROR],
            input.length > TELEM_INPUT_CODE ? input[TELEM_INPUT_CODE] : '',
            input.length > TELEM_INPUT_LINE ? input[TELEM_INPUT_LINE] : 0,
            input.length > TELEM_INPUT_COL ? input[TELEM_INPUT_COL] : 0,
            chainId,
            providerFlags,
        ],
        initChatTelemetry(ctx)
    );
};

const handleIncomingServerFrame = (
    ctx: Window,
    frame: ServerFramePayload
): void => {
    const variant = frame[SERVER_FRAME_PAYLOAD_VARIANT];
    if (variant === SERVER_FRAME_ERROR) {
        const errVal = frame[SERVER_FRAME_PAYLOAD_VALUE];
        emitChatTelemetry(ctx, [
            TELEMETRY_SEVERITY_WARN,
            TELEMETRY_KIND_WS,
            TELEMETRY_OP_WS_SERVER_ERROR,
            errVal[SERVER_ERROR_MESSAGE] || 'Server error',
            errVal[SERVER_ERROR_CODE],
        ]);
    } else if (variant === SERVER_FRAME_VOICE_ERROR) {
        const code = frame[SERVER_FRAME_PAYLOAD_VALUE][SERVER_VOICE_ERROR_CODE];
        emitChatTelemetry(ctx, [
            TELEMETRY_SEVERITY_WARN,
            TELEMETRY_KIND_WEBRTC,
            TELEMETRY_OP_VOICE_SIGNALING,
            code,
            code,
        ]);
    }
};

const handleChatUiEvent = (ctx: Window, event: ChatUiEvent): void => {
    if (event[CHAT_UI_EVENT_TYPE] === CHAT_UI_TELEMETRY) {
        emitChatTelemetry(ctx, event[CHAT_UI_TELEMETRY_INPUT]);
    }
};

export const wireIncomingTelemetry = (
    ctx: Window,
    incoming: ObserverState<ServerFramePayload>
): void => {
    on(bindArg(ctx, handleIncomingServerFrame), incoming);
};

export const wireChatUiTelemetry = (
    ctx: Window,
    chatUiObs: ChatUiObs
): void => {
    chatUiObs(bindArg(bindArg(ctx, handleChatUiEvent), on));
};
