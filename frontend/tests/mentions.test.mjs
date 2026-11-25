// @mentions in chats: spotting the name being typed and highlighting tagged names.
//
//   node --test frontend/tests/mentions.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers/load.mjs';

const { mentionQueryAt, withMentions } = await load('views/chat/mentions.tsx');

test('finds the @query just before the caret', () => {
    assert.equal(mentionQueryAt('hi @gul', 7), 'gul');
    assert.equal(mentionQueryAt('@', 1), '');
    assert.equal(mentionQueryAt('mail a@b.com', 12), null); // an email isn't a mention
    assert.equal(mentionQueryAt('@gul done', 9), null);
});

test('highlights full names, longest first, and leaves other text alone', () => {
    const parts = withMentions('hey @Gulshan Prajapati and @Gul.', ['Gul', 'Gulshan Prajapati']);
    const marked = parts.filter(p => typeof p !== 'string').map(p => p.props.children);
    assert.deepEqual(marked, ['@Gulshan Prajapati', '@Gul']);
    assert.equal(withMentions('no tags', ['Gul']), 'no tags');
    assert.deepEqual(withMentions('see @a.b', ['a+b']), ['see @a.b']); // names are matched literally, not as patterns
});
