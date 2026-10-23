import {
    bindArg,
    cleanHtml,
    createStore,
    on,
    SIGNAL_GET,
    SIGNAL_OBS,
    SIGNAL_SET,
    trigger,
} from '@month/utils';
import { $tennis } from '@month/gen/styles';
import { useNative } from './native';
import {
    Commands,
    GameState,
    LOG,
    SERVE,
    Sides,
    TEAM_LEFT,
    TEAM_RIGHT,
    VOICE_ENABLED,
    COMMAND_TYPE,
    START_TYPE,
    STOP_TYPE,
    BACK_TYPE,
    UPDATE_DATE,
} from './const';
import { useScreenLock } from './screen';
import { startListen } from './speech';
import { template } from './template';

const CMD_TYPE = 0 as const;
const CMD_SIDE = 1 as const;
const MAX_LOG_SIZE = 5 as const;

type Side = Sides[keyof Sides];

const nextServe = (
    teamLeft: number,
    teamRight: number,
    currentServe: Side
): Side => {
    if (teamLeft === 0 && teamRight === 0) {
        return TEAM_LEFT;
    }
    if (!((teamRight + teamLeft) % 2)) {
        return currentServe === TEAM_RIGHT ? TEAM_LEFT : TEAM_RIGHT;
    }
    return currentServe;
};

const createInitialState = (): GameState => ({
    [TEAM_LEFT]: 0,
    [TEAM_RIGHT]: 0,
    [SERVE]: TEAM_LEFT,
    [LOG]: [],
    [VOICE_ENABLED]: false,
    [UPDATE_DATE]: new Date(),
});

const initTemplate = (ctx: Window, element: Element) => {
    const htmlElement = element as HTMLDivElement;
    cleanHtml(htmlElement);
    htmlElement.classList.add($tennis);

    const gameStateSig = createStore<GameState>(createInitialState());
    const voiceControlObserver = useNative(ctx);

    startListen(ctx, gameStateSig[SIGNAL_OBS]);
    useScreenLock(ctx, voiceControlObserver);

    voiceControlObserver(
        bindArg((command: Commands) => {
            const type = command[CMD_TYPE];
            if (type === COMMAND_TYPE) {
                const side = command[CMD_SIDE];
                const prev = gameStateSig[SIGNAL_GET]();
                const nextLeft =
                    side === TEAM_LEFT
                        ? prev[TEAM_LEFT] + 1
                        : prev[TEAM_LEFT];
                const nextRight =
                    side === TEAM_RIGHT
                        ? prev[TEAM_RIGHT] + 1
                        : prev[TEAM_RIGHT];
                const nextLog = [prev, ...prev[LOG]].slice(0, MAX_LOG_SIZE);
                gameStateSig[SIGNAL_SET]({
                    [TEAM_LEFT]: nextLeft,
                    [TEAM_RIGHT]: nextRight,
                    [SERVE]: nextServe(nextLeft, nextRight, prev[SERVE]),
                    [LOG]: nextLog,
                    [VOICE_ENABLED]: prev[VOICE_ENABLED],
                    [UPDATE_DATE]: new Date(),
                });
                return;
            }
            if (type === BACK_TYPE) {
                const prev = gameStateSig[SIGNAL_GET]();
                const [lastState, ...restLog] = prev[LOG];
                if (!lastState) {
                    return;
                }
                gameStateSig[SIGNAL_SET]({
                    ...lastState,
                    [LOG]: restLog,
                });
                return;
            }
            if (type === STOP_TYPE) {
                const prev = gameStateSig[SIGNAL_GET]();
                gameStateSig[SIGNAL_SET]({
                    ...prev,
                    [VOICE_ENABLED]: false,
                });
            }
        }, on)
    );

    const handlePlusOneLeft = () => {
        voiceControlObserver(
            bindArg([COMMAND_TYPE, TEAM_LEFT], trigger) as any
        );
    };

    const handlePlusOneRight = () => {
        voiceControlObserver(
            bindArg([COMMAND_TYPE, TEAM_RIGHT], trigger) as any
        );
    };

    const handleVoiceToggle = () => {
        const prev = gameStateSig[SIGNAL_GET]();
        const nextVoice = !prev[VOICE_ENABLED];
        const command = nextVoice ? START_TYPE : STOP_TYPE;
        voiceControlObserver(bindArg([command], trigger) as any);
        gameStateSig[SIGNAL_SET]({
            ...prev,
            [VOICE_ENABLED]: nextVoice,
        });
    };

    const handleBack = () => {
        voiceControlObserver(bindArg([BACK_TYPE], trigger) as any);
    };

    template(
        ctx,
        htmlElement,
        gameStateSig,
        handlePlusOneLeft,
        handlePlusOneRight,
        handleVoiceToggle,
        handleBack
    );
};

export const initTennisEffect = (ctx: Window) => {
    const tags = ctx.document.querySelectorAll('.js-tennis');
    ctx.Array.from(tags).forEach(bindArg(ctx, initTemplate));
};
