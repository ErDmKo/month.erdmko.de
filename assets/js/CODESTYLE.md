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
    increment() {
        this.value++;
    }
    get() {
        return this.value;
    }
}

// ✗ also wrong — object with methods
const makeCounter = () => {
    let value = 0;
    return {
        increment: () => {
            value++;
        },
        get: () => value,
    };
};

// ✗ also wrong — plain object with fields
type CounterState = { n: number };

// ✓ correct — named-index tuple derived from index constants via TupleOf
import type { TupleOf } from '@month/utils';

const COUNTER_VALUE = 0 as const;

type CounterState = TupleOf<{
    [COUNTER_VALUE]: number;
}>;

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

## Reactivity via Observer & Signals

Use the `observer` / `on` / `trigger` primitives from `@month/utils` for
event streams, and `createStore` / `mapSignal` / `combineSignals` for
state-driven UI reactivity. Do not use `EventEmitter`, `Subject`, or custom
pub-sub implementations.

### Event Streams (`observer`)

```ts
import { observer, on, trigger, bindArg } from '@month/utils';

const valueObserver = observer<number>();

// subscribe
valueObserver(bindArg((v: number) => console.log(v), on));

// emit
valueObserver(bindArg(42, trigger));
```

### Reactive State Signals (`createStore`)

A `Signal<T>` is a 3-tuple derived via `ReadonlyTupleOf`:
`[SIGNAL_GET: () => T, SIGNAL_SET: (next: T) => void, SIGNAL_OBS: ObserverInstance<T>]`.
`createStore(initial)` only emits on `SIGNAL_OBS` when `!Object.is(prev, next)`.

Compose derived read-only signals with `mapSignal`, `combineSignals`, and `pipe`:

```ts
import {
    bindArg,
    combineSignals,
    createStore,
    mapSignal,
    pipe,
    SIGNAL_GET,
    SIGNAL_SET,
} from '@month/utils';

const countSig = createStore(0);
const labelSig = createStore('points');

const summarySig = pipe(
    combineSignals(countSig, labelSig),
    bindArg(([count, label]: [number, string]) => `${count} ${label}`, mapSignal)
);

countSig[SIGNAL_SET](countSig[SIGNAL_GET]() + 1);
```

## Async via Task Pipeline

Asynchronous work is expressed as lazy **Tasks** composed with `taskOf`,
`taskFromPromise`, `taskMap`, `taskChain`, `taskCatch`, `taskFork`, and `pipe`
from `@month/utils`.
Do not use `async` functions, `await`, or nested `Promise` `.then` chains.

A `Task<T>` is just a function `(resolve, reject) => void` — it does nothing
until `taskFork` runs it. This keeps async logic lazy, composable, and
free of implicit scheduling.

| primitive                   | purpose                                                     |
| --------------------------- | ----------------------------------------------------------- |
| `taskOf(fn)`                | lift a plain function into a Task                           |
| `taskFromPromise(fn)`       | lift a Promise-returning function into a Task               |
| `taskMap(fn)`               | sync transform of the resolved value; errors pass through   |
| `taskChain(fn)`             | async step — `fn` itself returns a Task                     |
| `taskCatch(fallbackFn)`     | recover from a rejected Task with a fallback value          |
| `taskFork(resolve, reject)` | execute a Task, catches sync throws into reject             |
| `pipe(value, ...fns)`       | pass a value through a left-to-right sequence of functions  |

### No Nested `.then` Chains

When bridging native Promise-returning browser APIs (`ctx.fetch`, `res.text()`,
`peerConnection.createOffer()`, `window.ethereum.request()`), each leaf `Task`
wraps **at most one** `.then(resolve, reject)` boundary. Never nest `.then`
inside another `.then` or write manual `try / catch` blocks inside `.then`
callbacks — compose steps flat with `pipe`, `taskChain`, `taskMap`, and
`taskCatch` (`taskMap` and `taskChain` automatically route synchronous throws
to `reject`).

