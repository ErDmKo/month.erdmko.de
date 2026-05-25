import { cont } from '@month/utils';
import {
    Vector2D,
    FieldType,
    ZeroOneString,
    WIDTH_INDEX,
    HEIGHT_INDEX,
    FieldState,
} from './field';

export type FigureState = [
    matrix: FieldType, // 0
    position: Vector2D, // 1
    isFixed: 0 | 1, // 2
    color: string, // 3
];

export const IS_FIXED_INDEX = 2;

export type FigureInstance = <R>(a: (s: FigureState) => R) => R;

const theT: FieldType = [
    [0, 0, 0],
    [0, 1, 0],
    [1, 1, 1],
];

const square: FieldType = [
    [1, 1],
    [1, 1],
];

const line: FieldType = [
    [0, 1, 0, 0],
    [0, 1, 0, 0],
    [0, 1, 0, 0],
    [0, 1, 0, 0],
];

const leftL: FieldType = [
    [0, 1, 0],
    [0, 1, 0],
    [1, 1, 0],
];

const rightL: FieldType = [
    [0, 1, 0],
    [0, 1, 0],
    [0, 1, 1],
];

const dogR: FieldType = [
    [0, 1, 1],
    [1, 1, 0],
];
const dogL: FieldType = [
    [1, 1, 0],
    [0, 1, 1],
];

export const fullFigureList: [figure: FieldType, color: string][] = [
    [theT, '#808001'], //0
    [dogL, '#008000'], //1
    [dogR, '#018080'], //2
    [rightL, '#888'], //3
    [leftL, '#008'], //4
    [line, '#800'], //5
    [square, '#808'], //6
];

export const validateState = (
    matrix: FieldType,
    position: Vector2D,
    fieldState: FieldState
): boolean => {
    const [newX, newY] = position;
    const [field] = fieldState;

    const sizeLeft = matrix[0].length;
    const sizeTop = matrix.length;

    let isNewPositionCorrect = true;

    for (let i = 0; i < sizeTop; i++) {
        for (let j = 0; j < sizeLeft; j++)
            if (matrix[i][j]) {
                const rowIndex = i + newY;
                const collIndex = j + newX;
                const isBottomEnd = field[rowIndex] === undefined;
                const fixedCheck = isBottomEnd || field[rowIndex][collIndex];
                if (fixedCheck || fixedCheck === undefined) {
                    isNewPositionCorrect = false;
                    break;
                }
            }
    }
    return isNewPositionCorrect;
};

export const rotateFigure = (
    fieldState: FieldState,
    isLeft: boolean,
    state: FigureState
) => {
    const [matrix, position] = state;
    const matrixHeight = matrix.length;
    const matrixWidth = matrix[0].length;
    const result: FieldType = [];
    for (let row = 0; row < matrixWidth; row++) {
        result[row] = [];
        for (let col = 0; col < matrixHeight; col++) {
            if (!isLeft) {
                result[row].push(matrix[matrixHeight - col - 1][row]);
            } else {
                result[row].push(matrix[col][matrixWidth - row - 1]);
            }
        }
    }
    const isValidState = validateState(result, position, fieldState);
    if (isValidState) {
        state[0] = result;
    }
};
export const figureToField = (
    field: FieldType,
    isClear: ZeroOneString,
    state: FigureState
) => {
    const [matrix, position, _isFixed, color] = state;
    const sizeLeft = matrix[0].length;
    const sizeTop = matrix.length;
    const [newX, newY] = position;
    for (let i = 0; i < sizeTop; i++) {
        for (let j = 0; j < sizeLeft; j++)
            if (matrix[i][j]) {
                const rowIndex = i + newY;
                const row = field[rowIndex];
                const collIndex = j + newX;
                row[collIndex] = isClear ? 0 : color;
            }
    }
};

export const isFixed = (state: FigureState) => {
    return state[IS_FIXED_INDEX];
};

export const moveFigure = (
    _ctx: Window,
    vector: [x: number, y: number],
    fieldState: FieldState,
    state: FigureState
) => {
    const [matrix, position, isFixed] = state;
    if (isFixed) {
        return state;
    }
    const [deltaX, deltaY] = vector;

    const [field] = fieldState;
    const [currentX, currentY] = position;
    const newX = currentX + deltaX;
    const newY = currentY + deltaY;
    const maxWidth = field[0].length;
    const maxHeight = field.length;
    const isValidPosition = validateState(matrix, [newX, newY], fieldState);
    if (!isValidPosition && deltaY) {
        state[IS_FIXED_INDEX] = 1;
    }
    if (!isValidPosition) {
        return;
    }
    position[WIDTH_INDEX] = newX;
    position[HEIGHT_INDEX] = newY;

    position[WIDTH_INDEX] = Math.min(position[WIDTH_INDEX], maxWidth);
    position[HEIGHT_INDEX] = Math.min(position[HEIGHT_INDEX], maxHeight);
};
export const createFigure = (
    _ctx: Window,
    figureShapeIndex: number,
    position: Vector2D
): FigureInstance => {
    const [matrix, color] = fullFigureList[figureShapeIndex];
    const state: FigureState = [matrix, position, 0, color];
    return cont(state);
};
