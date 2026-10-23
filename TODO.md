# Direct DOM Architecture & Signal Reactivity (`@month/utils`)

Instead of Virtual DOM tree diffing (which allocates new `DOMStruct` trees and reconciles property/attribute maps on every update), `@month/utils/dom.ts` and `@month/utils/observer.ts` use **Direct DOM manipulation** inspired by [`nanoviews`](https://github.com/TrigenSoftware/nanoviews/) and aligned with `assets/js/CODESTYLE.md` (explicit `ctx: Window`, named-index tuples, and standalone functions).

---

## 1. Core Principles

1. **Build Once, Update In-Place**: `domCreator` / `domCreatorRef` materializes the real DOM tree once. Static nodes are never re-created or diffed.
2. **Tuple-Based Signals (`createStore`)**: Reactive state is represented by the 3-tuple returned from `createStore<T>(initial)`:
   `[get: () => T, set: (next: T) => void, obs: ObserverInstance<T>]`.
3. **Zero-Allocation Type Discrimination**:
   - `DOMStruct` is a tuple whose index `0` is a tag name (`typeof item[0] === 'string'`).
   - `Signal` is a tuple whose index `0` is a getter function (`typeof item[0] === 'function'`).
   - Static text children are primitives (`string | number`).
4. **Scoped Cleanup (`DomScope`)**: Subscriptions (`off`) and event listeners (`removeEventListener`) are registered into a cleanup scope so dynamic branches or unmounted views never leak memory.

---

## 2. Signal Tuple & Operator Composition (`assets/js/utils/observer.ts`)

### Signal Tuple Definition

```ts
export const SIGNAL_GET = 0 as const;
export const SIGNAL_SET = 1 as const;
export const SIGNAL_OBS = 2 as const;

export type Signal<T> = readonly [
    get: () => T,
    set: (next: T) => void,
    obs: ObserverInstance<T>,
];

export type ReadonlySignal<T> = readonly [
    get: () => T,
    set: ((next: T) => void) | undefined,
    obs: ObserverInstance<T>,
];

export type Reactive<T> = T | ReadonlySignal<T>;

export const isSignal = <T>(val: unknown): val is ReadonlySignal<T> =>
    Array.isArray(val) && typeof val[SIGNAL_GET] === 'function';
```

### Observer & Signal Operators

Derived signals compose the synchronous getter (`SIGNAL_GET`) with existing observer stream operators (`SIGNAL_OBS`):

```ts
export const mapOperator = <A, B>(
    fn: (val: A) => B,
    state: ObserverState<A>
): ObserverInstance<B> => {
    const oldObserver = observer(state);
    const newObserver = observer<B>();
    oldObserver(
        bindArg((val: A) => {
            newObserver(bindArg(fn(val), trigger));
        }, on)
    );
    return newObserver;
};

export const mapSignal = <A, B>(
    fn: (a: A) => B,
    sig: ReadonlySignal<A>
): ReadonlySignal<B> => [
    () => fn(sig[SIGNAL_GET]()),
    undefined,
    sig[SIGNAL_OBS](bindArg(fn, mapOperator)),
];

export const combineSignals = <A, B>(
    first: ReadonlySignal<A>,
    second: ReadonlySignal<B>
): ReadonlySignal<[A, B]> => [
    () => [first[SIGNAL_GET](), second[SIGNAL_GET]()],
    undefined,
    combineLatestWith(first[SIGNAL_OBS], second[SIGNAL_OBS]),
];
```

---

## 3. Element Factories & Direct DOM Bindings (`assets/js/utils/dom.ts`)

### Uncurried Tag Factories (Option C)

Provide tree-shakeable tag factories with compile-time tag-specific prop checking and void-element safety (no intermediate closures allocated):

- **Container elements**: `div(props, children?)`, `button(props, children?)`, `span(props, children?)`, `ul(props, children?)`, `li(props, children?)`, `form(props, children?)`, `label(props, children?)`, `p(props, children?)`, `strong(props, children?)`, etc.
- **Void elements** (compile-time error if `children` are passed): `input(props)`, `img(props)`, `br(props)`, `hr(props)`.

```ts
export type ChildItem =
    | DOMStruct<TagName>
    | string
    | number
    | ReadonlySignal<string | number>;
```

### Props, Attributes, Classes & Events

1. **Direct Text & Signal Children**:
   - `string | number` children create `ctx.document.createTextNode(String(child))`.
   - `ReadonlySignal<string | number>` children create `ctx.document.createTextNode(String(sig[SIGNAL_GET]()))` and subscribe to `sig[SIGNAL_OBS]` via `on` to mutate `textNode.data` directly in $O(1)$.
2. **Reactive `genProp` & `genAttr`**:
   - Accept `Reactive<T>` (`T | ReadonlySignal<T>`).
   - Static values are applied once on element creation.
   - Signal values read `sig[SIGNAL_GET]()` for initial state and subscribe to `sig[SIGNAL_OBS]` to update the property/attribute in place.
   - Boolean attributes (`hidden`, `disabled`, `checked`, `required`) remove the attribute when `false` / `null` / `undefined`.
3. **Typed Event Listeners (`genOn`)**:
   - `genOn<K extends keyof HTMLElementEventMap>(type: K, listener: (ev: HTMLElementEventMap[K]) => void)`
   - Uses `element.addEventListener(type, listener)` and registers `removeEventListener` in the mount scope.
4. **Class Lists (`genClass`)**:
   - Supports static strings, `ReadonlySignal<string>`, or arrays of static/reactive class names.

### Example Usage

```ts
const statusSig = createStore('connecting');
const isJoinedSig = createStore(false);
const msgLenSig = createStore(0);

const counterTextSig = pipe(
    msgLenSig,
    bindArg((len: number) => `${len}/200`, mapSignal)
);

const isSendDisabledSig = pipe(
    combineSignals(isJoinedSig, msgLenSig),
    bindArg(
        ([joined, len]: [boolean, number]) => !joined || len === 0,
        mapSignal
    )
);

const view = div([], [
    div([genClass($chat__meta)], [
        'Status: ',
        strong([], [statusSig]),
    ]),
    div([genProp('hidden', isJoinedSig)], [
        // Welcome screen
    ]),
    div([genProp('hidden', pipe(isJoinedSig, bindArg((j: boolean) => !j, mapSignal)))], [
        span([genClass($chat__counter)], [counterTextSig]),
        button(
            [
                genClass($chat__button),
                genProp('disabled', isSendDisabledSig),
                genOn('click', handleSendClick),
            ],
            ['Send']
        ),
    ]),
]);
```

---

## 4. Implementation Checklist

- [x] **Step 1 (`observer.ts`)**: Add `SIGNAL_GET`, `SIGNAL_SET`, `SIGNAL_OBS` constants, `Signal<T>` / `ReadonlySignal<T>` types, `isSignal`, `mapOperator`, `distinctOperator`, `mapSignal`, and `combineSignals` (ensure `createStore` only triggers when `!Object.is(state, next)`).
- [x] **Step 2 (`dom.ts` Core Fixes)**:
  - Fix in-place `.reverse()` mutation on fragment arrays.
  - Replace `unshift` + `pop` ($O(N^2)$ BFS) with forward FIFO queue ($O(N)$ BFS).
  - Unify `domCreator` and `domCreatorRef` internals to eliminate loop duplication.
- [x] **Step 3 (`dom.ts` Direct DOM Bindings)**:
  - Support `ChildItem` (`DOMStruct`, `string`, `number`, `ReadonlySignal<string | number>`) using real `Text` nodes (`ctx.document.createTextNode`).
  - Support `ReadonlySignal` in `genProp`, `genAttr`, and `genClass`.
  - Add `genOn` for typed `addEventListener` bindings and optional cleanup scope return.
- [x] **Step 4 (`dom.ts` Tag Factories)**:
  - Export uncurried container (`div`, `span`, `button`, `ul`, `li`, `form`, `label`, `p`, `strong`, `textarea`, `audio`, `canvas`, `h1`–`h6`, etc.) and void (`input`, `img`, `br`, `hr`, etc.) element factories.
- [x] **Step 5 (Control Flow Primitives)**:
  - Add anchor-based `domShow` / `domIf` and keyed `domList` with automatic scope cleanup (`off` / `removeEventListener`).
