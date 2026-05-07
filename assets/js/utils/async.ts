import { cont } from './cont';
import { bindArg } from './bind';

export const noop = () => {};

// ── Task type ─────────────────────────────────────────────────────────────────
//
// A Task is a lazy computation: a function that, when given resolve/reject
// handlers, performs its work and calls one of them with the result.
// Tasks are not executed until taskFork is called.

export type Task<T> = (
    resolve: (value: T) => void,
    reject: (error: unknown) => void
) => void;

// ── Core primitives ───────────────────────────────────────────────────────────

// Run a Task and handle success / failure.
// Wraps execution in try/catch so synchronous throws land in reject.
export const taskFork =
    <T>(resolve: (value: T) => void, reject: (error: unknown) => void = noop) =>
    (fn: Task<T>) => {
        try {
            return fn(resolve, reject);
        } catch (e) {
            return reject(e);
        }
    };

// Lift a plain function into a Task.
// taskOf(fn)(...args) creates a Task that resolves with fn(...args).
export const taskOf =
    <T>(fn: (...args: any[]) => T) =>
    (...args: any[]) =>
        bindArg((resolve: (value: T) => void) => resolve(fn(...args)), cont);

// ── Combinators ───────────────────────────────────────────────────────────────

// Transform the resolved value of a Task (sync, no new Task returned).
// Errors pass through unchanged.
export const taskMap =
    <A, B>(mapFn: (a: A) => B) =>
    (fn: Task<A>): Task<B> =>
        (resolve, reject) =>
            fn((result) => resolve(mapFn(result)), reject);

// Chain a Task-returning function onto an existing Task (for async steps).
// Use instead of taskMap when the next step is itself asynchronous.
export const taskChain =
    <A, B>(chainFn: (a: A) => Task<B>) =>
    (fn: Task<A>): Task<B> =>
        (resolve, reject) =>
            fn((result) => {
                try {
                    chainFn(result)(resolve, reject);
                } catch (e) {
                    reject(e);
                }
            }, reject);
