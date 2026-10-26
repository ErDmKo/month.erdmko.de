import { bindArg } from './bind';
import { cont } from './cont';
import type { ReadonlyTupleOf } from './tuple';

export type ObserverState<EventType> = ((e: EventType) => void)[];
export type ObserverInstance<EventType, ResultType = any> = (
    a: (s: ObserverState<EventType>) => ResultType
) => ResultType;

export const observer = <EventType, ResultType = any>(
    state = [] as ObserverState<EventType>
) => {
    return cont<ObserverState<EventType>, ResultType>(state);
};

export const on = <EventType>(
    callback: (e: EventType) => void,
    state: ObserverState<EventType>
) => {
    state.push(callback);
};

export const off = <EventType>(
    callback: (e: EventType) => void,
    state: ObserverState<EventType>
) => {
    const index = state.indexOf(callback);
    if (index !== -1) {
        state.splice(index, 1);
    }
};

export const trigger = <EventType>(
    event: EventType,
    state: ObserverState<EventType>
) => {
    for (const callback of state) {
        callback(event);
    }
};

// Typescript alias for bindArg(..., trigger);
export const next = <EventType>(e: EventType) => {
    return (state: ObserverState<EventType>) => trigger(e, state);
};

// Typescript alias for bindArg(..., on);
export const subscribe = <EventType>(callback: (e: EventType) => void) => {
    return (state: ObserverState<EventType>) => on(callback, state);
};

export const delayOperator = <T>(delay: number, state: ObserverState<T>) => {
    const oldObserver = observer(state);
    const newObserver = observer<T>();
    let timeOut = null;
    oldObserver(
        bindArg((newVal: T) => {
            clearTimeout(timeOut);
            timeOut = setTimeout(() => {
                newObserver(bindArg(newVal, trigger));
            }, delay);
        }, on)
    );
    return newObserver;
};

export const sumOperator = (state: ObserverState<number>) => {
    const oldObserver = observer(state);
    const newObserver = observer<number>();
    let sum = 0;
    oldObserver(
        bindArg((newVal: number) => {
            sum += newVal;
            newObserver(bindArg(sum, trigger));
        }, on)
    );
    return newObserver;
};

export const combineLatestWith = <First, Second>(
    firstObserver: ObserverInstance<First>,
    secondObserver: ObserverInstance<Second>
) => {
    const newObserver = observer<[First, Second]>();
    let firstValue: First;
    let secondValue: Second;
    firstObserver(
        bindArg((newVal: First) => {
            firstValue = newVal;
            newObserver(bindArg([firstValue, secondValue], trigger));
        }, on)
    );
    secondObserver(
        bindArg((newVal: Second) => {
            secondValue = newVal;
            newObserver(bindArg([firstValue, secondValue], trigger));
        }, on)
    );
    return newObserver;
};

export const mapOperator = <A, B>(
    fn: (val: A) => B,
    state: ObserverState<A>
): ObserverInstance<B> => {
    const oldObserver = observer(state);
    const newObserver = observer<B>();
    oldObserver(
        bindArg((newVal: A) => {
            newObserver(bindArg(fn(newVal), trigger));
        }, on)
    );
    return newObserver;
};

export const filterOperator = <T>(
    predicate: (val: T) => boolean,
    state: ObserverState<T>
): ObserverInstance<T> => {
    const oldObserver = observer(state);
    const newObserver = observer<T>();
    oldObserver(
        bindArg((newVal: T) => {
            if (predicate(newVal)) {
                newObserver(bindArg(newVal, trigger));
            }
        }, on)
    );
    return newObserver;
};

export const distinctOperator = <T>(
    state: ObserverState<T>
): ObserverInstance<T> => {
    const oldObserver = observer(state);
    const newObserver = observer<T>();
    let hasPrev = false;
    let prev: T;
    oldObserver(
        bindArg((newVal: T) => {
            if (!hasPrev || !Object.is(prev, newVal)) {
                hasPrev = true;
                prev = newVal;
                newObserver(bindArg(newVal, trigger));
            }
        }, on)
    );
    return newObserver;
};

export const SIGNAL_GET = 0 as const;
export const SIGNAL_SET = 1 as const;
export const SIGNAL_OBS = 2 as const;

export type Signal<T> = ReadonlyTupleOf<{
    [SIGNAL_GET]: () => T;
    [SIGNAL_SET]: (next: T) => void;
    [SIGNAL_OBS]: ObserverInstance<T>;
}>;

export type ReadonlySignal<T> = ReadonlyTupleOf<{
    [SIGNAL_GET]: () => T;
    [SIGNAL_SET]: unknown;
    [SIGNAL_OBS]: (a: (s: any) => any) => any;
}>;

export type Reactive<T> = T | ReadonlySignal<T>;

export const isSignal = <T = unknown>(val: unknown): val is ReadonlySignal<T> =>
    Array.isArray(val) &&
    val.length === 3 &&
    typeof val[SIGNAL_GET] === 'function' &&
    typeof val[SIGNAL_OBS] === 'function';

export const createStore = <S>(initial: S): Signal<S> => {
    let state = initial;
    const storeObs = observer<S>();
    const getState = () => state;
    const setState = (next: S) => {
        if (!Object.is(state, next)) {
            state = next;
            storeObs(bindArg(next, trigger));
        }
    };
    return [getState, setState, storeObs] as const;
};

export const mapSignal = <A, B>(
    fn: (a: A) => B,
    sig: ReadonlySignal<A>
): ReadonlySignal<B> => {
    const mappedObs = observer<B>();
    sig[SIGNAL_OBS](
        bindArg((value: A) => {
            mappedObs(bindArg(fn(value), trigger));
        }, on)
    );
    // Getter reads do not prime deduplication: the first update still emits.
    return [
        () => fn(sig[SIGNAL_GET]()),
        undefined,
        mappedObs(distinctOperator),
    ];
};

export const combineSignals = <A, B>(
    first: ReadonlySignal<A>,
    second: ReadonlySignal<B>
): ReadonlySignal<[A, B]> => {
    const combinedObs = observer<[A, B]>();
    first[SIGNAL_OBS](
        bindArg((newFirst: A) => {
            combinedObs(
                bindArg([newFirst, second[SIGNAL_GET]()] as [A, B], trigger)
            );
        }, on)
    );
    second[SIGNAL_OBS](
        bindArg((newSecond: B) => {
            combinedObs(
                bindArg([first[SIGNAL_GET](), newSecond] as [A, B], trigger)
            );
        }, on)
    );
    return [
        () => [first[SIGNAL_GET](), second[SIGNAL_GET]()],
        undefined,
        combinedObs,
    ];
};
