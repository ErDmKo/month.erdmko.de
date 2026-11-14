import { Window as HappyWindow } from 'happy-dom';

export type TestWindowOptions = {
    url?: string;
    overrides?: Record<string, unknown>;
};

export const createTestWindow = (options?: TestWindowOptions): Window => {
    const happyWin = new HappyWindow({
        url: options?.url ?? 'https://erdmko.dev/chat',
        settings: {
            disableJavaScriptEvaluation: true,
            disableJavaScriptFileLoading: true,
            disableCSSFileLoading: true,
            disableIframePageLoading: true,
            navigation: {
                disableMainFrameNavigation: true,
            },
        },
    });
    const win = happyWin as unknown as Record<string, unknown>;

    win['String'] = String;
    win['Uint8Array'] = Uint8Array;
    win['ArrayBuffer'] = ArrayBuffer;
    win['TextEncoder'] = TextEncoder;
    win['TextDecoder'] = TextDecoder;
    win['Blob'] = Blob;
    win['atob'] = atob;
    win['btoa'] = btoa;
    win['fetch'] = async () => ({
        ok: true,
        status: 204,
        arrayBuffer: async () => new ArrayBuffer(0),
    });

    if (options?.overrides) {
        Object.assign(win, options.overrides);
    }

    return win as unknown as Window;
};
