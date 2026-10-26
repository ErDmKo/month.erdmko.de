import { bindArg } from './bind';
import {
    distinctOperator,
    isSignal,
    observer,
    off,
    on,
    Reactive,
    ReadonlySignal,
    SIGNAL_GET,
    SIGNAL_OBS,
    trigger,
} from './observer';
import type { ReadonlyTupleOf, TupleOf } from './tuple';

export const PROP = 0 as const;
export const REF = 1 as const;
export const ATTR = 2 as const;
export const ON = 3 as const;

export const PROP_TYPE = 0 as const;
export const PROP_KEY = 1 as const;
export const PROP_VALUE = 2 as const;
export const PROP_OPTIONS = 3 as const;
export const REF_KEY = 1 as const;

export const EMPTY: readonly never[] = [] as const;

// Bits 0..2 identify elements and flow nodes in the shared metadata slot.
export const META_KIND_MASK = 0x7 as const;
export const NODE_ELEMENT = 0 as const;
export const FLOW_SHOW = 1 as const;
export const FLOW_IF = 2 as const;
export const FLOW_LIST = 3 as const;
export const FLOW_ROUTER = 4 as const;

export const META_FLAG_SELF_DYN = 1 << 3;
export const META_FLAG_SUBTREE_DYN = 1 << 4;
export const META_FLAG_ANY_DYN = META_FLAG_SELF_DYN | META_FLAG_SUBTREE_DYN;
export const META_FLAG_HAS_REF = 1 << 5;
export const META_FLAG_HAS_REF_KEY = 1 << 6;

// Bits 7..29 store a 23-bit ref key, keeping meta within positive SMI range.
export const META_REF_SHIFT = 7 as const;
export const META_REF_MAX = 0x7fffff as const;

export const DOM_META = 0 as const;
export const DOM_TAG = 1 as const;
export const DOM_PROPS = 2 as const;
export const DOM_CHILDREN = 3 as const;

export const FLOW_SHOW_COND = 1 as const;
export const FLOW_SHOW_CHILD = 2 as const;

export const FLOW_IF_COND = 1 as const;
export const FLOW_IF_THEN = 2 as const;
export const FLOW_IF_ELSE = 3 as const;

export const FLOW_LIST_ITEMS = 1 as const;
export const FLOW_LIST_KEY = 2 as const;
export const FLOW_LIST_RENDER = 3 as const;

const ENTRY_EL = 0 as const;
const ENTRY_SCOPE = 1 as const;
type ListEntry = TupleOf<{
    [ENTRY_EL]: HTMLElement;
    [ENTRY_SCOPE]: DomScope;
}>;

type PropValue =
    | string
    | Function
    | Partial<CSSStyleDeclaration>
    | number
    | boolean;
type PropType = Reactive<PropValue>;
type AttrValue = string | number | boolean | null | undefined;
type AttrType = Reactive<AttrValue>;
export type RefKey = number;

export type Props =
    | readonly [type: typeof ATTR, key: string, value: AttrType]
    | readonly [type: typeof PROP, key: string, value: PropType]
    | readonly [type: typeof REF]
    | readonly [type: typeof REF, key: RefKey]
    | readonly [
          type: typeof ON,
          event: keyof HTMLElementEventMap,
          listener: (ev: any) => void,
          options?: boolean | AddEventListenerOptions,
      ];

export type TagName = keyof HTMLElementTagNameMap;
export type VoidTagName =
    | 'area'
    | 'base'
    | 'br'
    | 'col'
    | 'embed'
    | 'hr'
    | 'img'
    | 'input'
    | 'link'
    | 'meta'
    | 'source'
    | 'track'
    | 'wbr';
export type ContainerTagName = Exclude<TagName, VoidTagName>;

export type DomShowNode = ReadonlyTupleOf<{
    [DOM_META]: typeof FLOW_SHOW;
    [FLOW_SHOW_COND]: ReadonlySignal<boolean>;
    [FLOW_SHOW_CHILD]: DOMStruct<any, any>;
}>;

