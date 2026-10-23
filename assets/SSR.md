# Isomorphic Routing, Bit-Packed `DOMStruct` & SSR Hydration (`@month/utils`)

This document describes the architecture for unifying **Client-Side Direct DOM Routing & Hydration** (`@month/utils/router.ts` & `@month/utils/dom.ts`) with **Compile-Time Server-Side Rendering (SSR)** for the Rust (`actix-web` + Tera) backend.

---

## 1. Core Philosophy: `(params) -> template` as Language-Agnostic Data

In `@month/utils`, UI views and routes are expressed as pure functions from reactive `ReadonlySignal` parameters to `DOMStruct` and `DomFlowNode` tuples:

```
(paramsSig: ReadonlySignal<Params>, scope: DomScope) => ChildItem
```

Because `DOMStruct` is a pure data tuple and every `Signal` exposes a synchronous getter at index `0` (`sig[SIGNAL_GET]()`), the exact same view definition supports three execution modes:

1. **Client Mount Mode (`domCreator` / `domCreatorRef`)**:
   - Materializes real DOM elements once and binds `ReadonlySignal` values directly to `Text` nodes, element properties, and attributes in $O(1)$.
2. **Compile-Time Symbolic SSR Mode (`domToJson` $\rightarrow$ `jsonToTera`)**:
   - Evaluates route and view functions at Bazel build time using **symbolic parameter signals** (`{ "$param": "room_id" }`).
   - Resolves static `DOMStruct` nodes and hashed CSS module classes (`@month/gen/styles`) into a **language-agnostic JSON Intermediate Representation (IR)**, then compiles that JSON IR into native **Tera `.html` templates** (`{{ param }}`, `{% if route == ... %}`).
3. **Client Hydration Mode (`domHydrate` / `domHydrateRef`)**:
   - Walks the server-rendered DOM in lockstep with `DOMStruct`, using the bit-packed `DOM_META` header to **skip 100% static subtrees in $O(1)$** without XPath or `data-*` attributes, attaching only `Signal` subscriptions and `genOn` event listeners to existing DOM nodes.

---

## 2. End-to-End Pipeline

```
[TypeScript Views + Nested domRouter Flow Nodes]
       │
       │  1. Symbolic evaluation at Bazel build time (domToJson)
       ▼
[ssr_routes.json]  (Language-agnostic JSON IR: { pattern, params, template })
       │
       │  2. Compile-time template codegen (jsonToTera)
       ▼
[server/templates/ssr/*.html]  (Native Tera HTML with hashed CSS & {{ params }})
       │
       │  3. Tera::new() at Rust server startup -> Tera::render() on HTTP GET
       ▼
[Instant SSR HTML Response -> Client domHydrate (skips static subtrees via DOM_META)]
```

---

## 3. Bit-Packed `DOM_META` & 3-Tuple `DOMStruct` (`assets/js/utils/dom.ts`)

Instead of a 7-element tuple (`[tag, propMap, attrMap, ref, children, key, events]`) that allocates intermediate `{}` maps on every tag call, `DOMStruct` is a compact **3-tuple** whose first slot (`DOM_META`) is a 31-bit Small Integer (SMI) packing the tag/flow enum, void-element flag, dynamic subtree flags, and ref key.

### 31-Bit `DOM_META` Layout

```
Bits 30..12 (19 bits) │ Bit 11      │ Bit 10  │ Bit 9       │ Bit 8    │ Bit 7   │ Bits 6..0 (7 bits)
──────────────────────┼─────────────┼─────────┼─────────────┼──────────┼─────────┼────────────────────
REF_KEY (0..524,287)  │ HAS_REF_KEY │ HAS_REF │ SUBTREE_DYN │ SELF_DYN │ IS_VOID │ NODE_KIND (0..127)
```

