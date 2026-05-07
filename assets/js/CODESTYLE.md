# JavaScript / TypeScript Codestyle

## Explicit Window Context

All browser globals are accessed through an explicit `ctx: Window` parameter,
never called as free-standing identifiers.

**Why:**
- **Testability** — pass a mock or a jsdom instance in tests instead of relying
  on the real global `window`. Functions become pure with respect to the
  environment and can be unit-tested without a browser.

```ts
// ✗ wrong
JSON.stringify(data);
JSON.parse(text);
new WebSocket(url);
Array.from(nodes);
URL.createObjectURL(blob);
setTimeout(fn, 100);

// ✓ correct
ctx.JSON.stringify(data);
ctx.JSON.parse(text);
new ctx.WebSocket(url);
ctx.Array.from(nodes);
ctx.URL.createObjectURL(blob);
ctx.setTimeout(fn, 100);
```

Every public function that touches the DOM or any browser API accepts `ctx`
as its first argument. The module entry point always has the signature:

```ts
export const initXxxEffect = (ctx: Window): void => { ... };
```

## Tuples and Separate Functions

Avoid classes and objects that bundle state with methods. Represent state as
a typed tuple (named-index array) and write separate top-level functions that
accept the state as their last argument.
This mirrors the `observer` / `on` / `trigger` pattern from `@month/utils`
and the `DOMStruct` tuple from `dom.ts`.

**Why:**
- **Tree-shaking / minimal bundle** — separate top-level functions are
  individually referenceable by the bundler. Only the functions actually
  called end up in the bundle. A class or an object literal with methods
  creates a single chunk that is either included entirely or not at all,
  pulling in code that may never run.
- **No hidden couplings** — each function declares its dependencies
  explicitly through its arguments. There is no shared `this` context
  carrying implicit state across methods.

```ts
// ✗ wrong — class
class Counter {
    private value = 0;
    increment() { this.value++; }
    get() { return this.value; }
}

// ✗ also wrong — object with methods
const makeCounter = () => {
    let value = 0;
    return {
        increment: () => { value++; },
        get: () => value,
    };
};

// ✗ also wrong — plain object with fields
type CounterState = { n: number };

// ✓ correct — named-index tuple + separate functions
const COUNTER_VALUE = 0 as const;

type CounterState = [value: number];   // tuple, index COUNTER_VALUE = 0

const counterIncrement = (state: CounterState): void => {
    state[COUNTER_VALUE]++;
};

const counterGet = (state: CounterState): number => state[COUNTER_VALUE];

// usage
const counter: CounterState = [0];
counterIncrement(counter);
counterGet(counter); // 1
```

When the state is a single mutable collection, pass it directly:

```ts
// from @month/utils — the canonical example
export type ObserverState<T> = ((e: T) => void)[];

export const on = <T>(callback: (e: T) => void, state: ObserverState<T>) => {
    state.push(callback);
};

export const trigger = <T>(event: T, state: ObserverState<T>) => {
    for (const callback of state) callback(event);
};
```

## Reactivity via Observer

Use the `observer` / `on` / `trigger` primitives from `@month/utils` for
all event-driven communication. Do not use `EventEmitter`, `Subject`, or
custom pub-sub implementations.

```ts
import { observer, on, trigger, bindArg } from '@month/utils';

const valueObserver = observer<number>();

// subscribe
valueObserver(bindArg((v: number) => console.log(v), on));

// emit
valueObserver(bindArg(42, trigger));
```

## Async via Task Pipeline

Asynchronous work is expressed as lazy **Tasks** composed with `taskOf`,
`taskMap`, `taskChain`, `taskFork`, and `pipe` from `@month/utils`.
Do not use `async` functions, `await`, or `Promise` chains.

A `Task<T>` is just a function `(resolve, reject) => void` — it does nothing
until `taskFork` runs it. This keeps async logic lazy, composable, and
free of implicit scheduling.

| primitive | purpose |
|---|---|
| `taskOf(fn)` | lift a plain function into a Task |
| `taskMap(fn)` | sync transform of the resolved value; errors pass through |
| `taskChain(fn)` | async step — `fn` itself returns a Task |
| `taskFork(resolve, reject)` | execute a Task, catches sync throws into reject |
| `pipe(value, ...fns)` | pass a value through a left-to-right sequence of functions |

**Example: read a File, then send over WebSocket**

```ts
// ✗ wrong — async/await
const sendFile = async (ws: WebSocket, file: File): Promise<void> => {
    const buffer = await file.arrayBuffer();
    ws.send(buffer);
};

// ✓ correct — Task pipeline
import { pipe, taskOf, taskChain, taskFork, noop, Task } from '@month/utils';

const readFile =
    (ctx: Window, file: File): Task<ArrayBuffer> =>
    (resolve, reject) => {
        const reader = new ctx.FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
    };

const sendBuffer =
    (ws: WebSocket): Task<void> =>
    (resolve) => {
        ws.send(buf);
        resolve();
    };

const sendFile = (ctx: Window, ws: WebSocket, file: File): void =>
    pipe(
        readFile(ctx, file),
        taskChain(bindArg(ws, sendBuffer)),
        taskFork(noop, console.error)
    );
```

