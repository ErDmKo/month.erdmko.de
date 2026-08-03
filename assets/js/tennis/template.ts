import {
    domCreator,
    genClass,
    genRef,
    genTagDiv,
    genTagName,
    genText,
} from '@month/utils';
import {
    $wrapper,
    $pOneL,
    $score,
    $pOneR,
    $voice,
    $time,
} from '@month/gen/styles';
import {
    GameState,
    SERVE,
    TEAM_LEFT,
    TEAM_LEFT_NAME,
    TEAM_RIGHT,
    TEAM_RIGHT_NAME,
    UPDATE_DATE,
} from './const';

export const gameStateRender = (
    ctx: Window,
    root: HTMLElement,
    stateList: GameState[]
) => {
    while (root.firstChild) {
        root.removeChild(root.firstChild);
    }
    const historyInfo = stateList.map((state) => {
        const {
            [TEAM_LEFT]: teamLeft,
            [TEAM_RIGHT]: teamRight,
            [UPDATE_DATE]: updateDate,
        } = state;
        const leftBall = state[SERVE] == TEAM_LEFT ? SERVE : '';
        const rightBall = state[SERVE] == TEAM_RIGHT ? SERVE : '';
        const stateString = `${leftBall}${teamLeft}:${teamRight}${rightBall}`;
        const time = `${updateDate.toLocaleTimeString()}`;
        return genTagDiv(
            [],
            [
                genTagDiv([genClass($time), genText(time)]),
                genTagDiv([genText(stateString)]),
            ]
        );
    });
    const [res] = domCreator(
        ctx,
        root,
        genTagName('span', [genRef()], historyInfo)
    );
    root.appendChild(res);
    return res;
};

export const template = (ctx: Window, root: HTMLElement) => {
    const res = domCreator(
        ctx,
        root,
        genTagDiv(
            [genClass($wrapper), genRef()],
            [
                genTagName('button', [
                    genClass($pOneL),
                    genText(`+1 ${TEAM_LEFT_NAME}`),
                    genRef(),
                ]),
                genTagName('span', [genClass($score), genRef()]),
                genTagName('button', [
                    genClass($pOneR),
                    genText(`+1 ${TEAM_RIGHT_NAME}`),
                    genRef(),
                ]),
                genTagName('button', [
                    genClass($voice),
                    genText('Voice control disabled'),
                    genRef(),
                ]),
                genTagName('button', [
                    genClass($voice),
                    genText('Back'),
                    genRef(),
                ]),
                genTagDiv([genClass('log'), genRef()]),
            ]
        )
    );
    return res as [
        HTMLDivElement,
        HTMLButtonElement,
        HTMLSpanElement,
        HTMLButtonElement,
        HTMLButtonElement,
        HTMLDivElement,
        HTMLDivElement,
    ];
};
