import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    bindArg,
    combineSignals,
    createStore,
    mapSignal,
    off,
    on,
    SIGNAL_GET,
    SIGNAL_OBS,
    SIGNAL_SET,
    trigger,
} from './index';

test('mapSignal keeps its getter lazy and forwards the first equal mapped value', () => {
    const source = createStore(0);
    let reads = 0;
    const mapped = mapSignal((value: number) => {
        reads++;
        return value % 2;
    }, source);
    const received: number[] = [];
    mapped[SIGNAL_OBS](bindArg((value: number) => received.push(value), on));
    assert.equal(reads, 0);
    assert.equal(mapped[SIGNAL_SET], undefined);
    assert.equal(mapped[SIGNAL_GET](), 0);
    assert.equal(mapped[SIGNAL_GET](), 0);
    assert.equal(reads, 2);
    assert.deepEqual(received, []);

    source[SIGNAL_SET](2);
    assert.deepEqual(received, [0]);
    source[SIGNAL_SET](4);
    assert.deepEqual(received, [0]);
    source[SIGNAL_SET](3);
    source[SIGNAL_SET](5);
    assert.deepEqual(received, [0, 1]);
    assert.equal(reads, 6);
});

test('mapSignal deduplicates mapped values using Object.is', () => {
    const source = createStore(0);
    const mapped = mapSignal(
        (value: number) => (value < 3 ? NaN : value === 3 ? 0 : -0),
        source
    );
    const received: number[] = [];
    mapped[SIGNAL_OBS](bindArg((value: number) => received.push(value), on));
    for (const value of [1, 2, 3, 4, 5]) source[SIGNAL_SET](value);
    assert.deepEqual(received, [NaN, 0, -0]);
});

test('mapSignal supports chained mappings and observer unsubscription', () => {
    const source = createStore(0);
    const parity = mapSignal((value: number) => value % 2, source);
    const label = mapSignal((value: number) => `parity:${value}`, parity);
    const received: string[] = [];
    const listener = (value: string) => received.push(value);
    label[SIGNAL_OBS](bindArg(listener, on));
    source[SIGNAL_SET](2);
    source[SIGNAL_SET](4);
    source[SIGNAL_SET](3);
    assert.deepEqual(received, ['parity:0', 'parity:1']);
    label[SIGNAL_OBS](bindArg(listener, off));
    source[SIGNAL_SET](6);
    assert.deepEqual(received, ['parity:0', 'parity:1']);
    assert.equal(label[SIGNAL_GET](), 'parity:0');
});

test('mapSignal propagates mapper errors without corrupting later updates', () => {
    const source = createStore(0);
    const error = new Error('mapping failed');
    const mapped = mapSignal((value: number) => {
        if (value === 1) throw error;
        return value * 10;
    }, source);
    const received: number[] = [];
    mapped[SIGNAL_OBS](bindArg((value: number) => received.push(value), on));
    source[SIGNAL_SET](2);
    assert.throws(() => source[SIGNAL_SET](1), error);
    assert.throws(mapped[SIGNAL_GET], error);
    source[SIGNAL_SET](2);
    source[SIGNAL_SET](3);
    assert.deepEqual(received, [20, 30]);
});

test('combineSignals reads current values and emits fresh snapshots', () => {
    const numberSig = createStore(1);
    const textSig = createStore('one');
    const combined = combineSignals(numberSig, textSig);
    const received: unknown[] = [];
    combined[SIGNAL_OBS](bindArg((value: unknown) => received.push(value), on));
    assert.deepEqual(combined[SIGNAL_GET](), [1, 'one']);
    numberSig[SIGNAL_SET](2);
    textSig[SIGNAL_SET]('two');
    assert.deepEqual(received, [
        [2, 'one'],
        [2, 'two'],
    ]);
    assert.notEqual(received[0], received[1]);
    assert.deepEqual(combined[SIGNAL_GET](), [2, 'two']);
});

test('combineSignals preserves the emitted source value and reads other current values', () => {
    const numberSig = createStore(1);
    const textSig = createStore('one');
    const combined = combineSignals(numberSig, textSig);
    const received: unknown[] = [];
    combined[SIGNAL_OBS](bindArg((value: unknown) => received.push(value), on));
    numberSig[SIGNAL_OBS](bindArg(42, trigger));
    assert.deepEqual(received, [[42, 'one']]);
    assert.deepEqual(combined[SIGNAL_GET](), [1, 'one']);
});