```ts
// ✗ wrong — nested .then(...).then(...) and manual try/catch
const postJsonTask =
    (ctx: Window, url: string, payload: Record<string, unknown>): Task<Data> =>
    (resolve, reject) => {
        ctx.fetch(url, { method: 'POST', body: ctx.JSON.stringify(payload) }).then(
            (res) => {
                res.text().then((rawText) => {
                    try {
                        const data = ctx.JSON.parse(rawText);
                        if (!res.ok) {
                            reject(new Error('Failed'));
                            return;
                        }
                        resolve(data);
                    } catch (e) {
                        reject(e);
                    }
                }, reject);
            },
            reject
        );
    };

// ✓ correct — flat leaf Tasks composed with pipe + taskChain + taskMap
const rawFetchTask =
    (ctx: Window, url: string, init: RequestInit): Task<Response> =>
    (resolve, reject) => {
        ctx.fetch(url, init).then(resolve, reject);
    };

const readResponseTextTask =
    (res: Response): Task<ResponseWithText> =>
    (resolve, reject) => {
        res.text().then((rawText: string) => resolve([res, rawText]), reject);
    };

const fetchTask = (
    ctx: Window,
    url: string,
    init: RequestInit
): Task<Record<string, unknown>> =>
    pipe(
        rawFetchTask(ctx, url, init),
        taskChain(readResponseTextTask),
        taskMap(bindArg(ctx, parseOkResponse))
    );

export const fetchSessionTask = (ctx: Window): Task<SessionStatus | null> =>
    pipe(
        fetchTask(ctx, '/auth/session', {
            ['method']: 'GET',
            ['credentials']: 'same-origin',
        }),
        taskMap(parseSessionStatus),
        taskCatch(() => null)
    );
```

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

## Declarative Direct DOM

Never call `document.createElement` directly or mutate DOM nodes imperatively
via extracted `genRef()` handles when a signal binding can express the update.
Build the DOM tree once using direct `genTagName(tag, props, children?)` calls
and materialise with `domCreator` / `domCreatorRef`,
which receive `ctx: Window` explicitly and update bound `Text` nodes,
properties, attributes, and lists directly in place.

- **Direct tags**: Use `genTagName('div', props, children)` for containers and `genTagName('input', props)` for void elements (children are rejected at compile time). Tag wrappers have been removed from utilities: direct calls avoid retained factory overhead and produce smaller Brotli bundles.
- **Direct text & signal children**: Pass primitive `string | number` or `ReadonlySignal<string | number>` directly in the `children` array (`createTextNode` updated in $O(1)$).
- **Reactive props, attrs & classes**: `genProp`, `genAttr`, and `genClass` accept static values or `ReadonlySignal<T>`.
- **Typed events**: Use `genOn('click', handler, options?)` instead of manual `addEventListener` on refs.
- **Refs**: Use `genRef()` for positional refs or `genRef(key)` for named refs. Named keys are integers from `0` to `8,388,607`, packed into `DOM_META`; strings, fractions, and out-of-range values are rejected.
- **Stable string keys (Closure ADVANCED)**: Use bracket/quoted syntax for custom browser fields and dictionaries indexed by external strings, e.g. `dataset['roomId']` and `{ ['Space']: handler }`. Do not mix this with dot/unquoted access for the same key. The esbuild stage preserves these quotes for Closure.
- **Control flow**: Use `domShow(condSig, child)`, `domIf(condSig, thenFn, elseFn?)`, and keyed `domList(itemsSig, keyFn, renderItem)` instead of clearing and re-creating container children.
- **Scoped cleanup**: Pass a `scope: DomScope = []` to `domCreator` / `domCreatorRef` and call `domDispose(scope)` when unmounting dynamic views.

