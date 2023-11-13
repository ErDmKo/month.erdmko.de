import { bindArg, observer, on, trigger } from '@month/utils';
import {
    Sides,
    TEAM_LEFT,
    TEAM_LEFT_NAME,
    TEAM_RIGHT,
    TEAM_RIGHT_NAME,
} from './const';
import {
    Commands,
    COMMAND_TYPE,
    LOG_TYPE,
    START_TYPE,
    STOP_TYPE,
} from './const';
import { useScreenLoock } from './screen';
import { startListen } from './speech';

const SERVE = '🏓' as const;
const LOG = 3 as const;
const VOICE_ENABLED = 4 as const;

type GameState = {
    [TEAM_LEFT]: number;
    [TEAM_RIGHT]: number;
    [SERVE]: Sides[keyof Sides];
    [LOG]: string[];
    [VOICE_ENABLED]: boolean;
};
const eventOptions = { passive: true };

const initTemplate = (ctx: Window, element: Element) => {
    const state: GameState = {
        [TEAM_LEFT]: 0,
        [TEAM_RIGHT]: 0,
        [SERVE]: TEAM_LEFT,
        [LOG]: [],
        [VOICE_ENABLED]: false,
    };
    const gameStateObserver = observer<number, void>();
    const htmlElement = element as HTMLDivElement;
    htmlElement.innerText = '';
    htmlElement.classList.add('tennis');
    const wrapper = ctx.document.createElement('div');
    wrapper.classList.add('wrapper');
    const voiceCommands = ctx.document.createElement('button');
    voiceCommands.classList.add('voice');
    voiceCommands.innerText = 'Voice control disabled';
    const plusOneLeft = ctx.document.createElement('button');
    plusOneLeft.classList.add('pOneL');
    plusOneLeft.innerText = `+1 ${TEAM_LEFT_NAME}`;
    const plusOneRight = ctx.document.createElement('button');
    plusOneRight.classList.add('pOneR');
    plusOneRight.innerText = `+1 ${TEAM_RIGHT_NAME}`;
    const scoreElement = ctx.document.createElement('span');
    scoreElement.classList.add('score');
    scoreElement.innerText = `${SERVE}0:0`;

    const logElement = ctx.document.createElement('div');
    logElement.classList.add('log');

    gameStateObserver(
        bindArg(() => {
            const {
                [TEAM_LEFT]: teamLeft,
                [TEAM_RIGHT]: teamRight,
                [SERVE]: serve,
            } = state;

            logElement.innerHTML = state[LOG].map(
                (log, i) => `<div>${i}: "${log}"</div>`
            ).join('');

            voiceCommands.innerText = state[VOICE_ENABLED]
                ? `Voice control enabled`
                : `Voice control disabled`;

            if (teamLeft == 0 && teamRight == 0) {
                return;
            }
            if (!((teamRight + teamLeft) % 2)) {
                state[SERVE] = serve == TEAM_RIGHT ? TEAM_LEFT : TEAM_RIGHT;
            }
            const leftBall = state[SERVE] == TEAM_LEFT ? SERVE : '';
            const rightBall = state[SERVE] == TEAM_RIGHT ? SERVE : '';
            scoreElement.innerText = `${leftBall}${teamLeft}:${teamRight}${rightBall}`;
        }, on)
    );

    htmlElement.appendChild(wrapper);
    wrapper.appendChild(plusOneLeft);
    wrapper.appendChild(scoreElement);
    wrapper.appendChild(plusOneRight);
    wrapper.appendChild(voiceCommands);
    wrapper.appendChild(logElement);

    const voiceControlObserver = startListen(ctx);
    useScreenLoock(ctx, voiceControlObserver);
    voiceControlObserver(
        bindArg((command: Commands) => {
            const [type, data] = command;
            if (type === COMMAND_TYPE) {
                state[data] += 1;
                gameStateObserver(bindArg(0, trigger));
            }
            if (type === LOG_TYPE) {
                state[LOG].unshift(data);
                while (state[LOG].length > 5) {
                    state[LOG].pop();
                }
            }
            if (type === STOP_TYPE) {
                state[VOICE_ENABLED] = false;
                gameStateObserver(bindArg(0, trigger));
            }
        }, on)
    );

    voiceCommands.addEventListener('click', () => {
        state[VOICE_ENABLED] = !state[VOICE_ENABLED];
        let command = state[VOICE_ENABLED] ? START_TYPE : STOP_TYPE;
        voiceControlObserver(bindArg([command], trigger));
        gameStateObserver(bindArg(0, trigger));
    });

    plusOneLeft.addEventListener(
        'click',
        () => {
            state[TEAM_LEFT] += 1;
            gameStateObserver(bindArg(0, trigger));
        },
        eventOptions
    );
    plusOneRight.addEventListener(
        'click',
        () => {
            state[TEAM_RIGHT] += 1;
            gameStateObserver(bindArg(0, trigger));
        },
        eventOptions
    );
};

export const initTennisEffect = (ctx: Window) => {
    const tags = ctx.document.querySelectorAll('.js-tennis');
    ctx.Array.from(tags).forEach(bindArg(ctx, initTemplate));
};