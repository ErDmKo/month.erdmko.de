import { bindArg } from '@month/utils';
import { init } from './app';

const initTemplate = (ctx: Window, root: HTMLElement) => {
    init(ctx, root);
};

export const initEffect = (ctx: Window) => {
    const tags = ctx.document.querySelectorAll('.js-month');
    ctx.Array.from(tags).forEach(bindArg(ctx, initTemplate));
};