```ts
// ✗ wrong — imperative DOM creation or manual ref mutation
const el = document.createElement('button');
el.textContent = 'Click';
root.appendChild(el);

// ✓ correct — direct declarative tags + signal bindings
import {
    bindArg,
    createStore,
    domCreator,
    domList,
    genClass,
    genOn,
    genProp,
    genTagName,
    mapSignal,
    pipe,
    SIGNAL_GET,
    SIGNAL_SET,
} from '@month/utils';

const countSig = createStore(0);
const isDisabledSig = pipe(
    countSig,
    bindArg((n: number) => n >= 10, mapSignal)
);

domCreator(
    ctx,
    root,
    genTagName(
        'div',
        [genClass('counter')],
        [
            genTagName('span', [], ['Count: ', countSig]),
            genTagName(
                'button',
                [
                    genProp('disabled', isDisabledSig),
                    genOn('click', () =>
                        countSig[SIGNAL_SET](countSig[SIGNAL_GET]() + 1)
                    ),
                ],
                ['Increment']
            ),
        ]
    )
);
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
type WsState = TupleOf<{
    [PENDING_HANDLERS]: Map<string, () => void>;
}>;

const wsStateCreate = (): WsState => [new Map()];
const wsStateSet = (
    requestId: string,
    handler: () => void,
    state: WsState
): void => {
    state[PENDING_HANDLERS].set(requestId, handler);
};
const wsStateGet = (
    requestId: string,
    state: WsState
): (() => void) | undefined => state[PENDING_HANDLERS].get(requestId);
const wsStateDelete = (requestId: string, state: WsState): void => {
    state[PENDING_HANDLERS].delete(requestId);
};
```

## Named Tuple Indices (`TupleOf` / `ReadonlyTupleOf`)

Every tuple index must be accessed through a named constant, never through a
bare numeric literal, and every fixed-length tuple type must be derived directly
from its index constants using `TupleOf` (mutable) or `ReadonlyTupleOf`
(immutable) from `@month/utils`. This applies both to state tuples and to
discriminated event tuples.

**Why:**
- `state[0]` and `event[2]` are opaque — the reader has to trace back to the
  type declaration to understand what is being read.
- Declaring `const FOO = 1 as const` separately from `readonly [a: number, b: number]`
  allows the constant and the tuple slot to silently drift apart during refactors.
- Deriving the tuple with `TupleOf<{ [FOO]: number }>` binds each slot to its
  index constant at the type level and fails to compile if an index is skipped
  or duplicated, with zero runtime overhead.

```ts
// ✗ wrong — bare index literals and disconnected tuple definition
type UploadProgress = readonly [type: number, sent: number, total: number];
if (event[0] === UPLOAD_PROGRESS) {
    doSomething(event[1], event[2]);
}

// ✓ correct — index constants construct the tuple via ReadonlyTupleOf
import type { ReadonlyTupleOf, TupleOf } from '@month/utils';

export const EVENT_TYPE = 0 as const;
export const EVENT_REQUEST_ID = 1 as const;
export const EVENT_UPLOAD_ID = 2 as const;

export type UploadReadyEvent = ReadonlyTupleOf<{
    [EVENT_TYPE]: typeof WS_UPLOAD_READY;
    [EVENT_REQUEST_ID]: string;
    [EVENT_UPLOAD_ID]: number;
}>;

if (event[EVENT_TYPE] === WS_UPLOAD_READY) {
    doSomething(event[EVENT_REQUEST_ID], event[EVENT_UPLOAD_ID]);
}

const PENDING_HANDLERS = 0 as const;
type WsState = TupleOf<{
    [PENDING_HANDLERS]: Map<string, () => void>;
}>;
state[PENDING_HANDLERS].set(key, handler);
```

The type tag constant at index 0 is always the `WS_*` / `DOWNLOAD_*` / etc.
discriminant — it already has a name. Payload positions need their own
per-tuple constants declared alongside the type definition.

### Top-Level Type and Constant Declarations

Always declare `type` definitions and tuple index / ref constants (`* = 0 as const`)
at the **module top-level**, never inside a function body.

**Why:**
- **Zero per-call overhead & clean scopes** — constants and types describe static
  data layout and do not depend on runtime function parameters.
- **Readability & reuse** — keeping tuple definitions and their index constants
  together at the top of the module makes the module's data structures
  immediately visible and reusable across helper functions.