export type DomIfNode = ReadonlyTupleOf<{
    [DOM_META]: typeof FLOW_IF;
    [FLOW_IF_COND]: ReadonlySignal<boolean>;
    [FLOW_IF_THEN]: () => ChildItem | null | undefined | false;
    [FLOW_IF_ELSE]: (() => ChildItem | null | undefined | false) | undefined;
}>;

export type DomListNode<T = any> = ReadonlyTupleOf<{
    [DOM_META]: typeof FLOW_LIST;
    [FLOW_LIST_ITEMS]: ReadonlySignal<readonly T[]>;
    [FLOW_LIST_KEY]: (item: T, index: number) => string | number;
    [FLOW_LIST_RENDER]: (item: T, index: number) => DOMStruct<any, any>;
}>;

export type DomFlowNode = DomShowNode | DomIfNode | DomListNode<any>;

export type ChildItem =
    | DOMStruct<any, any>
    | DomFlowNode
    | string
    | number
    | ReadonlySignal<string | number>;

export type DOMStruct<
    K extends TagName = TagName,
    C extends ChildItem = ChildItem,
> = ReadonlyTupleOf<{
    [DOM_META]: number;
    [DOM_TAG]: K;
    [DOM_PROPS]: readonly Props[];
    [DOM_CHILDREN]: readonly C[];
}>;

export type DomScope = (() => void)[];

export const domDispose = (scope: DomScope): void => {
    while (scope.length) {
        const cleanup = scope.pop();
        if (cleanup) cleanup();
    }
};

function genPropFn(
    name: 'style',
    value: Reactive<Partial<CSSStyleDeclaration>>
): Props;
function genPropFn(name: 'onclick', value: (m: MouseEvent) => void): Props;
function genPropFn(name: string, value: PropType): Props;
function genPropFn(name: string, value: PropType) {
    return [PROP, name, value] as const;
}

export const genProp = genPropFn;

export const genAttr = (name: string, value: AttrType): Props => {
    return [ATTR, name, value] as const;
};

