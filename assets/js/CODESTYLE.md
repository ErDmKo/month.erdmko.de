# JavaScript / TypeScript Codestyle

## 1. Explicit `ctx: Window`

All browser globals are accessed through an explicit `ctx: Window` parameter,
never called as free-standing identifiers.

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

## 2. No classes — functions and closures only

State lives in plain objects or closure variables, never in class instances.

```ts
// ✗ wrong
class MyThing {
    private value = 0;
    increment() { this.value++; }
}

// ✓ correct
const makeMyThing = () => {
    let value = 0;
    return {
        increment: () => { value++; },
    };
};
```

## 3. Reactivity via `observer` / `on` / `trigger`

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

## 4. No `async` / `await` / `Promise`

Asynchronous work (file reads, fetch, timers) is expressed through callbacks
and observer chains, not `async` functions or `Promise` chains.

```ts
// ✗ wrong
const loadFile = async (file: File): Promise<Uint8Array> => {
    const buffer = await file.arrayBuffer();
    return new Uint8Array(buffer);
};

// ✓ correct
const loadFile = (ctx: Window, file: File, onDone: (data: Uint8Array) => void): void => {
    const reader = new ctx.FileReader();
    reader.onload = () => {
        onDone(new ctx.Uint8Array(reader.result as ArrayBuffer));
    };
    reader.readAsArrayBuffer(file);
};
```

## 5. DOM via `genTagName` / `domCreator` / `domCreatorRef`

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

## 6. No mutation of external objects

Do not attach ad-hoc properties to objects you do not own (`WebSocket`,
`HTMLElement`, etc.). Keep state in closures or plain objects created
for that purpose.

```ts
// ✗ wrong
(ws as any).__pendingUpload = handler;

// ✓ correct
const pending = new ctx.Map<string, Handler>();
pending.set(requestId, handler);
```
