import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    bindArg,
    combineSignals,
    createStore,
    DOM_CHILDREN,
    DOM_META,
    DOM_PROPS,
    DOM_TAG,
    domCreator,
    domCreatorRef,
    domDispose,
    domIf,
    domList,
    domShow,
    DomScope,
    EMPTY,
    filterOperator,
    FLOW_IF,
    FLOW_LIST,
    FLOW_ROUTER,
    FLOW_SHOW,
    genAttr,
    genClass,
    genOn,
    genProp,
    genRef,
    genTagName,
    genText,
    isSignal,
    mapSignal,
    META_FLAG_ANY_DYN,
    META_FLAG_HAS_REF,
    META_FLAG_HAS_REF_KEY,
    META_FLAG_SELF_DYN,
    META_FLAG_SUBTREE_DYN,
    META_KIND_MASK,
    META_REF_MAX,
    META_REF_SHIFT,
    NODE_ELEMENT,
    on,
    pipe,
    SIGNAL_GET,
    SIGNAL_OBS,
    SIGNAL_SET,
} from './index';
import { createTestWindow } from '../test-window';

const REF_BTN = 0 as const;
const REF_INPUT = 1 as const;
const REF_BANNER = 0 as const;
const REF_LIST = 1 as const;

const createMockCtx = (): [Window, HTMLElement] => {
    const ctx = createTestWindow();
    const root = ctx.document.createElement('div');
    return [ctx, root];
};

test('DOMStruct is a four-tuple retaining readonly props, children, and literal tags', () => {
    const props = Object.freeze([genClass('card'), genAttr('data-id', 7)]);
    const children = Object.freeze(['static', genTagName('span', [], [42])]);
    const struct = genTagName('div', props, children);

    assert.equal(struct.length, 4);
    assert.equal(struct[DOM_META], NODE_ELEMENT);
    assert.equal(struct[DOM_TAG], 'div');
    assert.equal(struct[DOM_PROPS], props);
    assert.equal(struct[DOM_CHILDREN], children);
    assert.equal(
        genTagName('section', props, children)[DOM_CHILDREN],
        children
    );
});

test('genTagName shares EMPTY when props or children are omitted', () => {
    for (const struct of [
        genTagName('div'),
        genTagName('span'),
        genTagName('input'),
        genTagName('p'),
    ]) {
        assert.equal(struct[DOM_PROPS], EMPTY);
        assert.equal(struct[DOM_CHILDREN], EMPTY);
        assert.equal(struct[DOM_META], NODE_ELEMENT);
    }
});

test('SELF_DYN marks refs, events, and signal props/attrs but not static values', () => {
    const staticStruct = genTagName('div', [
        genClass(['card', false, 'active']),
        genProp('style', { color: 'red' }),
        genAttr('hidden', false),
        genText('Hello'),
    ]);
    assert.equal(staticStruct[DOM_META] & META_FLAG_ANY_DYN, 0);

    for (const prop of [
        genRef(),
        genRef(0),
        genOn('click', () => {}),
        genProp('disabled', createStore(false)),
        genAttr('data-count', createStore(0)),
        genClass(createStore('active')),
        genText(createStore('Hello')),
    ]) {
        const meta = genTagName('div', [prop])[DOM_META];
        assert.equal(meta & META_FLAG_SELF_DYN, META_FLAG_SELF_DYN);
        assert.equal(meta & META_FLAG_SUBTREE_DYN, 0);
        assert.equal(meta & META_KIND_MASK, NODE_ELEMENT);
    }
});

test('SUBTREE_DYN propagates signal and dynamic descendant metadata', () => {
    const child = genTagName('span', [], ['Count: ', createStore(0)]);
    const parent = genTagName(
        'div',
        [],
        [genTagName('span', [], ['static']), child]
    );
    const grandparent = genTagName('div', [], [parent]);
    for (const struct of [child, parent, grandparent]) {
        assert.equal(struct[DOM_META], META_FLAG_SUBTREE_DYN);
    }

    const refChild = genTagName('span', [genRef(0)], ['static text']);
    assert.equal(
        genTagName('div', [], [refChild])[DOM_META],
        META_FLAG_SUBTREE_DYN
    );
    assert.equal(
        genTagName('div', [genOn('click', () => {})], [parent])[DOM_META],
        META_FLAG_SELF_DYN | META_FLAG_SUBTREE_DYN
    );
});

