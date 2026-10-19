import {
    animateSnowflake,
    drawSnowflake,
    initSnowflake,
    SnowFlakeInstance,
} from './snowflake';
import {
    bindArg,
    bindArgs,
    fillElemWidhCanvas,
    randomRange,
} from '@month/utils';

declare global {
    interface Window {
        Object: typeof Object;
        Array: typeof Array;
        Math: typeof Math;
    }
}

const draw = (
    ctx: Window,
    canvasCtx: CanvasRenderingContext2D,
    snowflakes: SnowFlakeInstance[],
    rect: { width: number; height: number }
) => {
    canvasCtx.clearRect(0, 0, rect.width, rect.height);
    snowflakes.forEach((snowflake) => {
        snowflake(bindArg(ctx, animateSnowflake));
        snowflake(bindArg(canvasCtx, drawSnowflake));
    });
    ctx.requestAnimationFrame(
        bindArgs([ctx, canvasCtx, snowflakes, rect], draw)
    );
};
export const initCanvas = (ctx: Window, tag: Element) => {
    const [rect, canvas] = fillElemWidhCanvas(ctx, tag as HTMLDivElement);
    const snowflakes = [];
    for (let i = 0; i < 100; i++) {
        snowflakes.push(
            initSnowflake(ctx, {
                position: [rect.width, rect.height],
                curentPosition: [
                    randomRange(ctx, 0, rect.width),
                    randomRange(ctx, 0, rect.height),
                ],
            })
        );
    }
    var canvasCtx = canvas.getContext('2d');
    if (!canvasCtx) {
        return;
    }
    draw(ctx, canvasCtx, snowflakes, rect);
};
export const initSnowflakeEffect = (ctx: Window) => {
    const tags = ctx.document.querySelectorAll('.js-header');
    ctx.Array.from(tags).forEach(bindArg(ctx, initCanvas));
};
