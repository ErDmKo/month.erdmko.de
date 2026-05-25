import {
    cleanHtml,
    domCreator,
    genClass,
    genProp,
    genRef,
    genTagDiv,
    genTagName,
    genText,
    observer,
    randomRange,
    next,
    subscribe,
} from '@month/utils';
import { $month, $month__item } from '@month/gen/styles';
import { GAME_DURATION_SECONDS } from './const';

const genMonth = (ctx: Window) => {
    return Math.round(randomRange(ctx, 1, 12));
};

type GameState = [isOver: boolean, answer?: number];

type ScoreLog =
    | [isError: false, monthNo: number]
    | [isError: true, userAnswer: number, monthNo: number];

const report = (_ctx: Window, totalScore: ScoreLog[]) => {
    const errors = totalScore.filter(([isError]) => isError).length;
    const correct = totalScore.length - errors;
    const totalResult = correct - errors;
    return [
        genTagName('h3', [genText('Время вышло!')]),
        genTagName('h4', [genText(`Итоговый результат игры: ${totalResult}`)]),
        genTagName(
            'ul',
            [genClass($month)],
            [
                genTagName('li', [
                    genClass($month__item),
                    genText(`Ошибки: ${errors}`),
                ]),
                genTagName('li', [
                    genClass($month__item),
                    genText(`Верные ответы: ${correct}`),
                ]),
                genTagName('li', [
                    genClass($month__item),
                    genText(`Всего вопросов: ${totalScore.length}`),
                ]),
            ]
        ),
    ];
};

export const render = (
    ctx: Window,
    monthNames: Record<string, string>,
    root: HTMLElement
) => {
    let headerRefer: HTMLElement | undefined;
    let timeRefer: HTMLElement | undefined;
    const timeObserver = observer<number>();
    const gameStateObserver = observer<GameState>();
    const totalScore: ScoreLog[] = [];
    const scoreObserver = observer<ScoreLog>();

    scoreObserver(
        subscribe((log) => {
            totalScore.push(log);
        })
    );

    let currentRequest: number = 0;

    const startTime = performance.now();
    const maxDurationMs = GAME_DURATION_SECONDS * 1000;

    const nextTick = () => {
        currentRequest = ctx.requestAnimationFrame((stamp) => {
            timeObserver(next(stamp - startTime));
        });
    };
    timeObserver(
        subscribe((passedTimeMs: number) => {
            const leftTime = Math.round(maxDurationMs - passedTimeMs);
            if (leftTime > 0) {
                nextTick();
                if (timeRefer) {
                    timeRefer.innerText = `${leftTime} ms`;
                }
            } else {
                gameStateObserver(next([true]));
            }
        })
    );

    gameStateObserver(
        subscribe(([isOver, answer]) => {
            cleanHtml(root);
            if (isOver) {
                return domCreator(ctx, root, report(ctx, totalScore));
            }
            const out = [
                genTagDiv(
                    [genClass('game-timer')],
                    [
                        genTagName('span', [genText('Времени осталось: ')]),
                        genTagName('span', [
                            genRef(),
                            genText(`${GAME_DURATION_SECONDS * 1000} ms`),
                        ]),
                    ]
                ),
                genTagDiv([
                    genRef(),
                    genProp('style', {
                        fontSize: '30px',
                        margin: '20px 0',
                    }),
                    genText(monthNames[answer]),
                ]),
                genTagDiv(
                    [genClass('options')],
                    Array.from({ length: 12 }).map((_, i) => {
                        const monthNo = i + 1;
                        const handleClick = (e: MouseEvent) => {
                            const target = e.currentTarget;
                            if (!(target instanceof HTMLElement)) {
                                return;
                            }
                            if (monthNo === answer) {
                                target.style.backgroundColor = 'green';
                                if (headerRefer) {
                                    headerRefer.innerHTML = `Правильно!`;
                                }
                                scoreObserver(next([false, monthNo]));
                                ctx.setTimeout(() => {
                                    ctx.cancelAnimationFrame(currentRequest);
                                    gameStateObserver(
                                        next([false, genMonth(ctx)])
                                    );
                                }, 500);
                            } else {
                                target.style.backgroundColor = 'red';
                                scoreObserver(next([true, monthNo, answer]));
                            }
                            target.removeEventListener('click', handleClick);
                        };
                        return genTagName('button', [
                            genText(monthNo),
                            genProp('style', {
                                width: '20%',
                                height: '50px',
                                margin: '5%',
                            }),
                            genProp('onclick', handleClick),
                        ]);
                    })
                ),
            ];
            const refers = domCreator(ctx, root, out);
            [headerRefer, timeRefer] = refers;
            nextTick();
        })
    );

    gameStateObserver(next([false, genMonth(ctx)]));
};
