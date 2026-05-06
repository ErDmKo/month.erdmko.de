import { domCreator, genProp, genRef, genTagName } from './dom';

declare global {
    interface Window {
        Object: typeof Object;
        Array: typeof Array;
        Math: typeof Math;
    }
}
export const fillElemWidhCanvas = (
    ctx: Window,
    element: HTMLElement
): [DOMRect, HTMLCanvasElement] => {
    const [canvas] = domCreator(
        ctx,
        element,
        genTagName('canvas', [
            genRef(),
            genProp('style', {
                position: 'absolute',
                top: '0px',
                left: '0px',
                pointerEvents: 'none',
                width: '100%',
                height: '100%',
            }),
        ])
    );
    ctx.Object.assign(element.style, {
        position: 'relative',
    });
    const rectRaw = canvas.getBoundingClientRect();
    const rect = ctx.Object.assign(rectRaw, {
        width: rectRaw.width * 2,
        height: rectRaw.height * 2,
    });
    ctx.Object.assign(canvas, {
        width: rect.width,
        height: rect.height,
    });
    return [rect, canvas];
};
