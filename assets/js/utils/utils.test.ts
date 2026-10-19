import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    bindArg,
    bindArgs,
    pipe,
    observer,
    on,
    off,
    trigger,
    createStore,
    combineLatestWith,
    taskOf,
    taskMap,
    taskChain,
    taskFork,
    DOM_TAG,
    DOM_PROPS,
    DOM_ATTRS,
    DOM_REF,
    DOM_CHILDREN,
    genTagDiv,
    genTagName,
    genText,
    genClass,
    genAttr,
    genProp,
    genRef,
    domCreator,
    domCreatorRef,
    cleanHtml,
} from './index';
import type { Task, TupleOf, ReadonlyTupleOf } from './index';

const PAIR_FIRST = 0 as const;
const PAIR_SECOND = 1 as const;
const STORE_GET = 0 as const;
const STORE_SET = 1 as const;
const STORE_OBS = 2 as const;

interface MockElement {
    tagName: string;
    style: Record<string, unknown>;
    attrs: Record<string, string>;
    children: MockElement[];
    firstChild: MockElement | null;
    innerText?: string;
    setAttribute(key: string, val: string): void;
    appendChild(child: MockElement): void;
    removeChild(child: MockElement): void;
}

const createMockElement = (tag: string): MockElement => {
    const children: MockElement[] = [];
    const el: MockElement = {
        tagName: tag.toUpperCase(),
        style: {},
        attrs: {},
        children,
        get firstChild() {
            return children.length > 0 ? children[0] : null;
        },
        setAttribute(key: string, val: string) {
            el.attrs[key] = val;
        },
        appendChild(child: MockElement) {
            children.push(child);
        },
        removeChild(child: MockElement) {
            const idx = children.indexOf(child);
            if (idx !== -1) children.splice(idx, 1);
        },
    };
    return el;
};

const createMockCtx = (): Window =>
    ({
        document: {
            createElement: (tag: string) => createMockElement(tag),
        },
    }) as unknown as Window;

test('bindArg and bindArgs partially apply arguments in order', () => {
    const add3 = (a: number, b: number, c: number) => a * 100 + b * 10 + c;
    const withOne = bindArg(1, add3);
    assert.equal(withOne(2, 3), 123);

    const withTwo = bindArgs([1, 2], add3);
    assert.equal(withTwo(3), 123);
});

test('pipe composes functions left-to-right', () => {
    const result = pipe(
        5,
        (x: number) => x + 3,
        (x: number) => x * 2,
        (x: number) => `val:${x}`
    );
    assert.equal(result, 'val:16');
});

test('observer on / trigger / off lifecycle', () => {
    const obs = observer<number>();
    const received: number[] = [];
    const listener = (n: number) => received.push(n);

    obs(bindArg(listener, on));
    obs(bindArg(10, trigger));
    obs(bindArg(20, trigger));
    assert.deepEqual(received, [10, 20]);

    obs((state) => off(listener, state));
    obs(bindArg(30, trigger));
    assert.deepEqual(received, [10, 20]);
});

test('createStore and combineLatestWith emit updated state tuples', () => {
    const store = createStore<string>('init');
    const getState = store[STORE_GET];
    const setState = store[STORE_SET];
    const storeObs = store[STORE_OBS];

    assert.equal(getState(), 'init');

    const numObs = observer<number>();
    const combined = combineLatestWith(storeObs, numObs);
    const pairs: [string, number][] = [];
    combined(bindArg((pair: [string, number]) => pairs.push(pair), on));

    setState('ready');
    numObs(bindArg(42, trigger));

    assert.equal(getState(), 'ready');
    assert.equal(pairs.length, 2);
    assert.equal(pairs[1][PAIR_FIRST], 'ready');
    assert.equal(pairs[1][PAIR_SECOND], 42);
});

test('Task pipeline: taskOf, taskMap, taskChain, taskFork', () => {
    let resolvedValue = 0;
    const asyncAdd =
        (delta: number) =>
        (x: number): Task<number> =>
        (resolve) => {
            resolve(x + delta);
        };

    pipe(
        taskOf((a: number, b: number) => a + b)(3, 4),
        taskMap((n: number) => n * 2),
        taskChain(asyncAdd(6)),
        taskFork((val: number) => {
            resolvedValue = val;
        })
    );

    assert.equal(resolvedValue, 20);
});

