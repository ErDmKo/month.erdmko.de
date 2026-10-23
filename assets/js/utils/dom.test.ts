import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    bindArg,
    button,
    combineSignals,
    createStore,
    div,
    domCreator,
    domCreatorRef,
    domDispose,
    domIf,
    domList,
    domShow,
    DomScope,
    filterOperator,
    genAttr,
    genClass,
    genOn,
    genProp,
    genRef,
    genText,
    input,
    isSignal,
    li,
    mapSignal,
    on,
    pipe,
    SIGNAL_GET,
    SIGNAL_OBS,
    SIGNAL_SET,
    span,
    strong,
    ul,
} from './index';

// Minimal mock DOM environment for pure Node testing via explicit `ctx: Window`
class MockTextNode {
    nodeType = 3;
    data: string;
    parentNode: MockElement | null = null;
    constructor(data: string) {
        this.data = data;
    }
    get nextSibling(): MockNode | null {
        if (!this.parentNode) return null;
        const idx = this.parentNode.childNodes.indexOf(this);
        return idx >= 0 && idx + 1 < this.parentNode.childNodes.length
            ? this.parentNode.childNodes[idx + 1]
            : null;
    }
    get textContent(): string {
        return this.data;
    }
}

class MockElement {
    nodeType = 1;
    tagName: string;
    style: Record<string, any> = {};
    attributes = new Map<string, string>();
    childNodes: MockNode[] = [];
    parentNode: MockElement | null = null;
    listeners = new Map<string, Set<Function>>();
    hidden = false;
    disabled = false;
    innerText = '';

    constructor(tag: string) {
        this.tagName = tag.toUpperCase();
    }

    setAttribute(key: string, val: string) {
        this.attributes.set(key, val);
    }

    getAttribute(key: string): string | undefined {
        return this.attributes.get(key);
    }

    hasAttribute(key: string): boolean {
        return this.attributes.has(key);
    }

    removeAttribute(key: string) {
        this.attributes.delete(key);
    }

    appendChild(node: MockNode): MockNode {
        if (node.parentNode) {
            node.parentNode.removeChild(node);
        }
        node.parentNode = this;
        this.childNodes.push(node);
        return node;
    }

    insertBefore(node: MockNode, refNode: MockNode | null): MockNode {
        if (!refNode) {
            return this.appendChild(node);
        }
        if (node.parentNode) {
            node.parentNode.removeChild(node);
        }
        const idx = this.childNodes.indexOf(refNode);
        if (idx === -1) {
            return this.appendChild(node);
        }
        node.parentNode = this;
        this.childNodes.splice(idx, 0, node);
        return node;
    }

    removeChild(node: MockNode): MockNode {
        const idx = this.childNodes.indexOf(node);
        if (idx !== -1) {
            this.childNodes.splice(idx, 1);
            node.parentNode = null;
        }
        return node;
    }

    addEventListener(type: string, fn: Function) {
        let set = this.listeners.get(type);
        if (!set) {
            set = new Set();
            this.listeners.set(type, set);
        }
        set.add(fn);
    }

    removeEventListener(type: string, fn: Function) {
        this.listeners.get(type)?.delete(fn);
    }

    dispatchEvent(type: string, ev: any = {}) {
        const set = this.listeners.get(type);
        if (set) {
            for (const fn of [...set]) {
                fn(ev);
            }
        }
    }

    get nextSibling(): MockNode | null {
        if (!this.parentNode) return null;
        const idx = this.parentNode.childNodes.indexOf(this);
        return idx >= 0 && idx + 1 < this.parentNode.childNodes.length
            ? this.parentNode.childNodes[idx + 1]
            : null;
    }

    get textContent(): string {
        if (this.innerText) return this.innerText;
        return this.childNodes.map((c) => c.textContent).join('');
    }
}

type MockNode = MockElement | MockTextNode;

const REF_BTN = 0 as const;
const REF_INPUT = 1 as const;
const REF_BANNER = 0 as const;
const REF_LIST = 1 as const;

const createMockCtx = (): [Window, HTMLElement] => {
    const root = new MockElement('div') as unknown as HTMLElement;
    const ctx = {
        document: {
            createElement: (tag: string) => new MockElement(tag),
            createTextNode: (text: string) => new MockTextNode(text),
        },
    } as unknown as Window;
    return [ctx, root];
};

test('createStore, mapSignal, combineSignals, and filterOperator', () => {
    const countSig = createStore(2);
    assert.equal(isSignal(countSig), true);
    assert.equal(countSig[SIGNAL_GET](), 2);

    const doubledSig = pipe(
        countSig,
        bindArg((n: number) => n * 2, mapSignal)
    );
    assert.equal(doubledSig[SIGNAL_GET](), 4);

    const labelSig = createStore('items');
    const combinedSig = pipe(
        combineSignals(doubledSig, labelSig),
        bindArg(([num, lbl]: [number, string]) => `${num} ${lbl}`, mapSignal)
    );
    assert.equal(combinedSig[SIGNAL_GET](), '4 items');

    const observed: string[] = [];
    combinedSig[SIGNAL_OBS](
        bindArg((val: string) => {
            observed.push(val);
        }, on)
    );

    // Setting identical value should not trigger
    countSig[SIGNAL_SET](2);
    assert.deepEqual(observed, []);

    countSig[SIGNAL_SET](5);
    assert.equal(combinedSig[SIGNAL_GET](), '10 items');
    assert.deepEqual(observed, ['10 items']);

    labelSig[SIGNAL_SET]('boxes');
    assert.equal(combinedSig[SIGNAL_GET](), '10 boxes');
    assert.deepEqual(observed, ['10 items', '10 boxes']);

    // filterOperator test
    const evens: number[] = [];
    countSig[SIGNAL_OBS](bindArg((n: number) => n % 2 === 0, filterOperator))(
        bindArg((n: number) => evens.push(n), on)
    );
    countSig[SIGNAL_SET](7);
    countSig[SIGNAL_SET](8);
    assert.deepEqual(evens, [8]);
});