```ts
// ✗ wrong — declaring tuple index constants and types inside a function
const mountList = () => {
    const ENTRY_EL = 0 as const;
    const ENTRY_SCOPE = 1 as const;
    type ListEntry = [el: HTMLElement, itemScope: DomScope];
    const entryMap = new Map<string, ListEntry>();
};

// ✓ correct — declared at module top-level
const ENTRY_EL = 0 as const;
const ENTRY_SCOPE = 1 as const;
type ListEntry = [el: HTMLElement, itemScope: DomScope];

const mountList = () => {
    const entryMap = new Map<string, ListEntry>();
};
```

## Runtime Validation (`objectStruct` & `validate`)

Avoid scattered `typeof x === 'string'`, `typeof x === 'object'`, custom
type-guard functions, or optional tuple indexing (`?.[INDEX]`) when inspecting
untrusted runtime values (JSON responses, `window.ethereum` providers, RPC
error payloads, browser capabilities on `ctx: Window`).

Use the closure-free `objectStruct` data tuple and `validate` from
`@month/utils` to validate and project runtime objects directly into typed
tuples:

- **`objectStruct(...fields)`**: Pure data tuple constructor (`(...fields) => fields`) with **zero closure allocations**. Each field rule is a tuple `['key', step1, step2, ...]` where steps are top-level validator functions (`isString`, `isNumber`, `isBoolean`, `isFunction`, `isArray`, `trim`, `nullable`) or nested `objectStruct(...)` tuples.
- **Strict by default**: If the input is not an object or any required field evaluates to `undefined`, `validate(val, struct)` returns `undefined`. When it succeeds, every slot in the returned tuple is guaranteed to be defined, eliminating `?.[INDEX]` optional chaining.
- **Closure `ADVANCED` safe**: Because property names in `objectStruct` rules are string literals (`'ethereum'`, `'request'`, `'message'`), Closure Compiler never renames them.
- **Optional fields (`nullable`)**: Append the top-level `nullable` step (`['nickname', isString, trim, nullable]`) when a missing or `null` property should resolve to `null` instead of failing the struct.

```ts
// ✗ wrong — ad-hoc typeof checks and optional tuple indexing
if (
    ctx['ethereum'] &&
    typeof ctx['ethereum']['request'] === 'function'
) {
    ctx['ethereum']['request'](args);
}

// ✓ correct — closure-free objectStruct tuple + validate from ctx
import {
    isFunction,
    isString,
    nullable,
    objectStruct,
    trim,
    validate,
} from '@month/utils';

const WIN_ETHEREUM = 0 as const;
const PROVIDER_REQUEST = 0 as const;

const windowEthereumStruct = objectStruct([
    'ethereum',
    objectStruct(['request', isFunction<EthereumProvider['request']>]),
]);

const eth = validate(ctx, windowEthereumStruct);
if (!eth) {
    reject(new Error('No Ethereum wallet detected.'));
    return;
}
const request = eth[WIN_ETHEREUM][PROVIDER_REQUEST];

// Nested optional fields with nullable (zero closures)
const ERR_MESSAGE = 0 as const;
const ERR_REASON = 1 as const;
const ERR_DATA = 2 as const;
const ERR_DATA_MESSAGE = 0 as const;

const errorObjectStruct = objectStruct(
    ['message', isString, trim, nullable],
    ['reason', isString, trim, nullable],
    ['data', objectStruct(['message', isString, trim]), nullable]
);

const parsed = validate(err, errorObjectStruct);
```

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

## Observer as Return Value

When a function produces multiple kinds of outcomes (success, progress,
error, etc.), return an `ObserverInstance` over a discriminated event tuple
instead of accepting several callback parameters.

**Why:**

- **Symmetry** — callers subscribe with the same `on` / `trigger` pattern
  used everywhere else. There is no special callback API to learn.
- **Composability** — the returned observer can be passed to other
  combinators (`combineLatestWith`, `pipe`, etc.) or re-subscribed later
  without re-invoking the original function.
- **Arity discipline** — a single `ObserverInstance<Event>` parameter is
  unambiguous; three or four callback parameters force the caller to
  supply all of them even when only one outcome is relevant.

