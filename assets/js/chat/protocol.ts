export const JOIN_TYPE = 0 as const;
export const MESSAGE_TYPE = 1 as const;
export const MAX_MESSAGE_LEN = 200;
export const MAX_NICKNAME_LEN = 32;

type OutgoingType = typeof JOIN_TYPE | typeof MESSAGE_TYPE;

export type SendCommand =
    | readonly [type: typeof JOIN_TYPE, requestId: string, nickname: string]
    | readonly [type: typeof MESSAGE_TYPE, requestId: string, body: string];

export type OutgoingWsEvent =
    | { type: 'join'; requestId: string; nickname: string }
    | { type: 'message'; requestId: string; body: string };

const isAllowedType = (eventType: number): eventType is OutgoingType => {
    return eventType === JOIN_TYPE || eventType === MESSAGE_TYPE;
};

export const serializeCommand = (command: SendCommand): OutgoingWsEvent | null => {
    const [type, requestId, payload] = command;
    if (!isAllowedType(type)) {
        return null;
    }
    if (type === JOIN_TYPE) {
        return { type: 'join', requestId, nickname: payload };
    }
    return { type: 'message', requestId, body: payload };
};

export const validateOutgoingCommand = (command: SendCommand): string | null => {
    const [type, _requestId, payload] = command;
    if (type === JOIN_TYPE) {
        const nickname = payload.trim();
        if (nickname.length === 0 || nickname.length > MAX_NICKNAME_LEN) {
            return `Nickname must be between 1 and ${MAX_NICKNAME_LEN} characters.`;
        }
        return null;
    }
    const body = payload.trim();
    if (body.length === 0 || body.length > MAX_MESSAGE_LEN) {
        return `Message must be between 1 and ${MAX_MESSAGE_LEN} characters.`;
    }
    return null;
};
