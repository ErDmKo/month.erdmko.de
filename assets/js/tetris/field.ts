import {
    bindArg,
    bindArgs,
    cont,
    observer,
    ObserverInstance,
    randomRange,
    trigger,
} from '@month/utils';
import {
    figureToField,
    createFigure,
    FigureInstance,
    fullFigureList,
    moveFigure,
    FigureState,
    isFixed,
    rotateFigure,
} from './figure';

export type ZeroOneString = 0 | 1 | string;

export type FieldType = ZeroOneString[][];
export type Vector2D = [width: number, height: number];
export const WIDTH_INDEX = 0;
export const HEIGHT_INDEX = 1;

export const GAME_STATE_PLAY = 0 as const;
export const GAME_STATE_END = 1 as const;

export type GameObserverState = typeof GAME_STATE_PLAY | typeof GAME_STATE_END;

export type GameObservers = [
    gameState: ObserverInstance<GameObserverState>,
    score: ObserverInstance<number>,
];

export type FieldState = [
    field: FieldType, // 0
    cellSize: Vector2D, // 1
    figure: FigureInstance[], // 2
    loop: number, // 3
    observers: GameObservers, // 4
    score: number, // 5
];
const LOOP_INDEX = 3;
const OBSERVERS_INDEX = 4;
const SCORE_INDEX = 5;

export type FieldInstance = <R>(a: (s: FieldState) => R) => R;

export const getObservers = (state: FieldState): GameObservers => {
    return state[OBSERVERS_INDEX];
};

export const applyToFigue = <R>(
    fn: (f: FigureState) => R,
    state: FieldState
) => {
    const [field, , figures] = state;
    const result = [];
    for (let figure of figures) {
        figure(bindArgs([field, 1], figureToField));
        result.push(figure(fn));
        figure(bindArgs([field, 0], figureToField));
    }
    return result;
};
export const rotateFieldFigureLeft = (state: FieldState) => {
    applyToFigue(bindArgs([state, false], rotateFigure), state);
};
export const rotateFieldFigureRight = (state: FieldState) => {
    applyToFigue(bindArgs([state, true], rotateFigure), state);
};
export const moveFieldFigure = (
    ctx: Window,
    vector: Vector2D,
    state: FieldState
) => {
    applyToFigue(bindArgs([ctx, vector, state], moveFigure), state);
};

const chekLines = (ctx: Window, state: FieldState) => {
    const [field] = state;
    const [gameState, score] = getObservers(state);
    const lines = [];
    for (let i = 0; i < field.length; i++) {
        let lineSum = 0;
        for (let j = 0; j < field[i].length; j++) {
            lineSum += field[i][j] ? 1 : 0;
        }
        if (lineSum == field[i].length) {
            lines.push(i);
        }
        if (!i && lineSum) {
            gameState(bindArg(GAME_STATE_END, trigger));
            ctx.clearTimeout(state[LOOP_INDEX]);
            state[LOOP_INDEX] = 0;
            return 0;
        }
    }
    for (const line of lines) {
        state[SCORE_INDEX] += 1;
        score(bindArg(state[SCORE_INDEX], trigger));
        for (let i = line; i > 0; i--) {
            for (let j = 0; j < field[i].length; j++) {
                field[i][j] = field[i - 1][j];
            }
        }
    }
    return lines.length;
};

const animateField = (ctx: Window, state: FieldState) => {
    const [, , figures] = state;
    moveFieldFigure(ctx, [0, 1], state);
    state[LOOP_INDEX] = ctx.setTimeout(
        bindArgs([ctx, state], animateField),
        1000 - state[SCORE_INDEX] * 10
    );

    for (let i = 0; i < figures.length; i++) {
        if (figures[i](isFixed)) {
            while (chekLines(ctx, state)) {}
            delete figures[i];
            figures.length = figures.length - 1;
            addFigureRandomFigure(ctx, state);
        }
    }
};

export const initField = (
    ctx: Window,
    boardSize: Vector2D,
    collSize: Vector2D
): FieldInstance => {
    const [collums, rows] = boardSize;
    const field: FieldType = [];
    for (let row = 0; row < rows; row++) {
        const rowArray = new ctx.Array(collums).fill(0);
        field.push(rowArray);
    }
    const gameOverObserver = observer<number, void>();
    const scoreObserver = observer<number>();
    const state: FieldState = [
        field,
        collSize,
        [] as FigureInstance[],
        0,
        [gameOverObserver, scoreObserver],
        0,
    ];
    animateField(ctx, state);

    return cont(state);
};

export const addFigureRandomFigure = (ctx: Window, state: FieldState) => {
    const [field, , figures] = state;
    const [gameState] = getObservers(state);
    if (state[LOOP_INDEX]) {
        // TODO optimistions needed in case if
        // it was previosly GAME_STATE_PLAY no need to update it again
        gameState(bindArg(GAME_STATE_PLAY, trigger));
    }
    if (figures.length) {
        return;
    }
    const figureShapeIndex = ctx.Math.round(
        randomRange(ctx, 0, fullFigureList.length - 1)
    );
    const center = ctx.Math.floor(field[0].length / 2);
    const centerPosition: Vector2D = [center - 2, 0];
    const figureInstance = createFigure(ctx, figureShapeIndex, centerPosition);
    figures.push(figureInstance);
};

export const drawField = (
    canvasCtx: CanvasRenderingContext2D,
    fieldState: FieldState
) => {
    const margin = 5;
    const [field, cellSize] = fieldState;
    const [width, height] = cellSize;
    const rows = field.length;
    const colls = field[0].length;
    const fullHeight = rows * height;
    const fullWidth = colls * width;
    canvasCtx.clearRect(0, 0, fullWidth, fullHeight);
    for (let row = 0; row < rows; row++) {
        const y = height * row;
        // horizontal line
        canvasCtx.fillRect(0, y - 1, fullWidth, 2);
        for (let coll = 0; coll < colls; coll++) {
            const x = width * coll;
            if (!row) {
                // vetrical line
                canvasCtx.fillRect(x - 1, 0, 2, fullHeight);
                if (coll == colls - 1) {
                    // the last right line
                    canvasCtx.fillRect(
                        (coll + 1) * width - 1,
                        0,
                        2,
                        fullHeight
                    );
                }
            }
            if (field[row][coll]) {
                const color = field[row][coll];
                if (typeof color == 'string') {
                    canvasCtx.fillStyle = color;
                }
                canvasCtx.fillRect(
                    x + margin,
                    y + margin,
                    width - margin * 2,
                    height - margin * 2
                );
                canvasCtx.fillStyle = '#000';
            }
        }
        // the last bottom line
        if (row == rows - 1) {
            canvasCtx.fillRect(0, height * (row + 1) - 1, fullWidth, 2);
        }
    }
};
