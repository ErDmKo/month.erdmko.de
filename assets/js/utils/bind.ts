export const bindArgs = <RestArgs extends any[], Result>(
    bindedArgs: any[],
    fn: (...args: any[]) => Result
): ((...rest: RestArgs) => Result) => {
    return (...args: any[]) => {
        return fn.apply(null, bindedArgs.concat(args));
    };
};

export const bindArg = <Arg, RestArgs extends any[], Result>(
    arg: Arg,
    fn: (a: Arg, ...rest: RestArgs) => Result
): ((...rest: RestArgs) => Result) => {
    return bindArgs([arg], fn);
};
