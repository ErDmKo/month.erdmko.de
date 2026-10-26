import {
    bindArg,
    genTagName,
    domCreator,
    domList,
    genClass,
    genOn,
    mapSignal,
    pipe,
    ReadonlySignal,
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
    LOG,
    SERVE,
    TEAM_LEFT,
    TEAM_LEFT_NAME,
    TEAM_RIGHT,
    TEAM_RIGHT_NAME,
    UPDATE_DATE,
    VOICE_ENABLED,
} from './const';

const eventOptions = { passive: true };

export const formatGameScore = (state: GameState): string => {
    const leftBall = state[SERVE] === TEAM_LEFT ? SERVE : '';
    const rightBall = state[SERVE] === TEAM_RIGHT ? SERVE : '';
    return `${leftBall}${state[TEAM_LEFT]}:${state[TEAM_RIGHT]}${rightBall}`;
};

export const formatGameTime = (state: GameState): string =>
    state[UPDATE_DATE].toLocaleTimeString();

export const formatVoiceStatus = (state: GameState): string =>
    state[VOICE_ENABLED] ? 'Voice control enabled' : 'Voice control disabled';

export const getGameLog = (state: GameState): readonly GameState[] =>
    state[LOG];

export const getGameLogKey = (state: GameState): string =>
    `${state[UPDATE_DATE].getTime()}-${state[TEAM_LEFT]}:${state[TEAM_RIGHT]}-${state[SERVE]}`;

export const gameStateItemView = (state: GameState) =>
    genTagName(
        'div',
        [],
        [
            genTagName('div', [genClass($time)], [formatGameTime(state)]),
            genTagName('div', [], [formatGameScore(state)]),
        ]
    );

export const template = (
    ctx: Window,
    root: HTMLElement,
    gameStateSig: ReadonlySignal<GameState>,
    onPlusOneLeft: () => void,
    onPlusOneRight: () => void,
    onVoiceToggle: () => void,
    onBack: () => void
): void => {
    const scoreTimeSig = pipe(gameStateSig, bindArg(formatGameTime, mapSignal));
    const scoreTextSig = pipe(
        gameStateSig,
        bindArg(formatGameScore, mapSignal)
    );
    const voiceTextSig = pipe(
        gameStateSig,
        bindArg(formatVoiceStatus, mapSignal)
    );
    const logListSig = pipe(gameStateSig, bindArg(getGameLog, mapSignal));

    domCreator(
        ctx,
        root,
        genTagName(
            'div',
            [genClass($wrapper)],
            [
                genTagName(
                    'button',
                    [
                        genClass($pOneL),
                        genOn('click', onPlusOneLeft, eventOptions),
                    ],
                    [`+1 ${TEAM_LEFT_NAME}`]
                ),
                genTagName(
                    'span',
                    [genClass($score)],
                    [
                        genTagName(
                            'span',
                            [],
                            [
                                genTagName(
                                    'div',
                                    [],
                                    [
                                        genTagName(
                                            'div',
                                            [genClass($time)],
                                            [scoreTimeSig]
                                        ),
                                        genTagName('div', [], [scoreTextSig]),
                                    ]
                                ),
                            ]
                        ),
                    ]
                ),
                genTagName(
                    'button',
                    [
                        genClass($pOneR),
                        genOn('click', onPlusOneRight, eventOptions),
                    ],
                    [`+1 ${TEAM_RIGHT_NAME}`]
                ),
                genTagName(
                    'button',
                    [genClass($voice), genOn('click', onVoiceToggle)],
                    [voiceTextSig]
                ),
                genTagName(
                    'button',
                    [genClass($voice), genOn('click', onBack)],
                    ['Back']
                ),
                genTagName(
                    'div',
                    [genClass('log')],
                    [
                        genTagName(
                            'span',
                            [],
                            [
                                domList(
                                    logListSig,
                                    getGameLogKey,
                                    gameStateItemView
                                ),
                            ]
                        ),
                    ]
                ),
            ]
        )
    );
};
