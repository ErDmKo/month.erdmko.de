export const PROP = 0 as const;
export const REF = 1 as const;
export const ATTR = 2 as const;

type PropType = string | Function | Partial<CSSStyleDeclaration> | number
type AttrType = string | number;
export type RefKey = string | number;
type RefMarker = false | true | RefKey;

type Props =
    | readonly [type: typeof ATTR, key: string, value: AttrType]
    | readonly [type: typeof PROP, key: string, value: PropType]
    | readonly [type: typeof REF]
    | readonly [type: typeof REF, key: RefKey];

type TagName = keyof HTMLElementTagNameMap;
type PropMap = Record<string, PropType>;
type AttrMap = Record<string, AttrType>;

export type DOMStruct<K extends TagName> = readonly [
    tag: K, // 0
    props: PropMap, // 1
    attrs: AttrMap, // 2
    ref: RefMarker, // 3
    children?: readonly DOMStruct<TagName>[], // 4
    key?: string | number // 5
];

function genPropFn (name: 'style', value: Partial<CSSStyleDeclaration>): Props;
function genPropFn (name: 'onclick', value: (m: MouseEvent) => void): Props;
function genPropFn (name: string, value: PropType): Props;
function genPropFn (name: string, value:  PropType) {
  return [PROP, name, value] as const;
};

export const genProp = genPropFn;

export const genAttr = (name: string, value: string | number): Props => {
  return [ATTR, name, value] as const;
};

export function genRef(): Props;
export function genRef(key: RefKey): Props;
export function genRef(key?: RefKey): Props {
  return key === undefined ? [REF] as const : [REF, key] as const;
}

export const genText = (text: string | number): Props => {
  return [PROP, 'innerText', text] as const
};

export const genClass = (className: string): Props => {
  return [ATTR, 'class', className] as const
}

export const genTagDiv = <T extends TagName>(
  props: Props[],
  children: DOMStruct<T>[] = [],
): DOMStruct<T> => {
  const [propMap, attrMap, hasRef] = collectProps(props);
  return ['div' as T, propMap, attrMap, hasRef, children] as const;
};

export const genTagName = <T extends TagName>(
  tagName: T,
  props: Props[],
  children: DOMStruct<T>[] = []
): DOMStruct<T> => { 
  const [propMap, attrMap, hasRef] = collectProps(props);
  return [tagName, propMap, attrMap, hasRef, children] as const;
};

const collectProps = (attributes: readonly Props[]): [PropMap, AttrMap, RefMarker] => {
    const props: PropMap = {};
    const attrs: AttrMap = {};
    let ref: RefMarker = false;
    for (const item of attributes) {
        const type = item[0];
        if (type === REF) {
            ref = item.length > 1 ? item[1] : true;
            continue;
        }
        if (type === PROP) {
            const [, key, value] = item;
            props[key] = value;
        } else {
            const [, key, value] = item;
            attrs[key] = value;
        }
    }
    return [props, attrs, ref];
};

const isFragment = (struct: DOMStruct<TagName> | DOMStruct<TagName>[]): struct is DOMStruct<TagName>[] => {
  return struct.length > 0 && Array.isArray(struct[0]);
}

export const domCreator = <K extends keyof HTMLElementTagNameMap>(
    ctx: Window,
    root: Element,
    struct: DOMStruct<K> | DOMStruct<TagName>[]
): HTMLElementTagNameMap[K][] => {
    if (!(ctx.document && typeof ctx.document.createElement == 'function')) {
        throw new Error();
    }
    const currnent: [Element, DOMStruct<TagName>][] = isFragment(struct) 
      ? struct.reverse()
          .map((s) => [root, s])
      : [[root, struct as DOMStruct<TagName>]];
    const refs: HTMLElementTagNameMap[K][] = [];
    while (currnent.length) {
        const nextStruct = currnent.pop();
        if (!nextStruct) {
            break;
        }
        const [root, struct] = nextStruct;
        const [tag, props, attrs, ref, children] = struct;
        const element = ctx.document.createElement(tag);
        if (ref) {
            refs.push(element as HTMLElementTagNameMap[K]);
        }
        for (const key of Object.keys(props)) {
            const value = props[key];
            if (key === 'style') {
                Object.assign(element.style, value);
            } else {
                (element as any)[key] = value;
            }
        }
        for (const key of Object.keys(attrs)) {
            element.setAttribute(key, `${attrs[key]}`);
        }
        root.appendChild(element);
        (children || []).forEach((child) => {
            currnent.unshift([element, child]);
        });
    }
    return refs;
};

export const domCreatorRef = <K extends keyof HTMLElementTagNameMap>(
    ctx: Window,
    root: Element,
    struct: DOMStruct<K> | DOMStruct<TagName>[]
): Record<string, HTMLElementTagNameMap[K]> => {
    if (!(ctx.document && typeof ctx.document.createElement == 'function')) {
        throw new Error();
    }
    const currnent: [Element, DOMStruct<TagName>][] = isFragment(struct)
      ? struct.reverse()
          .map((s) => [root, s])
      : [[root, struct as DOMStruct<TagName>]];
    const refs: Record<string, HTMLElementTagNameMap[K]> = {};
    while (currnent.length) {
        const nextStruct = currnent.pop();
        if (!nextStruct) {
            break;
        }
        const [root, struct] = nextStruct;
        const [tag, props, attrs, ref, children] = struct;
        const element = ctx.document.createElement(tag);
        if (ref !== false && ref !== true) {
            refs[String(ref)] = element as HTMLElementTagNameMap[K];
        }
        for (const key of Object.keys(props)) {
            const value = props[key];
            if (key === 'style') {
                Object.assign(element.style, value);
            } else {
                (element as any)[key] = value;
            }
        }
        for (const key of Object.keys(attrs)) {
            element.setAttribute(key, `${attrs[key]}`);
        }
        root.appendChild(element);
        (children || []).forEach((child) => {
            currnent.unshift([element, child]);
        });
    }
    return refs;
};

export const cleanHtml = (root: HTMLElement) => {
    while (root.firstChild) {
        root.removeChild(root.firstChild);
    }
}
