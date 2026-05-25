import {
    bindArg,
    bindArgs,
    combineLatestWith,
    domCreator,
    fillElemWidhCanvas,
    genClass,
    genProp,
    genRef,
    genTagDiv,
    genTagName,
    genText,
    on,
} from '@month/utils';
import { $tetris, $c, $info, $wrapper, $s, $start, $rotateR, $rotateL } from '@month/gen/styles';
import {
    FieldInstance,
    drawField,
    addFigureRandomFigure,
    Vector2D,
    initField,
    moveFieldFigure,
    getObservers,
    GAME_STATE_PLAY,
    GAME_STATE_END,
    rotateFieldFigureLeft,
    rotateFieldFigureRight,
    GameObserverState,
} from './field';

const draw = (
    ctx: Window,
    fieldInstance: FieldInstance,
    canvasCtx: CanvasRenderingContext2D
) => {
    fieldInstance(bindArg(canvasCtx, drawField));
    ctx.requestAnimationFrame(bindArgs([ctx, fieldInstance, canvasCtx], draw));
};

type FieldAction = () => any;
type KeyHandlers = Record<string, FieldAction>;

const getKeyHandlers = (
    ctx: Window,
    fieldInstance: FieldInstance
): KeyHandlers => {
    const figureBind: KeyHandlers = {
        Space: bindArg(ctx, addFigureRandomFigure) as any,
        KeyE: rotateFieldFigureLeft as any,
        KeyQ: rotateFieldFigureRight as any,
        // "KeyW": bindArgs([ctx, [0, -1]], moveFieldFigure),
        KeyS: bindArgs([ctx, [0, 1]], moveFieldFigure),
        KeyA: bindArgs([ctx, [-1, 0]], moveFieldFigure),
        KeyD: bindArgs([ctx, [1, 0]], moveFieldFigure),
    };
    for (let key in figureBind) {
        figureBind[key] = bindArg(figureBind[key], fieldInstance);
    }
    return figureBind;
};

const START_TEXT = 'Press SPACE to start';

const phoneControlsMap: [string, string][] = [
    ['Space', 'Start (Space)'],
    ['KeyE', 'Rotate Right (E)'],
    ['KeyQ', 'Rotate Left (Q)'],
    ['KeyA', 'Left (A)'],
    ['KeyS', 'Down (S)'],
    ['KeyD', 'Right (D)'],
];
const phoneStyleMap = (): Record<string, string> => ({
    Space: `${$start} ${$s}`,
    KeyE: `${$rotateR} ${$s}`,
    KeyQ: `${$rotateL} ${$s}`,
    KeyS: `down ${$s}`,
    KeyA: `left ${$s}`,
    KeyD: `right ${$s}`,
});

const addPhoneControls = (
    ctx: Window,
    element: HTMLDivElement,
    keyHandlers: KeyHandlers
) => {
    const styles_map = phoneStyleMap();
    domCreator(
        ctx,
        element,
        genTagDiv(
            [genClass($c)],
            phoneControlsMap.map(([key, name]) => {
                return genTagName('button', [
                    genClass(styles_map[key] ?? ''),
                    genText(name),
                    genProp('onclick', keyHandlers[key]),
                ]);
            })
        )
    );
};

const initCanvas = (ctx: Window, element: Element) => {
    const htmlElement = element as HTMLDivElement;
    htmlElement.innerHTML = '';
    htmlElement.classList.add($tetris);
    const boardSize: Vector2D = [10, 20];
    const infoTemplate = genTagDiv([
        genClass($info),
        genText(START_TEXT),
        genRef(),
    ]);
    const [wrapper, info] = domCreator(
        ctx,
        htmlElement,
        genTagDiv([genClass($wrapper), genRef()], [infoTemplate])
    );
    const [rect, canvas] = fillElemWidhCanvas(ctx, wrapper);
    var canvasCtx = canvas.getContext('2d');
    if (!canvasCtx) {
        return;
    }
    const [collums, rows] = boardSize;
    const collHeight = rect.height / rows;
    const collWidth = rect.width / collums;
    const collSize: Vector2D = [collWidth, collHeight];
    const fieldInstance = initField(ctx, boardSize, collSize);
    const keyHandlers = getKeyHandlers(ctx, fieldInstance);
    addPhoneControls(ctx, element as HTMLDivElement, keyHandlers);
    document.addEventListener('keydown', (e) => {
        if (keyHandlers[e.code]) {
            keyHandlers[e.code]();
        }
    });
    const [gameState, score] = fieldInstance(getObservers);
    const gameCombineObserver = combineLatestWith(gameState, score);
    gameCombineObserver(
        bindArg(([state, no]: [GameObserverState, number]) => {
            let score = no || 0;
            let gameState = '';
            if (state === GAME_STATE_END) {
                gameState = `Game Over. Your score ${score}`;
            } else if (state === GAME_STATE_PLAY) {
                gameState = `Score: ${score}`;
            }
            info.innerText = `${gameState}`;
        }, on)
    );
    draw(ctx, fieldInstance, canvasCtx);
};

export const initTetrisEffect = (ctx: Window) => {
    const tags = ctx.document.querySelectorAll('.js-tetris');
    ctx.Array.from(tags).forEach(bindArg(ctx, initCanvas));
};