**Sync transformation with `taskMap`:**

```ts
// double every resolved number, errors pass through unchanged
const doubled = taskMap((n: number) => n * 2);
```

**Railway: errors skip all further steps**

```ts
// if stepA rejects, stepB is never called
pipe(
    taskOf(init)(),
    taskChain(stepA),
    taskChain(stepB),
    taskFork(console.log, console.error)
);
```

## Declarative DOM

Never call `document.createElement` directly. Build DOM declaratively with
the helpers from `@month/utils` and materialise with `domCreator` /
`domCreatorRef`, both of which receive `ctx` explicitly.

```ts
// ✗ wrong
const el = document.createElement('button');
el.textContent = 'Click';
root.appendChild(el);

// ✓ correct
domCreator(ctx, root, genTagName('button', [genText('Click')]));
```

## External State Registry

Do not attach ad-hoc properties to objects you do not own (`WebSocket`,
`HTMLElement`, etc.). If you need to associate state with a connection or
element, create a separate state tuple (see Tuples and Separate Functions)
and a `Map` that keys it by the object reference.

```ts
// ✗ wrong — mutating an object you don't own
(ws as any).__pendingUpload = handler;
(ws as any)[`__upload_ready_${requestId}`] = onReady;

// ✓ correct — external registry: Map<WebSocket, StateTuple>
const PENDING_HANDLERS = 0 as const;
type WsState = [handlers: Map<string, () => void>];

const wsStateCreate = (): WsState => [new Map()];
const wsStateSet = (requestId: string, handler: () => void, state: WsState): void => {
    state[PENDING_HANDLERS].set(requestId, handler);
};
const wsStateGet = (requestId: string, state: WsState): (() => void) | undefined =>
    state[PENDING_HANDLERS].get(requestId);
const wsStateDelete = (requestId: string, state: WsState): void => {
    state[PENDING_HANDLERS].delete(requestId);
};
```

## Named Tuple Indices

Every tuple index must be accessed through a named constant, never through a
bare numeric literal. This applies both to state tuples and to discriminated
event tuples.

**Why:** `state[0]` and `event[2]` are opaque — the reader has to trace back
to the type declaration to understand what is being read. Named constants make
the access site self-documenting and survive refactors that reorder fields.

```ts
// ✗ wrong — bare index literals
if (event[0] === WS_UPLOAD_READY) {
    doSomething(event[1], event[2]);
}
state[0].set(key, handler);

// ✓ correct — named constants
const EVENT_TYPE = 0 as const;
const EVENT_REQUEST_ID = 1 as const;
const EVENT_UPLOAD_ID = 2 as const;

if (event[EVENT_TYPE] === WS_UPLOAD_READY) {
    doSomething(event[EVENT_REQUEST_ID], event[EVENT_UPLOAD_ID]);
}

const PENDING_HANDLERS = 0 as const;
state[PENDING_HANDLERS].set(key, handler);
```

The type tag constant at index 0 is always the `WS_*` / `DOWNLOAD_*` / etc.
discriminant — it already has a name. Payload positions need their own
per-tuple constants declared alongside the type definition.

## Partial Application over Wrapper Arrows

Avoid writing `() =>`, `(x) =>`, or `(x, y) =>` solely to pre-apply
arguments to an existing function. Use `bindArg` (one argument) or
`bindArgs` (multiple arguments) from `@month/utils` instead.

**Why:** wrapper arrows create an extra function allocation and hide the
real callee from the reader. `bindArg(arg, fn)` makes partial application
explicit and reads left-to-right without nesting.

```ts
import { bindArg, bindArgs } from '@month/utils';

// ✗ wrong — wrapper arrow just to pass a pre-known argument
taskChain(() => sendBuffer(ws));
observer(bindArg((v) => handle(ctx, v), on));

// ✓ correct — bindArg / bindArgs
taskChain(bindArg(ws, sendBuffer));
observer(bindArg(bindArg(ctx, handle), on));
```

`bindArgs` when more than one argument is pre-applied:

```ts
// ✗ wrong
ctx.requestAnimationFrame(() => draw(ctx, field, canvas));

// ✓ correct
ctx.requestAnimationFrame(bindArgs([ctx, field, canvas], draw));
```

**Caution with `forEach` / `map`:** these callbacks receive extra arguments
`(element, index, array)`. Only use `bindArg` directly when the target
function accepts exactly the arguments that will be passed — no more.
If the caller passes more arguments than the function expects, the extras
silently become positional parameters on the next call.

```ts
// ✓ safe — initTemplate(ctx, element) matches forEach(element, index, array)
// only if initTemplate accepts exactly two parameters and ignores the rest.
// Prefer an explicit wrapper when the arity is ambiguous:
tags.forEach((el) => initTemplate(ctx, el));

// ✓ also safe — when you are certain the signature will never grow
ctx.Array.from(tags).forEach(bindArg(ctx, initTemplate));
```
