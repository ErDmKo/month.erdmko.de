import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { domDispose } from '@month/utils';
import { createTestWindow } from '../test-window';
import { render } from './game';

test('month game updates timer, buttons, header, and final report via signals', () => {
    let rafCallback = null as ((stamp: number) => void) | null;
    let timeoutCallback = null as (() => void) | null;

    const ctx = createTestWindow({
        overrides: {
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
        },
    });
    const root = ctx.document.createElement('div');

    const monthNames: Record<string, string> = {
        1: 'Январь',
        5: 'Май',
    };

    const scope = render(ctx, monthNames, root);

    assert.equal(root.textContent!.includes('Май'), true);
    assert.equal(root.textContent!.includes('30000 ms'), true);

    // Tick animation frame at +500ms -> 29500 ms remaining
    assert.ok(rafCallback);
    (rafCallback as (stamp: number) => void)(1500);
    assert.equal(root.textContent!.includes('29500 ms'), true);

    const buttons = Array.from(root.querySelectorAll('button'));
    assert.equal(buttons.length, 12);

    // Click wrong month (#1) -> turns red
    buttons[0].click();
    assert.equal(buttons[0].style.backgroundColor, 'red');

    // Click right month (#5) -> turns green, header shows 'Правильно!'
    buttons[4].click();
    assert.equal(buttons[4].style.backgroundColor, 'green');
    assert.equal(root.textContent!.includes('Правильно!'), true);

    // Trigger next question timeout -> resets button colors
    assert.ok(timeoutCallback);
    (timeoutCallback as () => void)();
    assert.equal(buttons[0].style.backgroundColor, '');
    assert.equal(buttons[4].style.backgroundColor, '');

    // Tick animation frame past 30s -> switches to report screen via domIf
    (rafCallback as (stamp: number) => void)(32000);
    assert.equal(root.textContent!.includes('Время вышло!'), true);
    assert.equal(root.textContent!.includes('Ошибки: 1'), true);
    assert.equal(root.textContent!.includes('Верные ответы: 1'), true);
    assert.equal(root.textContent!.includes('Всего вопросов: 2'), true);

    domDispose(scope);
});