test('Option C tag factories, direct text & signal children, and reactive props/attrs', () => {
    const [ctx, root] = createMockCtx();
    const statusSig = createStore('connecting');
    const isDisabledSig = createStore(true);
    const activeClassSig = createStore<string | false>(false);

    const scope: DomScope = [];
    const refs = domCreatorRef(
        ctx,
        root,
        div(
            [genClass(['chat-header', activeClassSig])],
            [
                'Status: ',
                strong([], [statusSig]),
                input([
                    genRef(REF_INPUT),
                    genAttr('type', 'text'),
                    genAttr('readonly', isDisabledSig),
                ]),
                button(
                    [
                        genRef(REF_BTN),
                        genProp('disabled', isDisabledSig),
                    ],
                    ['Send']
                ),
            ]
        ),
        scope
    );

    const containerEl = (root as unknown as MockElement)
        .childNodes[0] as MockElement;
    const btnEl = refs[REF_BTN] as unknown as MockElement;
    const inputEl = refs[REF_INPUT] as unknown as MockElement;

    assert.equal(containerEl.getAttribute('class'), 'chat-header');
    assert.equal(containerEl.textContent, 'Status: connectingSend');
    assert.equal(btnEl.disabled, true);
    assert.equal(inputEl.hasAttribute('readonly'), true);

    // Mutate signals — DOM updates directly in place
    statusSig[SIGNAL_SET]('online');
    isDisabledSig[SIGNAL_SET](false);
    activeClassSig[SIGNAL_SET]('is-active');

    assert.equal(containerEl.getAttribute('class'), 'chat-header is-active');
    assert.equal(containerEl.textContent, 'Status: onlineSend');
    assert.equal(btnEl.disabled, false);
    assert.equal(inputEl.hasAttribute('readonly'), false);

    // Dispose scope — further signal updates no longer mutate DOM
    domDispose(scope);
    statusSig[SIGNAL_SET]('offline');
    assert.equal(containerEl.textContent, 'Status: onlineSend');
});

test('genOn attaches typed event listeners and cleans up on domDispose', () => {
    const [ctx, root] = createMockCtx();
    const scope: DomScope = [];
    let clicks = 0;

    const [btn] = domCreator(
        ctx,
        root,
        button([genRef(), genOn('click', () => clicks++)], ['Click me']),
        scope
    );

    const mockBtn = btn as unknown as MockElement;
    mockBtn.dispatchEvent('click');
    mockBtn.dispatchEvent('click');
    assert.equal(clicks, 2);

    domDispose(scope);
    mockBtn.dispatchEvent('click');
    assert.equal(clicks, 2);
});

test('domShow, domIf, and domList control flow primitives', () => {
    const [ctx, root] = createMockCtx();
    const scope: DomScope = [];

    const visibleSig = createStore(true);
    const loggedInSig = createStore(false);
    const itemsSig = createStore<readonly { id: number; text: string }[]>([
        { id: 1, text: 'first' },
        { id: 2, text: 'second' },
    ]);

    const refs = domCreatorRef(
        ctx,
        root,
        div(
            [],
            [
                domShow(
                    visibleSig,
                    span([genRef(REF_BANNER), genText('Banner')])
                ),
                domIf(
                    loggedInSig,
                    () => span([], ['Welcome user']),
                    () => span([], ['Please log in'])
                ),
                ul(
                    [genRef(REF_LIST)],
                    [
                        domList(
                            itemsSig,
                            (item) => item.id,
                            (item) => li([], [item.text])
                        ),
                    ]
                ),
            ]
        ),
        scope
    );

    const bannerEl = refs[REF_BANNER] as unknown as MockElement;
    const listEl = refs[REF_LIST] as unknown as MockElement;
    const containerEl = (root as unknown as MockElement)
        .childNodes[0] as MockElement;

    assert.equal(bannerEl.hidden, false);
    assert.equal(containerEl.textContent.includes('Please log in'), true);
    assert.equal(listEl.textContent, 'firstsecond');

    // Toggle domShow
    visibleSig[SIGNAL_SET](false);
    assert.equal(bannerEl.hidden, true);

    // Flip domIf branch
    loggedInSig[SIGNAL_SET](true);
    assert.equal(containerEl.textContent.includes('Please log in'), false);
    assert.equal(containerEl.textContent.includes('Welcome user'), true);

    // Reorder and update domList (reuses existing DOM nodes by key)
    const firstLiBefore = listEl.childNodes[0];
    itemsSig[SIGNAL_SET]([
        { id: 2, text: 'second' },
        { id: 1, text: 'first' },
        { id: 3, text: 'third' },
    ]);
    assert.equal(listEl.textContent, 'secondfirstthird');
    assert.equal(listEl.childNodes[1], firstLiBefore);

    domDispose(scope);
});
