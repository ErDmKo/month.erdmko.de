export const bindArgs = <RestArgs extends any[], Result>(
    bindedArgs: any[],
    fn: (...args: any[]) => Result
): ((...rest: RestArgs) => Result) => {
    return (...args: RestArgs) => fn(...bindedArgs, ...args);
};

export const bindArg = <Arg, RestArgs extends any[], Result>(
    arg: Arg,
    fn: (a: Arg, ...rest: RestArgs) => Result
): ((...rest: RestArgs) => Result) => {
    return (...args: RestArgs) => fn(arg, ...args);
};

export const once = <Args extends any[], Result>(
    fn: (...args: Args) => Result
): ((...args: Args) => Result) => {
    let called = false;
    let result: Result;
    return (...args: Args) => {
        if (!called) {
            called = true;
            result = fn(...args);
        }
        return result;
    };
};