test('flow nodes use the shared kind bits and always mark their parent dynamic', () => {
    let renders = 0;
    const render = () => {
        renders++;
        return genTagName('span', [], ['branch']);
    };
    const flows = [
        domShow(createStore(false), genTagName('span')),
        domIf(createStore(false), render),
        domList(createStore<readonly number[]>([]), (item) => item, render),
    ];
    assert.deepEqual(
        flows.map((flow) => flow[DOM_META]),
        [1, 2, 3]
    );
    assert.deepEqual(
        [NODE_ELEMENT, FLOW_SHOW, FLOW_IF, FLOW_LIST, FLOW_ROUTER],
        [0, 1, 2, 3, 4]
    );
    for (const flow of flows) {
        assert.notEqual(flow[DOM_META] & META_KIND_MASK, NODE_ELEMENT);
        assert.equal(
            genTagName('div', [], [flow])[DOM_META],
            META_FLAG_SUBTREE_DYN
        );
    }
    assert.equal(renders, 0);
});

test('metadata construction does not evaluate signal getters', () => {
    let reads = 0;
    const sig = mapSignal((value: string) => {
        reads++;
        return value;
    }, createStore('value'));
    const struct = genTagName('div', [genAttr('data-value', sig)], [sig]);
    assert.equal(reads, 0);
    assert.equal(struct[DOM_META], META_FLAG_ANY_DYN);
});

test('ref metadata distinguishes unnamed refs and packs zero and maximum keys', () => {
    const unnamedMeta = genTagName('input', [genRef()])[DOM_META];
    assert.equal(unnamedMeta, META_FLAG_SELF_DYN | META_FLAG_HAS_REF);

    for (const key of [0, 1, META_REF_MAX]) {
        const meta = genTagName('div', [genRef(key)], [createStore('dynamic')])[
            DOM_META
        ];
        assert.equal(meta >> META_REF_SHIFT, key);
        assert.equal(meta & META_FLAG_HAS_REF, META_FLAG_HAS_REF);
        assert.equal(meta & META_FLAG_HAS_REF_KEY, META_FLAG_HAS_REF_KEY);
        assert.equal(meta & META_FLAG_ANY_DYN, META_FLAG_ANY_DYN);
        assert.equal(meta & META_KIND_MASK, NODE_ELEMENT);
        assert.ok(meta >= 0 && meta <= 0x3fffffff);
    }
});

test('genRef rejects keys that cannot fit in the 23-bit field', () => {
    for (const key of [
        -1,
        0.5,
        META_REF_MAX + 1,
        2 ** 32,
        NaN,
        Infinity,
        -Infinity,
    ]) {
        assert.throws(() => genRef(key), RangeError);
    }
});

test('last ref marker wins without leaving stale key bits', () => {
    const unnamed = genTagName('input', [genRef(META_REF_MAX), genRef()]);
    const zero = genTagName('input', [genRef(META_REF_MAX), genRef(0)]);
    assert.equal(unnamed[DOM_META], META_FLAG_SELF_DYN | META_FLAG_HAS_REF);
    assert.equal(
        zero[DOM_META],
        META_FLAG_SELF_DYN | META_FLAG_HAS_REF | META_FLAG_HAS_REF_KEY
    );

    const [ctx, root] = createMockCtx();
    const refs = domCreatorRef(ctx, root, [unnamed, zero]);
    assert.deepEqual(Object.keys(refs), ['0']);
});

test('domCreator collects every marked ref, including key zero, in fragments', () => {
    const [ctx, root] = createMockCtx();
    const refs = domCreator(ctx, root, [
        genTagName('input'),
        genTagName('input', [genRef(0)]),
        genTagName('input', [genRef()]),
        genTagName('input', [genRef(META_REF_MAX)]),
    ]);
    assert.equal(refs.length, 3);

    const inputs: HTMLInputElement[] = domCreator(
        ctx,
        root,
        genTagName('input', [genRef()])
    );
    assert.equal(inputs.length, 1);
    const named: Record<number, HTMLInputElement> = domCreatorRef(
        ctx,
        root,
        genTagName('input', [genRef(0)])
    );
    assert.equal(named[0].tagName, 'INPUT');
    const maxRefs = domCreatorRef(
        ctx,
        root,
        genTagName('input', [genRef(META_REF_MAX)])
    );
    assert.equal(maxRefs[META_REF_MAX].tagName, 'INPUT');
    assert.equal(
        domCreatorRef(ctx, root, genTagName('input', [genRef()]))[0],
        undefined
    );

    // Compile-time contracts: preserve tag inference and forbid void children/string refs.
    const tag: 'input' = genTagName('input')[DOM_TAG];
    assert.equal(tag, 'input');
    if (false) {
        // @ts-expect-error void tags do not accept children
        genTagName('input', [], ['invalid']);
        // @ts-expect-error packed ref keys must be numbers
        genRef('invalid');
        // @ts-expect-error input refs must not be inferred as button refs
        const buttons: HTMLButtonElement[] = inputs;
    }
});

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

