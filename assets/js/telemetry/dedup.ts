export const DEDUP_WINDOW_MS = 5000;
export const MAX_DEDUP_ENTRIES = 64;

export type DedupState = Map<string, number>;

export const createDedupState = (): DedupState => new Map();

export const shouldRecordEvent = (
    nowMs: number,
    kind: number,
    op: number,
    code: string,
    message: string,
    windowMs: number,
    state: DedupState
): boolean => {
    const key = `${kind}:${op}:${code}:${message}`;
    const prevMs = state.get(key);
    if (prevMs !== undefined && nowMs - prevMs < windowMs) {
        return false;
    }

    if (!state.has(key) && state.size >= MAX_DEDUP_ENTRIES) {
        for (const [k, ts] of state) {
            if (nowMs - ts >= windowMs) {
                state.delete(k);
            }
        }
        if (state.size >= MAX_DEDUP_ENTRIES) {
            const oldestKey = state.keys().next().value;
            if (oldestKey !== undefined) {
                state.delete(oldestKey);
            }
        }
    }

    state.delete(key);
    state.set(key, nowMs);
    return true;
};