```ts
import type { ReadonlyTupleOf } from './tuple';

// Bits 0..6: Unified Node Kind (Flow Nodes 0..3 + HTML Tags 4..86)
export const META_KIND_MASK = 0x7f as const;

export const FLOW_SHOW    = 0 as const;
export const FLOW_IF      = 1 as const;
export const FLOW_LIST    = 2 as const;
export const FLOW_ROUTER  = 3 as const;
export const FIRST_TAG_ID = 4 as const; // 'a' = 4, 'article' = 5, ..., 'wbr' = 86

// Bit 7: Void HTML Element ('area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr')
export const META_FLAG_VOID = (1 << 7) as const;

// Bit 8: Element itself has genRef, genOn, or a Signal in props/attrs
export const META_FLAG_SELF_DYN = (1 << 8) as const;

// Bit 9: At least one child/descendant is a Signal, DomFlowNode, or dynamic DOMStruct
export const META_FLAG_SUBTREE_DYN = (1 << 9) as const;

// Combined mask: is anything in this node or its subtree dynamic?
export const META_FLAG_ANY_DYN = (META_FLAG_SELF_DYN | META_FLAG_SUBTREE_DYN) as const;

// Bits 10..11: Ref presence and named-key flag
export const META_FLAG_HAS_REF     = (1 << 10) as const;
export const META_FLAG_HAS_REF_KEY = (1 << 11) as const;

// Bits 12..30: Named Ref Key (e.g. CHAT_REF_STATUS = 0, CHAT_REF_SEND = 11)
export const META_REF_SHIFT = 12 as const;

// 3-Tuple DOMStruct
export const DOM_META     = 0 as const;
export const DOM_PROPS    = 1 as const;
export const DOM_CHILDREN = 2 as const;

export type DOMStruct<C extends ChildItem = ChildItem> = ReadonlyTupleOf<{
    [DOM_META]: number;
    [DOM_PROPS]: readonly Props[];
    [DOM_CHILDREN]: readonly C[];
}>;
```

### Why Bit-Packing `DOM_META` Matters

| Operation | Check | Cost |
| :--- | :--- | :--- |
| Is node a `DomFlowNode` vs HTML tag? | `(meta & META_KIND_MASK) < FIRST_TAG_ID` | $O(1)$ bitwise |
| Is HTML tag a void element (`<input>`, `<br>`)? | `(meta & META_FLAG_VOID) !== 0` | $O(1)$ bitwise |
| Can `domHydrate` skip this entire subtree? | `(meta & META_FLAG_ANY_DYN) === 0` | $O(1)$ bitwise |
| Does this element itself need listener/signal binding? | `(meta & META_FLAG_SELF_DYN) !== 0` | $O(1)$ bitwise |
| Does `domHydrate` need to descend into `children`? | `(meta & META_FLAG_SUBTREE_DYN) !== 0` | $O(1)$ bitwise |
| Extract named `genRef(key)` integer | `meta >>> META_REF_SHIFT` | $O(1)$ bitshift |

---

## 4. Parallel Cursor Hydration (`domHydrate` / `domHydrateRef`)

Instead of embedding XPath strings or `data-h="N"` attributes into Tera HTML, `domHydrate` traverses `DOMStruct` and the live SSR DOM (`root.childNodes`) in lockstep using a cursor, relying on `DOM_META` to skip static branches.

### Hydration Traversal Rules

```
DOMStruct Tree                            Real SSR DOM in Browser
──────────────                            ───────────────────────
div.$wrapper (ANY_DYN = 1, SELF_DYN = 0)  <div class="_wrapper">          [Skip bindElementData; descend to children]
 ├─ header (ANY_DYN = 0)                  ├─ <header>...</header>         [SKIP SUBTREE IN O(1)! cursor = cursor.nextSibling]
 ├─ button.$pOneL (SELF_DYN = 1)          ├─ <button class="_pOneL">      [Attach genOn('click'); SUBTREE_DYN = 0 -> skip children]
 └─ span.$score (SUBTREE_DYN = 1)         └─ <span class="_score">        [Skip bindElementData; descend to children]
     ├─ div.$time (SUBTREE_DYN = 1)           ├─ <div class="_time">12:00 [Bind scoreTimeSig to existing Text node]
     └─ div (SUBTREE_DYN = 1)                 └─ <div>🏓0:0</div>         [Bind scoreTextSig to existing Text node]
```

1. **Static Subtree Skip (`(meta & META_FLAG_ANY_DYN) === 0`)**:
   - Does not inspect `props`, does not allocate closures, and does not push `children` onto the queue.
   - Advances the DOM sibling cursor (`cursor = cursor.nextSibling`) and continues. A 100-node static article is skipped in a single pointer hop.
2. **Selective Element Binding (`(meta & META_FLAG_SELF_DYN) !== 0`)**:
   - Collects `ref` if `meta & META_FLAG_HAS_REF` is set.
   - Iterates `struct[DOM_PROPS]`, **ignoring static `PROP` and `ATTR` entries** (already rendered by Tera) and attaching only `ON` event listeners and `isSignal(val)` subscriptions.
3. **Selective Child Descent (`(meta & META_FLAG_SUBTREE_DYN) !== 0`)**:
   - Only pushes `(element, children)` onto the hydration queue when at least one descendant is dynamic.
4. **Adjacent Text & Signal Children (`textNode.splitText`)**:
   - For mixed children like `['Chat room: ', roomIdSig]`, the browser parses `Chat room: lobby` as a single `Text` node.
   - When the cursor steps over static `'Chat room: '` (length `11`) and sees another text/signal child next, it calls `cursor.splitText(11)` in-place so `roomIdSig` binds directly to the second `Text` node (`"lobby"`).