test('genTagName binds direct text, signal children, and reactive props/attrs', () => {
    const [ctx, root] = createMockCtx();
    const statusSig = createStore('connecting');
    const isDisabledSig = createStore(true);
    const activeClassSig = createStore<string | false>(false);

    const scope: DomScope = [];
    const refs = domCreatorRef(
        ctx,
        root,
        genTagName(
            'div',
            [genClass(['chat-header', activeClassSig])],
            [
                'Status: ',
                genTagName('strong', [], [statusSig]),
                genTagName('input', [
                    genRef(REF_INPUT),
                    genAttr('type', 'text'),
                    genAttr('readonly', isDisabledSig),
                ]),
                genTagName(
                    'button',
                    [genRef(REF_BTN), genProp('disabled', isDisabledSig)],
                    ['Send']
                ),
            ]
        ),
        scope
    );

    const containerEl = root.childNodes[0] as HTMLElement;
    const btnEl = refs[REF_BTN] as unknown as HTMLButtonElement;
    const inputEl = refs[REF_INPUT] as unknown as HTMLInputElement;

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
        genTagName(
            'button',
            [genRef(), genOn('click', () => clicks++)],
            ['Click me']
        ),
        scope
    );

    btn.click();
    btn.click();
    assert.equal(clicks, 2);

    domDispose(scope);
    btn.click();
    assert.equal(clicks, 2);
});

test('raw prop entries bind styles, text, and nullable attributes with scoped cleanup', () => {
    const [ctx, root] = createMockCtx();
    const scope: DomScope = [];
    const styleSig = createStore<Partial<CSSStyleDeclaration>>({
        color: 'red',
    });
    const attrSig = createStore<string | boolean | null | undefined>('ready');
    const textSig = createStore(0);
    const [el] = domCreator(
        ctx,
        root,
        genTagName(
            'div',
            [
                genRef(),
                genProp('style', styleSig),
                genAttr('data-state', attrSig),
                genAttr('hidden', false),
            ],
            [textSig]
        ),
        scope
    );
    assert.equal(el.style.color, 'red');
    assert.equal(el.getAttribute('data-state'), 'ready');
    assert.equal(el.hasAttribute('hidden'), false);
    assert.equal(el.textContent, '0');

    styleSig[SIGNAL_SET]({ color: 'blue' });
    textSig[SIGNAL_SET](42);
    attrSig[SIGNAL_SET](true);
    assert.equal(el.style.color, 'blue');
    assert.equal(el.textContent, '42');
    assert.equal(el.getAttribute('data-state'), '');
    for (const absent of [false, null, undefined]) {
        attrSig[SIGNAL_SET](absent);
        assert.equal(el.hasAttribute('data-state'), false);
        attrSig[SIGNAL_SET]('present');
    }

    domDispose(scope);
    styleSig[SIGNAL_SET]({ color: 'green' });
    textSig[SIGNAL_SET](99);
    attrSig[SIGNAL_SET]('disposed');
    assert.equal(el.style.color, 'blue');
    assert.equal(el.textContent, '42');
    assert.equal(el.getAttribute('data-state'), 'present');
    assert.equal(scope.length, 0);
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
        genTagName(
            'div',
            [],
            [
                domShow(
                    visibleSig,
                    genTagName('span', [genRef(REF_BANNER), genText('Banner')])
                ),
                domIf(
                    loggedInSig,
                    () => genTagName('span', [], ['Welcome user']),
                    () => genTagName('span', [], ['Please log in'])
                ),
                genTagName(
                    'ul',
                    [genRef(REF_LIST)],
                    [
                        domList(
                            itemsSig,
                            (item) => item.id,
                            (item) => genTagName('li', [], [item.text])
                        ),
                    ]
                ),
            ]
        ),
        scope
    );

    const bannerEl = refs[REF_BANNER] as HTMLElement;
    const listEl = refs[REF_LIST] as HTMLElement;
    const containerEl = root.childNodes[0] as HTMLElement;

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