test('Task pipeline: synchronous throw in taskMap routes to reject and skips downstream', () => {
    let downstreamCalled = false;
    let rejectedReason: unknown = null;

    pipe(
        taskOf(() => 10)(),
        taskMap((): number => {
            throw new Error('boom');
        }),
        taskMap((n: number) => {
            downstreamCalled = true;
            return n + 1;
        }),
        taskFork(
            () => {
                downstreamCalled = true;
            },
            (err) => {
                rejectedReason = err;
            }
        )
    );

    assert.equal(downstreamCalled, false);
    assert.ok(rejectedReason instanceof Error);
    assert.equal((rejectedReason as Error).message, 'boom');
});

test('DOMStruct tuple indices and domCreatorRef / cleanHtml', () => {
    const REF_HEADER = 0 as const;
    const REF_BTN = 1 as const;

    const struct = genTagDiv(
        [genClass('card'), genAttr('data-id', 7)],
        [
            genTagName('h2', [genRef(REF_HEADER), genText('Title')]),
            genTagName('button', [
                genRef(REF_BTN),
                genProp('style', { color: 'red' }),
                genText('Go'),
            ]),
        ]
    );

    assert.equal(struct[DOM_TAG], 'div');
    assert.equal(struct[DOM_ATTRS].class, 'card');
    assert.equal(struct[DOM_ATTRS]['data-id'], 7);
    assert.equal(struct[DOM_REF], false);
    assert.equal(struct[DOM_CHILDREN]?.length, 2);

    const ctx = createMockCtx();
    const root = createMockElement('div') as unknown as HTMLElement;
    const refs = domCreatorRef(ctx, root, struct) as unknown as Record<
        number,
        MockElement
    >;

    assert.equal(refs[REF_HEADER].tagName, 'H2');
    assert.equal(refs[REF_HEADER].innerText, 'Title');
    assert.equal(refs[REF_BTN].tagName, 'BUTTON');
    assert.equal(refs[REF_BTN].style.color, 'red');

    const plainRefs = domCreator(
        ctx,
        root,
        genTagName('span', [genRef(), genText('plain')])
    );
    assert.equal(plainRefs.length, 1);

    cleanHtml(root);
    assert.equal((root as unknown as MockElement).children.length, 0);
});

test('TupleOf and ReadonlyTupleOf bind index constants to tuple slots and reject gaps', () => {
    const USER_ID = 0 as const;
    const USER_NAME = 1 as const;
    const USER_ACTIVE = 2 as const;

    type UserTuple = TupleOf<{
        [USER_ID]: number;
        [USER_NAME]: string;
        [USER_ACTIVE]: boolean;
    }>;

    type ReadonlyUserTuple = ReadonlyTupleOf<{
        [USER_ID]: number;
        [USER_NAME]: string;
        [USER_ACTIVE]: boolean;
    }>;

    const mutableUser: UserTuple = [1, 'alice', true];
    mutableUser[USER_NAME] = 'bob';
    assert.equal(mutableUser[USER_ID], 1);
    assert.equal(mutableUser[USER_NAME], 'bob');
    assert.equal(mutableUser[USER_ACTIVE], true);

    const frozenUser: ReadonlyUserTuple = [2, 'carol', false];
    assert.equal(frozenUser[USER_NAME], 'carol');

    // Compile-time check: skipping index 1 (0 -> 2) is rejected by TupleOf
    const BAD_FIRST = 0 as const;
    const BAD_SKIPPED = 2 as const;
    // @ts-expect-error index 1 is missing so index 2 is forced to `never`
    type InvalidSkippedTuple = TupleOf<{
        [BAD_FIRST]: string;
        [BAD_SKIPPED]: number;
    }>;
    const _unused: InvalidSkippedTuple | null = null;
    assert.equal(_unused, null);
});
