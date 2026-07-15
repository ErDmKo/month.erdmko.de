// Shared debug-logger — every tag is opt-in via
// `localStorage.setItem('debug', '<tag1>,<tag2>,...')`.
//
// With no opt-in, `log(...)` is a no-op: nothing ever reaches `console.log`.
// This is what makes it safe for production builds without needing a
// separate build-time flag/environment — logging is inert by default and
// only a developer explicitly turning it on (via their own browser's
// localStorage) will ever see it.
//
// Usage:
//   const voiceLog = createLogger('voice');
//   voiceLog(ctx, 'ontrack fired', details);
//   // → localStorage.setItem('debug', 'voice') enables it
//   // → localStorage.setItem('debug', 'ws,voice') enables both loggers

import { bindArg } from './bind';

declare global {
    interface Window {
        localStorage: Storage;
        console: Console;
    }
}

const isEnabled = (ctx: Window, tag: string): boolean => {
    try {
        return ctx.localStorage?.getItem('debug')?.includes(tag) ?? false;
    } catch {
        return false;
    }
};

export const log = (tag: string, ctx: Window, ...args: unknown[]): void => {
    if (!isEnabled(ctx, tag)) return;
    ctx.console.log(`[${tag}]`, ...args);
};

// createLogger(tag) === bindArg(tag, log) — pre-applies the tag once per
// module so call sites only ever pass (ctx, ...args).
export const createLogger = (tag: string) => bindArg(tag, log);
