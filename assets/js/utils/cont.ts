export const identity = <T>(a: T): T => a;

export const cont =
    <State, Result>(a: State) =>
    (fn: (a: State) => Result) =>
        fn(a);