5. **Empty Initial Signal (`""` on SSR)**:
   - If a signal's initial SSR text was `""` (e.g., `<div></div>` has no `Text` child in the DOM), `domHydrate` creates `ctx.document.createTextNode('')`, inserts it at `cursor`, and binds `sig[SIGNAL_OBS]`.
6. **Flow Nodes (`domIf`, `domList`, `domRouter`)**:
   - `jsonToTera` emits a single empty HTML comment `<!---->` at the end of each dynamic flow block.
   - During `domHydrate`, the cursor adopts existing SSR nodes before `<!---->` into `branchNodes` / `entryMap` and uses that `Comment` node directly as the `anchor` for future `parent.insertBefore(node, anchor)` updates.

---

## 5. Router & Flow Node Tuples (`assets/js/utils/router.ts`)

All router structures follow `assets/js/CODESTYLE.md`: top-level named index constants and tuple types derived via `ReadonlyTupleOf`.

### Tuple Definitions

```ts
import type { ReadonlyTupleOf } from './tuple';
import type { ChildItem, DomScope, DOM_META, FLOW_ROUTER } from './dom';
import type { ReadonlySignal, Signal } from './observer';

// ── Route Location State ──────────────────────────────────────────────────────
export const ROUTE_PATH = 0 as const;
export const ROUTE_SEARCH = 1 as const;
export const ROUTE_HASH = 2 as const;

export type RouteLocation = ReadonlyTupleOf<{
    [ROUTE_PATH]: string;
    [ROUTE_SEARCH]: string;
    [ROUTE_HASH]: string;
}>;

// ── Single Route Branch Definition ────────────────────────────────────────────
export const ROUTE_PATTERN = 0 as const;
export const ROUTE_RENDER = 1 as const;

export type RouteDef<
    P extends Record<string, string> = Record<string, string>,
> = ReadonlyTupleOf<{
    [ROUTE_PATTERN]: string; // e.g. "/chat/:room_id", "/voice", "*"
    [ROUTE_RENDER]: (
        paramsSig: ReadonlySignal<P>,
        scope: DomScope
    ) => ChildItem;
}>;

// ── Router Controller Instance ────────────────────────────────────────────────
export const ROUTER_LOC_SIG = 0 as const;
export const ROUTER_NAVIGATE = 1 as const;
export const ROUTER_REPLACE = 2 as const;

export type Router = ReadonlyTupleOf<{
    [ROUTER_LOC_SIG]: Signal<RouteLocation>;
    [ROUTER_NAVIGATE]: (to: string) => void;
    [ROUTER_REPLACE]: (to: string) => void;
}>;

// ── Router DOM Flow Node (`DomFlowNode` member) ───────────────────────────────
export const FLOW_ROUTER_INSTANCE = 1 as const;
export const FLOW_ROUTER_ROUTES = 2 as const;

export type DomRouterNode = ReadonlyTupleOf<{
    [DOM_META]: typeof FLOW_ROUTER;
    [FLOW_ROUTER_INSTANCE]: Router;
    [FLOW_ROUTER_ROUTES]: readonly RouteDef<any>[];
}>;
```

---

## 6. Nested Routes (`domRouter` Inside `domRouter`)

Because `DomRouterNode` is part of `DomFlowNode`, `domRouter(router, routes)` is a valid `ChildItem` anywhere in a `DOMStruct` tree, supporting arbitrary route nesting.

### Example: Nested Layout & Sub-Routes

```ts
const chatAppView = (ctx: Window, router: Router) =>
    domRouter(router, [
        route('/chat/:room_id', (paramsSig) =>
            section([genClass($chat_page)], [
                // Outer header stays mounted across sub-route transitions
                h1([genClass($chat__title)], [
                    'Chat room: ',
                    paramSignal(paramsSig, 'room_id'),
                ]),
                nav([], [
                    routerLink(
                        ctx,
                        router,
                        [genClass($nav_link)],
                        pipe(
                            paramsSig,
                            bindArg((p) => `/chat/${p.room_id}`, mapSignal)
                        ),
                        ['Messages']
                    ),
                    routerLink(
                        ctx,
                        router,
                        [genClass($nav_link)],
                        pipe(
                            paramsSig,
                            bindArg((p) => `/chat/${p.room_id}/voice`, mapSignal)
                        ),
                        ['Voice']
                    ),
                ]),

                // Nested router flow element inside section > div
                div([genClass($chat__body)], [
                    domRouter(router, [
                        route('/voice', (subParamsSig, subScope) =>
                            // Inherits `room_id` from parent + own scope
                            VoicePanelView(ctx, subParamsSig, subScope)
                        ),
                        route('/', (subParamsSig, subScope) =>
                            MessagesPanelView(ctx, subParamsSig, subScope)
                        ),
                    ]),
                ]),
            ])
        ),
    ]);
```

