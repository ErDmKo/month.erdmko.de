import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { domDispose } from '@month/utils';
import { render } from './game';

class MockTextNode {
    nodeType = 3;
    data: string;
    parentNode: MockElement | null = null;
    constructor(data: string) {
        this.data = data;
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
    childNodes: (MockElement | MockTextNode)[] = [];
    parentNode: MockElement | null = null;
    listeners = new Map<string, Set<Function>>();
    innerText = '';

    constructor(tag: string) {
        this.tagName = tag.toUpperCase();
    }

    setAttribute(key: string, val: string) {
        this.attributes.set(key, val);
    }

    removeAttribute(key: string) {
        this.attributes.delete(key);
    }

    appendChild(node: MockElement | MockTextNode) {
        if (node.parentNode) node.parentNode.removeChild(node);
        node.parentNode = this;
        this.childNodes.push(node);
        return node;
    }

    insertBefore(
        node: MockElement | MockTextNode,
        refNode: MockElement | MockTextNode | null
    ) {
        if (!refNode) return this.appendChild(node);
        if (node.parentNode) node.parentNode.removeChild(node);
        const idx = this.childNodes.indexOf(refNode);
        if (idx === -1) return this.appendChild(node);
        node.parentNode = this;
        this.childNodes.splice(idx, 0, node);
        return node;
    }

    removeChild(node: MockElement | MockTextNode) {
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

    click() {
        const set = this.listeners.get('click');
        if (set) {
            for (const fn of [...set]) fn({});
        }
    }

    get textContent(): string {
        if (this.innerText) return this.innerText;
        return this.childNodes.map((c) => c.textContent).join('');
    }
}

const findAllByTag = (root: MockElement, tag: string): MockElement[] => {
    const out: MockElement[] = [];
    for (const child of root.childNodes) {
        if (child instanceof MockElement) {
            if (child.tagName === tag.toUpperCase()) out.push(child);
            out.push(...findAllByTag(child, tag));
        }
    }
    return out;
};

test('month game updates timer, buttons, header, and final report via signals', () => {
    let rafCallback = null as ((stamp: number) => void) | null;
    let timeoutCallback = null as (() => void) | null;

    const root = new MockElement('div');
    const ctx = {
        Math: {
            ...Math,
            // Always pick month #5 (May) first
            random: () => (5 - 1) / 11,
        },
        performance: {
            now: () => 1000,
        },
        requestAnimationFrame: (cb: (stamp: number) => void) => {
            rafCallback = cb;
            return 1;
        },
        cancelAnimationFrame: () => {},
        setTimeout: (cb: () => void) => {
            timeoutCallback = cb;
            return 2;
        },
        clearTimeout: () => {},
        document: {
            createElement: (tag: string) => new MockElement(tag),
            createTextNode: (text: string) => new MockTextNode(text),
        },
    } as unknown as Window;

    const monthNames: Record<string, string> = {
        1: 'Январь',
        5: 'Май',
    };

    const scope = render(ctx, monthNames, root as unknown as HTMLElement);

    assert.equal(root.textContent.includes('Май'), true);
    assert.equal(root.textContent.includes('30000 ms'), true);

    // Tick animation frame at +500ms -> 29500 ms remaining
    assert.ok(rafCallback);
    (rafCallback as (stamp: number) => void)(1500);
    assert.equal(root.textContent.includes('29500 ms'), true);

    const buttons = findAllByTag(root, 'button');
    assert.equal(buttons.length, 12);

    // Click wrong month (#1) -> turns red
    buttons[0].click();
    assert.equal(buttons[0].style.backgroundColor, 'red');

    // Click right month (#5) -> turns green, header shows 'Правильно!'
    buttons[4].click();
    assert.equal(buttons[4].style.backgroundColor, 'green');
    assert.equal(root.textContent.includes('Правильно!'), true);

    // Trigger next question timeout -> resets button colors
    assert.ok(timeoutCallback);
    (timeoutCallback as () => void)();
    assert.equal(buttons[0].style.backgroundColor, '');
    assert.equal(buttons[4].style.backgroundColor, '');

    // Tick animation frame past 30s -> switches to report screen via domIf
    (rafCallback as (stamp: number) => void)(32000);
    assert.equal(root.textContent.includes('Время вышло!'), true);
    assert.equal(root.textContent.includes('Ошибки: 1'), true);
    assert.equal(root.textContent.includes('Верные ответы: 1'), true);
    assert.equal(root.textContent.includes('Всего вопросов: 2'), true);

    domDispose(scope);
});