export const genOn = <K extends keyof HTMLElementEventMap>(
    event: K,
    listener: (ev: HTMLElementEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions
): Props => {
    return [ON, event, listener, options] as const;
};

export function genRef(): Props;
export function genRef(key: RefKey): Props;
export function genRef(key?: RefKey): Props {
    if (
        key !== undefined &&
        (!Number.isInteger(key) || key < 0 || key > META_REF_MAX)
    ) {
        throw new RangeError();
    }
    return key === undefined ? ([REF] as const) : ([REF, key] as const);
}

export const genText = (text: Reactive<string | number>): Props => {
    return [PROP, 'innerText', text] as const;
};

export type ClassValue =
    | string
    | false
    | null
    | undefined
    | ReadonlySignal<string | false | null | undefined>;

export const genClass = (
    className: ClassValue | readonly ClassValue[]
): Props => {
    if (!Array.isArray(className) || isSignal(className)) {
        return [ATTR, 'class', className as AttrType] as const;
    }
    const hasReactive = className.some(isSignal);
    if (!hasReactive) {
        return [ATTR, 'class', className.filter(Boolean).join(' ')] as const;
    }
    const classObs = observer<string>();
    const computeClass = () =>
        className
            .map((item) =>
                isSignal<string | false | null | undefined>(item)
                    ? item[SIGNAL_GET]()
                    : item
            )
            .filter(Boolean)
            .join(' ');
    for (const item of className) {
        if (isSignal(item)) {
            item[SIGNAL_OBS](
                bindArg(() => {
                    classObs(bindArg(computeClass(), trigger));
                }, on)
            );
        }
    }
    const derivedSig: ReadonlySignal<string> = [
        computeClass,
        undefined,
        classObs(distinctOperator),
    ];
    return [ATTR, 'class', derivedSig] as const;
};

export const genTagDiv = <
    T extends TagName = 'div',
    C extends ChildItem = ChildItem,
>(
    props: readonly Props[] = EMPTY,
    children: readonly C[] = EMPTY
): DOMStruct<T, C> => genTagName('div' as T, props, children);

export const genTagName = <T extends TagName, C extends ChildItem = ChildItem>(
    tagName: T,
    props: readonly Props[] = EMPTY,
    children: readonly C[] = EMPTY
): DOMStruct<T, C> => [getDomMeta(props, children), tagName, props, children];

// ── Option C Tag Factories ────────────────────────────────────────────────────

export const createTagFactory =
    <K extends ContainerTagName>(tagName: K) =>
    <C extends ChildItem = ChildItem>(
        props: readonly Props[] = EMPTY,
        children: readonly C[] = EMPTY
    ): DOMStruct<K, C> =>
        genTagName(tagName, props, children);

export const createVoidTagFactory =
    <K extends VoidTagName>(tagName: K) =>
    (props: readonly Props[] = EMPTY): DOMStruct<K, never> =>
        genTagName<K, never>(tagName, props, EMPTY);

// Container HTML elements
export const a = /* @__PURE__ */ createTagFactory('a');
export const article = /* @__PURE__ */ createTagFactory('article');
export const aside = /* @__PURE__ */ createTagFactory('aside');
export const audio = /* @__PURE__ */ createTagFactory('audio');
export const b = /* @__PURE__ */ createTagFactory('b');
export const blockquote = /* @__PURE__ */ createTagFactory('blockquote');
export const button = /* @__PURE__ */ createTagFactory('button');
export const canvas = /* @__PURE__ */ createTagFactory('canvas');
export const code = /* @__PURE__ */ createTagFactory('code');
export const dd = /* @__PURE__ */ createTagFactory('dd');
export const details = /* @__PURE__ */ createTagFactory('details');
export const dialog = /* @__PURE__ */ createTagFactory('dialog');
export const div = /* @__PURE__ */ createTagFactory('div');
export const dl = /* @__PURE__ */ createTagFactory('dl');
export const dt = /* @__PURE__ */ createTagFactory('dt');
export const em = /* @__PURE__ */ createTagFactory('em');
export const fieldset = /* @__PURE__ */ createTagFactory('fieldset');
export const figcaption = /* @__PURE__ */ createTagFactory('figcaption');
export const figure = /* @__PURE__ */ createTagFactory('figure');
export const footer = /* @__PURE__ */ createTagFactory('footer');
export const form = /* @__PURE__ */ createTagFactory('form');
export const h1 = /* @__PURE__ */ createTagFactory('h1');
export const h2 = /* @__PURE__ */ createTagFactory('h2');
export const h3 = /* @__PURE__ */ createTagFactory('h3');
export const h4 = /* @__PURE__ */ createTagFactory('h4');
export const h5 = /* @__PURE__ */ createTagFactory('h5');
export const h6 = /* @__PURE__ */ createTagFactory('h6');
export const header = /* @__PURE__ */ createTagFactory('header');
export const i = /* @__PURE__ */ createTagFactory('i');
export const iframe = /* @__PURE__ */ createTagFactory('iframe');
export const kbd = /* @__PURE__ */ createTagFactory('kbd');
export const label = /* @__PURE__ */ createTagFactory('label');
export const legend = /* @__PURE__ */ createTagFactory('legend');
export const li = /* @__PURE__ */ createTagFactory('li');
export const main = /* @__PURE__ */ createTagFactory('main');
export const mark = /* @__PURE__ */ createTagFactory('mark');
export const menu = /* @__PURE__ */ createTagFactory('menu');
export const meter = /* @__PURE__ */ createTagFactory('meter');
export const nav = /* @__PURE__ */ createTagFactory('nav');
export const ol = /* @__PURE__ */ createTagFactory('ol');
export const optgroup = /* @__PURE__ */ createTagFactory('optgroup');
export const option = /* @__PURE__ */ createTagFactory('option');
export const output = /* @__PURE__ */ createTagFactory('output');
export const p = /* @__PURE__ */ createTagFactory('p');
export const picture = /* @__PURE__ */ createTagFactory('picture');
export const pre = /* @__PURE__ */ createTagFactory('pre');
export const progress = /* @__PURE__ */ createTagFactory('progress');
export const q = /* @__PURE__ */ createTagFactory('q');
export const s = /* @__PURE__ */ createTagFactory('s');
export const samp = /* @__PURE__ */ createTagFactory('samp');
export const section = /* @__PURE__ */ createTagFactory('section');
export const select = /* @__PURE__ */ createTagFactory('select');
export const small = /* @__PURE__ */ createTagFactory('small');
export const span = /* @__PURE__ */ createTagFactory('span');
export const strong = /* @__PURE__ */ createTagFactory('strong');
export const sub = /* @__PURE__ */ createTagFactory('sub');
export const summary = /* @__PURE__ */ createTagFactory('summary');
export const sup = /* @__PURE__ */ createTagFactory('sup');
export const table = /* @__PURE__ */ createTagFactory('table');
export const tbody = /* @__PURE__ */ createTagFactory('tbody');
export const td = /* @__PURE__ */ createTagFactory('td');
export const textarea = /* @__PURE__ */ createTagFactory('textarea');
export const tfoot = /* @__PURE__ */ createTagFactory('tfoot');
export const th = /* @__PURE__ */ createTagFactory('th');
export const thead = /* @__PURE__ */ createTagFactory('thead');
export const time = /* @__PURE__ */ createTagFactory('time');
export const tr = /* @__PURE__ */ createTagFactory('tr');
export const u = /* @__PURE__ */ createTagFactory('u');
export const ul = /* @__PURE__ */ createTagFactory('ul');
export const video = /* @__PURE__ */ createTagFactory('video');

// Void HTML elements
export const area = /* @__PURE__ */ createVoidTagFactory('area');
export const base = /* @__PURE__ */ createVoidTagFactory('base');
export const br = /* @__PURE__ */ createVoidTagFactory('br');
export const col = /* @__PURE__ */ createVoidTagFactory('col');
export const embed = /* @__PURE__ */ createVoidTagFactory('embed');
export const hr = /* @__PURE__ */ createVoidTagFactory('hr');
export const img = /* @__PURE__ */ createVoidTagFactory('img');
export const input = /* @__PURE__ */ createVoidTagFactory('input');
export const link = /* @__PURE__ */ createVoidTagFactory('link');
export const meta = /* @__PURE__ */ createVoidTagFactory('meta');
export const source = /* @__PURE__ */ createVoidTagFactory('source');
export const track = /* @__PURE__ */ createVoidTagFactory('track');
export const wbr = /* @__PURE__ */ createVoidTagFactory('wbr');

// ── Flow Primitives ───────────────────────────────────────────────────────────

export const domShow = (
    cond: ReadonlySignal<boolean>,
    child: DOMStruct<any, any>
): DomShowNode => [FLOW_SHOW, cond, child] as const;

export const domIf = (
    cond: ReadonlySignal<boolean>,
    thenBranch: () => ChildItem | null | undefined | false,
    elseBranch?: () => ChildItem | null | undefined | false
): DomIfNode => [FLOW_IF, cond, thenBranch, elseBranch] as const;

export const domList = <T>(
    items: ReadonlySignal<readonly T[]>,
    keyFn: (item: T, index: number) => string | number,
    renderItem: (item: T, index: number) => DOMStruct<any, any>
): DomListNode<T> => [FLOW_LIST, items, keyFn, renderItem] as const;

// ── Internal Materializer ─────────────────────────────────────────────────────

const getDomMeta = (
    props: readonly Props[],
    children: readonly ChildItem[]
): number => {
    let meta: number = NODE_ELEMENT;
    for (const item of props) {
        const type = item[PROP_TYPE];
        if (type === REF) {
            // As before, the last ref marker wins, including an unnamed ref.
            meta = META_FLAG_SELF_DYN | META_FLAG_HAS_REF;
            if (item.length > 1) {
                meta |=
                    META_FLAG_HAS_REF_KEY | (item[REF_KEY] << META_REF_SHIFT);
            }
        } else if (type === ON || isSignal(item[PROP_VALUE])) {
            meta |= META_FLAG_SELF_DYN;
        }
    }
    for (const child of children) {
        if (typeof child === 'string' || typeof child === 'number') continue;
        if (
            isSignal(child) ||
            (child[DOM_META] & META_KIND_MASK) !== NODE_ELEMENT ||
            (child[DOM_META] & META_FLAG_ANY_DYN) !== 0
        ) {
            meta |= META_FLAG_SUBTREE_DYN;
            break;
        }
    }
    return meta;
};

const FRAGMENT_FIRST = 0 as const;

const isFragment = (
    struct: DOMStruct<TagName, any> | readonly DOMStruct<TagName, any>[]
): struct is readonly DOMStruct<TagName, any>[] => {
    return struct.length > 0 && Array.isArray(struct[FRAGMENT_FIRST]);
};

const isFlowNode = (item: unknown): item is DomFlowNode =>
    Array.isArray(item) && (item[DOM_META] & META_KIND_MASK) !== NODE_ELEMENT;

const applySingleProp = (
    element: HTMLElement,
    key: string,
    rawVal: PropValue
): void => {
    if (key === 'style') {
        Object.assign(element.style, rawVal);
    } else {
        (element as any)[key] = rawVal;
    }
};

const applySingleAttr = (
    element: HTMLElement,
    key: string,
    rawVal: AttrValue
): void => {
    if (rawVal === false || rawVal === null || rawVal === undefined) {
        element.removeAttribute(key);
    } else if (rawVal === true) {
        element.setAttribute(key, '');
    } else {
        element.setAttribute(key, `${rawVal}`);
    }
};

const bindElementValue = <T>(
    element: HTMLElement,
    key: string,
    value: Reactive<T>,
    apply: (element: HTMLElement, key: string, value: T) => void,
    scope: DomScope
): void => {
    if (isSignal<T>(value)) {
        apply(element, key, value[SIGNAL_GET]());
        const onUpdate = (nextVal: T) => {
            apply(element, key, nextVal);
        };
        value[SIGNAL_OBS](bindArg(onUpdate, on));
        scope.push(() => value[SIGNAL_OBS](bindArg(onUpdate, off)));
    } else {
        apply(element, key, value);
    }
};

const bindElementData = (
    element: HTMLElement,
    props: readonly Props[],
    scope: DomScope
): void => {
    for (const item of props) {
        const type = item[PROP_TYPE];
        if (type === REF) continue;
        if (type === ON) {
            const eventName = item[PROP_KEY];
            const listener = item[PROP_VALUE] as EventListener;
            const options = item[PROP_OPTIONS];
            element.addEventListener(eventName, listener, options);
            scope.push(() =>
                element.removeEventListener(eventName, listener, options)
            );
            continue;
        }
        const key = item[PROP_KEY];
        if (type === PROP) {
            bindElementValue(
                element,
                key,
                item[PROP_VALUE],
                applySingleProp,
                scope
            );
        } else {
            bindElementValue(
                element,
                key,
                item[PROP_VALUE],
                applySingleAttr,
                scope
            );
        }
    }
};

const createTextBinding = (
    ctx: Window,
    sig: ReadonlySignal<string | number>,
    scope: DomScope
): Text => {
    const textNode = ctx.document.createTextNode(String(sig[SIGNAL_GET]()));
    const onUpdate = (val: string | number) => {
        textNode.data = String(val);
    };
    sig[SIGNAL_OBS](bindArg(onUpdate, on));
    scope.push(() => sig[SIGNAL_OBS](bindArg(onUpdate, off)));
    return textNode;
};

const mountFlowNode = (
    ctx: Window,
    parent: Element,
    flow: DomFlowNode,
    onRef: (meta: number, el: HTMLElement) => void,
    scope: DomScope,
    beforeAnchor?: Node
): Node[] => {
    const insertNode = (node: Node) => {
        if (beforeAnchor) {
            parent.insertBefore(node, beforeAnchor);
        } else {
            parent.appendChild(node);
        }
    };

    if (flow[DOM_META] === FLOW_SHOW) {
        const cond = flow[FLOW_SHOW_COND];
        const childStruct = flow[FLOW_SHOW_CHILD];
        const createdNodes = mountChildItem(
            ctx,
            parent,
            childStruct,
            onRef,
            scope,
            beforeAnchor
        );
        const targetEl = createdNodes[0] as HTMLElement | undefined;
        if (targetEl) {
            targetEl.hidden = !cond[SIGNAL_GET]();
            const onCond = (visible: boolean) => {
                targetEl.hidden = !visible;
            };
            cond[SIGNAL_OBS](bindArg(onCond, on));
            scope.push(() => cond[SIGNAL_OBS](bindArg(onCond, off)));
        }
        return createdNodes;
    }

    if (flow[DOM_META] === FLOW_IF) {
        const cond = flow[FLOW_IF_COND];
        const thenBranch = flow[FLOW_IF_THEN];
        const elseBranch = flow[FLOW_IF_ELSE];
        const anchor = ctx.document.createTextNode('');
        insertNode(anchor);

        let branchScope: DomScope = [];
        let branchNodes: Node[] = [];

        const renderBranch = (condVal: boolean) => {
            domDispose(branchScope);
            for (const n of branchNodes) {
                if (n.parentNode) {
                    n.parentNode.removeChild(n);
                }
            }
            branchNodes = [];
            branchScope = [];
            const item = condVal ? thenBranch() : elseBranch?.();
            if (item !== null && item !== undefined && item !== false) {
                branchNodes = mountChildItem(
                    ctx,
                    parent,
                    item,
                    onRef,
                    branchScope,
                    anchor
                );
            }
        };

        renderBranch(Boolean(cond[SIGNAL_GET]()));
        const onCond = (val: boolean) => renderBranch(Boolean(val));
        cond[SIGNAL_OBS](bindArg(onCond, on));
        scope.push(() => {
            cond[SIGNAL_OBS](bindArg(onCond, off));
            domDispose(branchScope);
        });
        return [...branchNodes, anchor];
    }

    // FLOW_LIST
    const itemsSig = flow[FLOW_LIST_ITEMS];
    const keyFn = flow[FLOW_LIST_KEY];
    const renderItem = flow[FLOW_LIST_RENDER];
    const anchor = ctx.document.createTextNode('');
    insertNode(anchor);

    const entryMap = new Map<string | number, ListEntry>();

    const reconcile = (items: readonly any[]) => {
        const nextKeys = new Set<string | number>();
        const orderedEls: HTMLElement[] = [];

        for (let idx = 0; idx < items.length; idx++) {
            const item = items[idx];
            const key = keyFn(item, idx);
            nextKeys.add(key);
            let entry = entryMap.get(key);
            if (!entry) {
                const itemScope: DomScope = [];
                const itemStruct = renderItem(item, idx);
                const nodes = mountChildItem(
                    ctx,
                    parent,
                    itemStruct,
                    onRef,
                    itemScope,
                    anchor
                );
                const el = nodes[0] as HTMLElement;
                entry = [el, itemScope];
                entryMap.set(key, entry);
            }
            orderedEls.push(entry[ENTRY_EL]);
        }

        for (const [oldKey, oldEntry] of entryMap.entries()) {
            if (!nextKeys.has(oldKey)) {
                domDispose(oldEntry[ENTRY_SCOPE]);
                const oldEl = oldEntry[ENTRY_EL];
                if (oldEl.parentNode) {
                    oldEl.parentNode.removeChild(oldEl);
                }
                entryMap.delete(oldKey);
            }
        }

        let nextSibling: Node = anchor;
        for (let idx = orderedEls.length - 1; idx >= 0; idx--) {
            const el = orderedEls[idx];
            if (el.nextSibling !== nextSibling || el.parentNode !== parent) {
                parent.insertBefore(el, nextSibling);
            }
            nextSibling = el;
        }
    };

    reconcile(itemsSig[SIGNAL_GET]());
    const onItems = (nextItems: readonly any[]) => reconcile(nextItems);
    itemsSig[SIGNAL_OBS](bindArg(onItems, on));
    scope.push(() => {
        itemsSig[SIGNAL_OBS](bindArg(onItems, off));
        for (const [, entry] of entryMap.entries()) {
            domDispose(entry[ENTRY_SCOPE]);
        }
        entryMap.clear();
    });
    return [anchor];
};

const mountChildItem = (
    ctx: Window,
    parent: Element,
    child: ChildItem,
    onRef: (meta: number, el: HTMLElement) => void,
    scope: DomScope,
    beforeAnchor?: Node
): Node[] => {
    const insertNode = (node: Node) => {
        if (beforeAnchor) {
            parent.insertBefore(node, beforeAnchor);
        } else {
            parent.appendChild(node);
        }
    };

    if (typeof child === 'string' || typeof child === 'number') {
        const textNode = ctx.document.createTextNode(String(child));
        insertNode(textNode);
        return [textNode];
    }

    if (isSignal<string | number>(child)) {
        const textNode = createTextBinding(ctx, child, scope);
        insertNode(textNode);
        return [textNode];
    }

    if (isFlowNode(child)) {
        return mountFlowNode(ctx, parent, child, onRef, scope, beforeAnchor);
    }

    return mountStructQueue(ctx, parent, child, onRef, scope, beforeAnchor);
};

const QUEUE_PARENT = 0 as const;
const QUEUE_ITEM = 1 as const;
const QUEUE_ANCHOR = 2 as const;
type QueueEntry = [parent: Element, item: ChildItem, anchor?: Node];

const mountStructQueue = (
    ctx: Window,
    root: Element,
    struct: DOMStruct<TagName, any> | readonly DOMStruct<TagName, any>[],
    onRef: (meta: number, el: HTMLElement) => void,
    scope: DomScope,
    beforeAnchor?: Node
): HTMLElement[] => {
    if (!(ctx.document && typeof ctx.document.createElement == 'function')) {
        throw new Error();
    }
    const queue: QueueEntry[] = isFragment(struct)
        ? struct.map((s) => [root, s, beforeAnchor])
        : [[root, struct as DOMStruct<TagName, any>, beforeAnchor]];
    const topElements: HTMLElement[] = [];
    const topCount = queue.length;

    let head = 0;
    while (head < queue.length) {
        const current = queue[head++];
        const parent = current[QUEUE_PARENT];
        const item = current[QUEUE_ITEM];
        const anchor = current[QUEUE_ANCHOR];

        const insertNode = (node: Node) => {
            if (anchor) {
                parent.insertBefore(node, anchor);
            } else {
                parent.appendChild(node);
            }
        };

        if (typeof item === 'string' || typeof item === 'number') {
            insertNode(ctx.document.createTextNode(String(item)));
            continue;
        }

        if (isSignal<string | number>(item)) {
            insertNode(createTextBinding(ctx, item, scope));
            continue;
        }

        if (isFlowNode(item)) {
            mountFlowNode(ctx, parent, item, onRef, scope, anchor);
            continue;
        }

        const meta = item[DOM_META];
        const tag = item[DOM_TAG];
        const props = item[DOM_PROPS];
        const children = item[DOM_CHILDREN];

        const element = ctx.document.createElement(tag);
        if (head <= topCount) {
            topElements.push(element);
        }
        onRef(meta, element);
        bindElementData(element, props, scope);
        insertNode(element);

        for (let idx = 0; idx < children.length; idx++) {
            queue.push([element, children[idx]]);
        }
    }
    return topElements;
};

export const domCreator = <K extends keyof HTMLElementTagNameMap>(
    ctx: Window,
    root: Element,
    struct: DOMStruct<K, any> | readonly DOMStruct<TagName, any>[],
    scope: DomScope = []
): HTMLElementTagNameMap[K][] => {
    const refs: HTMLElementTagNameMap[K][] = [];
    mountStructQueue(
        ctx,
        root,
        struct,
        (meta, el) => {
            if (meta & META_FLAG_HAS_REF) {
                refs.push(el as HTMLElementTagNameMap[K]);
            }
        },
        scope
    );
    return refs;
};

export const domCreatorRef = <K extends keyof HTMLElementTagNameMap>(
    ctx: Window,
    root: Element,
    struct: DOMStruct<K, any> | readonly DOMStruct<TagName, any>[],
    scope: DomScope = []
): Record<RefKey, HTMLElementTagNameMap[K]> => {
    const refs: Record<RefKey, HTMLElementTagNameMap[K]> = {};
    mountStructQueue(
        ctx,
        root,
        struct,
        (meta, el) => {
            if (meta & META_FLAG_HAS_REF_KEY) {
                refs[meta >> META_REF_SHIFT] = el as HTMLElementTagNameMap[K];
            }
        },
        scope
    );
    return refs;
};

export const cleanHtml = (root: HTMLElement) => {
    while (root.firstChild) {
        root.removeChild(root.firstChild);
    }
};
