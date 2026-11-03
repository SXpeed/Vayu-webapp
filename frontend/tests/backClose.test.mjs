// Phone Back and overlays: each open overlay owns one Back step, closing it
// another way removes the step, and a step left behind is reused.
//
//   node --test frontend/tests/backClose.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers/load.mjs';

const { takeStep, releaseStep } = await load('hooks/useBackClose.ts');

/** Just enough of window.history: a stack of states and a position in it. */
function fakeHistory(state) {
    const entries = [state];
    let at = 0;
    return {
        get state() { return entries[at]; },
        get length() { return entries.length; },
        pushState(s) { entries.splice(at + 1); entries.push(s); at++; },
        back() { if (at > 0) at--; },
    };
}

test('opening an overlay adds one step that keeps the screen state', () => {
    const h = fakeHistory({ view: 'invoice' });
    const depth = takeStep(h);
    assert.equal(depth, 1);
    assert.deepEqual(h.state, { view: 'invoice', overlay: 1 });
    releaseStep(h, depth); // not released yet: still owned
    assert.equal(h.length, 2);
});

test('an overlay over an overlay gets the next step', () => {
    const h = fakeHistory({ view: 'invoice' });
    takeStep(h);
    assert.equal(takeStep(h), 2);
    assert.equal(h.state.overlay, 2);
});

test('a step left behind by a closed overlay is reused, not stacked', () => {
    // An earlier overlay's step whose owner is gone (the screen was left with it open).
    const h = fakeHistory({ view: 'invoice', overlay: 41 });
    assert.equal(takeStep(h), 41);
    assert.equal(h.length, 1);
});

test('no step is added without a recent tap (Chrome would skip a screen on Back)', () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: { userActivation: { isActive: false } }, configurable: true });
    try {
        const h = fakeHistory({ view: 'invoice' });
        assert.equal(takeStep(h), 0);
        assert.equal(h.length, 1);
        // A step left behind can still be reused: that adds nothing.
        const h2 = fakeHistory({ view: 'invoice', overlay: 77 });
        assert.equal(takeStep(h2), 77);
    } finally {
        if (real) Object.defineProperty(globalThis, 'navigator', real);
    }
});

// Ownership is shared across these tests (one module), so each uses depths no other test took.
test('closing an overlay with its own button takes its step off; others stay', () => {
    const take = takeStep, release = releaseStep;
    // Closed, unowned, on top: Back goes to the screen underneath.
    const h = fakeHistory({ view: 'home' });
    h.pushState({ view: 'home', overlay: 3 });
    release(h, 3);
    assert.deepEqual(h.state, { view: 'home' });
    // Still owned (another overlay took the step over): it stays.
    const h1 = fakeHistory({ view: 'home' });
    const d = take(h1);
    release(h1, d);
    assert.equal(h1.state.overlay, d);
    // Not on top any more (Back already went past it): nothing to take off.
    const h2 = fakeHistory({ view: 'home', overlay: 7 });
    release(h2, 9);
    assert.equal(h2.state.overlay, 7);
});
