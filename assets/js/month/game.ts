import {
    bindArg,
    genTagName,
    cleanHtml,
    createStore,
    domCreator,
    domIf,
    DomScope,
    genClass,
    genOn,
    genProp,
    mapSignal,
    next,
    observer,
    pipe,
    randomRange,
    SIGNAL_GET,
    SIGNAL_SET,
    subscribe,
} from '@month/utils';
import { $month, $month__item } from '@month/gen/styles';
import { GAME_DURATION_SECONDS } from './const';

const SCORE_IS_ERROR = 0 as const;

type ScoreLog =
    | readonly [isError: false, monthNo: number]
    | readonly [isError: true, userAnswer: number, monthNo: number];

const HEADER_STYLE: Partial<CSSStyleDeclaration> = {
    fontSize: '30px',
    margin: '20px 0',
};

const OPTION_BTN_BASE_STYLE: Partial<CSSStyleDeclaration> = {
    width: '20%',
    height: '50px',
    margin: '5%',
};

const genMonth = (ctx: Window): number => {
    return Math.round(randomRange(ctx, 1, 12));
};

const formatTimerText = (ms: number): string => `${ms} ms`;

const formatButtonStyle = (
    backgroundColor: string
): Partial<CSSStyleDeclaration> => ({
    ...OPTION_BTN_BASE_STYLE,
    backgroundColor,
});

const report = (totalScore: readonly ScoreLog[]) => {
    const errors = totalScore.filter((entry) => entry[SCORE_IS_ERROR]).length;
    const correct = totalScore.length - errors;
    const totalResult = correct - errors;
    return genTagName(
        'div',
        [],
        [
            genTagName('h3', [], ['Время вышло!']),
            genTagName('h4', [], [`Итоговый результат игры: ${totalResult}`]),
            genTagName(
                'ul',
                [genClass($month)],
                [
                    genTagName(
                        'li',
                        [genClass($month__item)],
                        [`Ошибки: ${errors}`]
                    ),
                    genTagName(
                        'li',
                        [genClass($month__item)],
                        [`Верные ответы: ${correct}`]
                    ),
                    genTagName(
                        'li',
                        [genClass($month__item)],
                        [`Всего вопросов: ${totalScore.length}`]
                    ),
                ]
            ),
        ]
    );
};

export const render = (
    ctx: Window,
    monthNames: Record<string, string>,
    root: HTMLElement
): DomScope => {
    cleanHtml(root);

    const scope: DomScope = [];
    const totalScore: ScoreLog[] = [];
    const scoreObserver = observer<ScoreLog>();

    scoreObserver(
        subscribe((log) => {
            totalScore.push(log);
        })
    );

    const maxDurationMs = GAME_DURATION_SECONDS * 1000;
    const initialAnswer = genMonth(ctx);

    const isOverSig = createStore(false);
    const leftTimeSig = createStore(maxDurationMs);
    const answerSig = createStore(initialAnswer);
    const headerTextSig = createStore(monthNames[initialAnswer] || '');

    const timerTextSig = pipe(leftTimeSig, bindArg(formatTimerText, mapSignal));

    const buttonColorSigs = Array.from({ length: 12 }, () => createStore(''));
    const buttonLockedSigs = Array.from({ length: 12 }, () =>
        createStore(false)
    );

    const startNewQuestion = () => {
        const nextAnswer = genMonth(ctx);
        answerSig[SIGNAL_SET](nextAnswer);
        headerTextSig[SIGNAL_SET](monthNames[nextAnswer] || '');
        for (let idx = 0; idx < 12; idx++) {
            buttonColorSigs[idx][SIGNAL_SET]('');
            buttonLockedSigs[idx][SIGNAL_SET](false);
        }
    };

    let currentRequest = 0;
    let nextQuestionTimeout = 0;
    const startTime = ctx.performance.now();

    const nextTick = () => {
        currentRequest = ctx.requestAnimationFrame((stamp) => {
            const leftTime = Math.round(maxDurationMs - (stamp - startTime));
            if (leftTime > 0) {
                leftTimeSig[SIGNAL_SET](leftTime);
                nextTick();
            } else {
                leftTimeSig[SIGNAL_SET](0);
                isOverSig[SIGNAL_SET](true);
            }
        });
    };

    scope.push(() => {
        ctx.cancelAnimationFrame(currentRequest);
        ctx.clearTimeout(nextQuestionTimeout);
    });

    const gamePlayView = () =>
        genTagName(
            'div',
            [],
            [
                genTagName(
                    'div',
                    [genClass('game-timer')],
                    [
                        genTagName('span', [], ['Времени осталось: ']),
                        genTagName('span', [], [timerTextSig]),
                    ]
                ),
                genTagName(
                    'div',
                    [genProp('style', HEADER_STYLE)],
                    [headerTextSig]
                ),
                genTagName(
                    'div',
                    [genClass('options')],
                    Array.from({ length: 12 }, (_, idx) => {
                        const monthNo = idx + 1;
                        const colorSig = buttonColorSigs[idx];
                        const lockedSig = buttonLockedSigs[idx];
                        const styleSig = pipe(
                            colorSig,
                            bindArg(formatButtonStyle, mapSignal)
                        );

                        const handleClick = () => {
                            if (lockedSig[SIGNAL_GET]()) {
                                return;
                            }
                            lockedSig[SIGNAL_SET](true);
                            const currentAnswer = answerSig[SIGNAL_GET]();

                            if (monthNo === currentAnswer) {
                                colorSig[SIGNAL_SET]('green');
                                headerTextSig[SIGNAL_SET]('Правильно!');
                                scoreObserver(next([false, monthNo] as const));
                                for (let j = 0; j < 12; j++) {
                                    buttonLockedSigs[j][SIGNAL_SET](true);
                                }
                                nextQuestionTimeout = ctx.setTimeout(() => {
                                    if (!isOverSig[SIGNAL_GET]()) {
                                        startNewQuestion();
                                    }
                                }, 500);
                            } else {
                                colorSig[SIGNAL_SET]('red');
                                scoreObserver(
                                    next([
                                        true,
                                        monthNo,
                                        currentAnswer,
                                    ] as const)
                                );
                            }
                        };

                        return genTagName(
                            'button',
                            [
                                genProp('style', styleSig),
                                genOn('click', handleClick),
                            ],
                            [monthNo]
                        );
                    })
                ),
            ]
        );

    domCreator(
        ctx,
        root,
        genTagName(
            'div',
            [],
            [domIf(isOverSig, () => report(totalScore), gamePlayView)]
        ),
        scope
    );

    nextTick();
    return scope;
};