### How Nested Routing Works at Runtime

1. **Prefix Consumption & Tail Propagation**:
   - For `/chat/lobby/voice`, the outer `domRouter` matches `/chat/:room_id` as a prefix (`/chat/lobby`), extracts `{ room_id: "lobby" }`, and passes the remaining tail path `"/voice"` to its child mounting context.
   - The inner `domRouter` matches `"/voice"` against its local route table (`['/voice', '/']`).
2. **Parameter Inheritance (`combineSignals`)**:
   - The child route receives a merged `subParamsSig` combining the parent's `paramsSig` (`{ room_id: "lobby" }`) with any parameters extracted by the child route pattern.
3. **Granular Scope Disposal & In-Place Signal Updates**:
   - **Same route branch, different param** (`/chat/lobby/voice` $\rightarrow$ `/chat/general/voice`): Neither route index changed; `paramsSig` updates `room_id` in $O(1)$ without recreating DOM nodes.
   - **Same parent route, different child route** (`/chat/lobby` $\rightarrow$ `/chat/lobby/voice`): Outer `<section>` stays mounted; only the inner `domRouter` disposes `innerBranchScope` and swaps the child branch before its `<!---->` anchor.

---

## 7. Symbolic Tracing to JSON IR (`domToJson`) & Tera Generation (`jsonToTera`)

At compile time, `domToJson` evaluates the `DOMStruct` tree without a browser `Window` by feeding symbolic parameter tokens (`"\0$param:room_id\0"`) through `paramsSig`.

### Resulting Language-Agnostic JSON IR

```json
{
  "pattern": "/chat/:room_id",
  "params": ["room_id"],
  "template": [
    "section",
    { "class": "_p8kL1" },
    [
      [
        "h1",
        { "class": "_t2mQ9" },
        ["Chat room: ", { "$param": "room_id" }]
      ],
      [
        "div",
        { "class": "_b1xZ4" },
        [
          {
            "$flow": "router",
            "routes": [
              {
                "pattern": "/chat/:room_id/voice",
                "params": ["room_id"],
                "template": [
                  "div",
                  { "class": "_v9kP2" },
                  ["Voice channel for ", { "$param": "room_id" }]
                ]
              },
              {
                "pattern": "/chat/:room_id",
                "params": ["room_id"],
                "template": [
                  "div",
                  { "class": "_m3wQ8" },
                  ["Messages in ", { "$param": "room_id" }]
                ]
              }
            ]
          }
        ]
      ]
    ]
  ]
}
```

### Generated Tera `.html` Output (`jsonToTera`)

```html
<section class="_p8kL1"><h1 class="_t2mQ9">Chat room: {{ room_id }}</h1><div class="_b1xZ4">{% if route == "/chat/:room_id/voice" %}<div class="_v9kP2">Voice channel for {{ room_id }}</div>{% elif route == "/chat/:room_id" %}<div class="_m3wQ8">Messages in {{ room_id }}</div>{% endif %}<!----></div></section>
```

---

## 8. Implementation Roadmap

1. **Step 1 — Bit-Packed `DOM_META` & 3-Tuple `DOMStruct` (`assets/js/utils/dom.ts`)**:
   - Replace the 7-slot `DOMStruct` with the 3-tuple `[meta, props, children]` and bit-packed `DOM_META` flags (`NODE_KIND`, `META_FLAG_VOID`, `META_FLAG_SELF_DYN`, `META_FLAG_SUBTREE_DYN`, `META_FLAG_HAS_REF`, `REF_KEY`).
2. **Step 2 — Parallel Cursor Hydration (`domHydrate` / `domHydrateRef` in `dom.ts`)**:
   - Implement in-place hydration skipping static subtrees via `(meta & META_FLAG_ANY_DYN) === 0`, splitting adjacent text nodes via `splitText`, and adopting `<!---->` flow anchors.
3. **Step 3 — Router & Nested Flow Primitives (`assets/js/utils/router.ts` & `dom.ts`)**:
   - Add `RouteLocation`, `RouteDef`, `Router`, and `DomRouterNode` (`FLOW_ROUTER`) with prefix matching and `paramsSig` inheritance.
4. **Step 4 — Symbolic JSON Serializer, Tera Compiler & Bazel Rule (`assets/js/utils/ssr.ts` & `BUILD.bazel`)**:
   - Implement `domToJson` and `jsonToTera`, wire the Bazel `genrule`, and pre-render `tennis`, `month`, and `chat`.
