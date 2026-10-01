// Tasks gathered from events and sorted for planning (views/tasks/taskModel.ts).
//
//   node --test frontend/tests/taskModel.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers/load.mjs';

const m = await load('views/tasks/taskModel.ts');

const at = (day, h = 10) => { const [y, mo, d] = day.split('-').map(Number); return new Date(y, mo - 1, d, h).getTime(); };
const todo = (id, extra = {}) => ({ id, text: id, done: false, createdAt: 1, ...extra });
const event = (id, day, todos, extra = {}) => ({ id, title: id, date: at(day), todos, createdAt: 1, ...extra });

const TODAY = '2026-10-01';

test('a task is due on its own date, else the day its event starts', () => {
    const items = m.tasksOf([event('fair', '2026-10-03', [todo('a'), todo('b', { due: '2026-10-01' })])]);
    assert.deepEqual(items.map(i => [i.todo.id, i.dueDay]), [['a', '2026-10-03'], ['b', '2026-10-01']]);
});

test('overdue, today, each coming day and completed, in planning order', () => {
    const items = m.tasksOf([
        event('old', '2026-09-28', [todo('late'), todo('finished', { done: true })]),
        event('now', TODAY, [todo('low', { priority: 'low' }), todo('urgent', { priority: 'high' }), todo('timed', { dueTime: '09:00' })]),
        event('fri', '2026-10-03', [todo('pack')]),
        event('next', '2026-10-02', [todo('call')]),
    ]);
    const b = m.buildBoard(items, TODAY);
    assert.deepEqual(b.overdue.map(i => i.todo.id), ['late']);
    // Priority first, then time, then the rest.
    assert.deepEqual(b.today.map(i => i.todo.id), ['urgent', 'low', 'timed']);
    assert.deepEqual(b.upcoming.map(g => [g.day, g.tasks.map(i => i.todo.id)]), [['2026-10-02', ['call']], ['2026-10-03', ['pack']]]);
    assert.deepEqual(b.completed.map(i => i.todo.id), ['finished']);
});

test('the most recent overdue comes first', () => {
    const b = m.buildBoard(m.tasksOf([event('a', '2026-06-01', [todo('ancient')]), event('b', '2026-09-30', [todo('yesterday')])]), TODAY);
    assert.deepEqual(b.overdue.map(i => i.todo.id), ['yesterday', 'ancient']);
});

test('headings read like a planner, across month and year boundaries', () => {
    assert.equal(m.dayHeading(TODAY, TODAY).title, 'Today');
    assert.equal(m.dayHeading('2026-10-02', TODAY).title, 'Tomorrow');
    assert.equal(m.dayHeading('2026-09-30', TODAY).title, 'Yesterday');
    assert.equal(m.dayHeading('2026-10-03', TODAY).title, 'Saturday');
    assert.equal(m.addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(m.addDays('2026-03-01', -1), '2026-02-28');
    assert.match(m.dayHeading('2027-01-15', '2026-12-30').detail, /2027/);
    assert.doesNotMatch(m.shortDay('2026-09-30', TODAY), /2026/);
});

test('a new task can go to any event running that day, multi-day ones included', () => {
    const events = [
        event('show', '2026-09-20', [], { endDate: at('2026-10-10') }),
        event('visit', TODAY, []),
        event('later', '2026-10-05', []),
    ];
    assert.deepEqual(m.eventsOnDay(events, TODAY).map(e => e.id), ['show', 'visit']);
});