```ts
// ✗ wrong — separate callbacks for each outcome
export const startUpload = (
    ctx: Window,
    socket: ChatSocket,
    requestId: string,
    file: File,
    onReady: (uploadId: number) => void,
    onDone: (attachment: AttachmentMeta) => void,
    onError: (code: string, message: string) => void
): void => { ... };

// usage is verbose and forces all three handlers every time
startUpload(ctx, socket, id, file, handleReady, handleDone, handleError);

// ✓ correct — discriminated event tuple via ReadonlyTupleOf + ObserverInstance return
export const UPLOAD_READY = 0 as const;
export const UPLOAD_DONE  = 1 as const;
export const UPLOAD_ERROR = 2 as const;

export const UPLOAD_EVENT_TYPE = 0 as const;
export const UPLOAD_READY_ID = 1 as const;
export const UPLOAD_DONE_ATTACHMENT = 1 as const;
export const UPLOAD_ERROR_CODE = 1 as const;
export const UPLOAD_ERROR_MESSAGE = 2 as const;

export type UploadEvent =
    | ReadonlyTupleOf<{
          [UPLOAD_EVENT_TYPE]: typeof UPLOAD_READY;
          [UPLOAD_READY_ID]: number;
      }>
    | ReadonlyTupleOf<{
          [UPLOAD_EVENT_TYPE]: typeof UPLOAD_DONE;
          [UPLOAD_DONE_ATTACHMENT]: AttachmentMeta;
      }>
    | ReadonlyTupleOf<{
          [UPLOAD_EVENT_TYPE]: typeof UPLOAD_ERROR;
          [UPLOAD_ERROR_CODE]: string;
          [UPLOAD_ERROR_MESSAGE]: string;
      }>;

export const startUpload = (
    ctx: Window,
    socket: ChatSocket,
    requestId: string,
    file: File
): ObserverInstance<UploadEvent> => { ... };

// caller subscribes to only what it needs
const upload = startUpload(ctx, socket, id, file);
upload(bindArg((event: UploadEvent) => {
    if (event[UPLOAD_EVENT_TYPE] === UPLOAD_DONE) {
        renderAttachment(event[UPLOAD_DONE_ATTACHMENT]);
    }
}, on));
```

The same pattern applies to any operation that has more than one terminal
state (download, long-running async task, WebSocket lifecycle, etc.).

## Feature Initialisation Pipeline

Complex UI features that depend on each other are wired together with a
`pipe` + `taskChain` chain. Each `init*` function returns a `Task` that
resolves with its own observer. Downstream features receive the upstream
observer as a dependency and subscribe to only the events they need.

**Why:**

- **No race conditions** — a feature only starts wiring after its dependency
  has fully mounted and emitted its first event. No shared mutable flags or
  `setTimeout` hacks needed.
- **Lazy** — nothing executes until `taskFork` runs the chain.
- **Layered error handling** — a native fallback catches failures before any
  DOM is available; once the first feature is up its observer can display
  errors to the user.

```ts
// ✓ correct — linear init chain
pipe(
    initChatUi(ctx, root, wsEvents),
    taskFork(
        (chatUiObs) => pipe(
            initMessages(ctx, wsEvents, chatUiObs),
            taskChain(([chatUiObs, msgsObs]) =>
                initAttachments(ctx, wsEvents, chatUiObs, msgsObs)
            ),
            taskFork(
                noop,
                (err) => chatUiObs(bindArg([CHAT_UI_ERROR, String(err)], trigger))
            )
        ),
        (err) => ctx.console.error('Chat UI failed to mount', err)
    )
)
```

Inside each `init*` the race condition between mounting and subscribing is
resolved by calling `resolve()` before `trigger(INIT_EVENT)`:

```ts
export const initChatUi = (ctx, root, wsEvents): Task<ChatUiObs> =>
    (resolve) => {
        const chatUiObs = observer<ChatUiEvent>()
        // ... wire own handlers ...
        resolve(chatUiObs)                                    // downstream subscribes first
        chatUiObs(bindArg([CHAT_UI_INIT, refs], trigger))    // then event fires — no miss
    }
```

Each feature exposes only the refs / state it owns via its observer events.
Other features subscribe lazily at the moment they are initialised — they
never read refs synchronously from a foreign module.
