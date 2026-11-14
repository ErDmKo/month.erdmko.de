export * from './bind';
export * from './async';
export * from './pipe';
export * from './random';
export * from './canvas';
export * from './cont';
export * from './observer';
export * from './dom';
export * from './tuple';
export * from './validator';

declare global {
    interface Window {
        Date: typeof Date;
        Event: typeof Event;
        File: typeof File;
        JSON: typeof JSON;
        KeyboardEvent: typeof KeyboardEvent;
        Uint8Array: typeof Uint8Array;
        fetch: typeof fetch;
        localStorage: Storage;
        readonly navigator: Navigator;
        location: Location;
        addEventListener(
            type: string,
            listener: EventListenerOrEventListenerObject,
            options?: boolean | AddEventListenerOptions
        ): void;
        removeEventListener(
            type: string,
            listener: EventListenerOrEventListenerObject,
            options?: boolean | EventListenerOptions
        ): void;
    }
}
