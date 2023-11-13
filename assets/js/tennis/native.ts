import { bindArg, observer, on, trigger } from '@month/utils';
import {
    Commands,
    LOG_TYPE,
    START_TYPE,
    STOP_COMMAND,
    STOP_TYPE,
    TEAM_LEFT_NAME,
    TEAM_RIGHT_NAME,
    WORDS_TO_COMMANDS,
} from './const';

const prefixes = ['webkit', 'moz', 'ms', 'o'];

const getConstructors = (winCtx: Window) => {
    const ctx = winCtx as any;
    const result = [];
    for (const prefix of prefixes) {
        const grammarKey = `${prefix}SpeechGrammarList`;
        const speechKey = `${prefix}SpeechRecognition`;
        if (!result[0] && ctx[grammarKey]) {
            result[0] = ctx[grammarKey];
        }
        if (ctx[speechKey]) {
            result[1] = ctx[speechKey];
        }
        if (result.length == 2) {
            break;
        }
    }
    return result;
};

const commands = [TEAM_RIGHT_NAME, TEAM_LEFT_NAME, STOP_COMMAND];

export const useNative = (ctx: Window) => {
    const observerObj = observer<Commands, void>();
    const [grammar, speech] = getConstructors(ctx);
    if (!speech || !grammar) {
        try {
            return observerObj;
        } catch (e) {
            observerObj(
                bindArg(
                    [LOG_TYPE, `SpeechRecognition is not supported ${e}`],
                    trigger
                )
            );
        }
    }
    const grammarStr = `#JSGF V1.0; grammar commands; public <command> = ${commands.join(
        ' | '
    )} ;`;
    const speechRecognitionList = new grammar();
    speechRecognitionList.addFromString(grammarStr, 1);
    const recognition = new speech();
    recognition.lang = 'en-US';
    recognition.grammars = speechRecognitionList;
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;

    let isStopped = true;
    observerObj(
        bindArg(([type]: Commands) => {
            if (type === START_TYPE) {
                isStopped = false;
                recognition.start();
            }
        }, on)
    );

    observerObj(
        bindArg(([type]: Commands) => {
            if (type === STOP_TYPE) {
                isStopped = true;
                recognition.stop();
            }
        }, on)
    );

    recognition.onresult = (event: any) => {
        const { results, resultIndex } = event;
        const { transcript } = results[resultIndex][0];
        observerObj(bindArg([LOG_TYPE, transcript], trigger));
        transcript.split(' ').forEach((rawWord: string) => {
            const word = rawWord.toLowerCase().trim();
            if (WORDS_TO_COMMANDS.hasOwnProperty(word)) {
                const command = WORDS_TO_COMMANDS[word] as Commands;
                observerObj(bindArg(command, trigger));
            }
            if (word === STOP_COMMAND) {
                observerObj(bindArg([STOP_TYPE], trigger));
            }
        });
    };

    recognition.onerror = (e: { message: string }) => {
        observerObj(bindArg([LOG_TYPE, e.message], trigger));
    };
    recognition.onend = () => {
        if (!isStopped) {
            recognition.start();
        }
    };
    return observerObj;
};