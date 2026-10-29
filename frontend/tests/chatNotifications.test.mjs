// Which chat notifications a device clears: those whose message I have read (hooks/useInbox.tsx).
//
//   node --test frontend/tests/chatNotifications.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers/load.mjs';

const { chatNotificationRead } = await load('hooks/useInbox.tsx');

test('a chat notification goes once its message is read by me, and only then', () => {
    const messages = [
        { id: 'm1', conversationId: 'c1', senderId: 'staff', readBy: { admin: 1 } },
        { id: 'm2', conversationId: 'c1', senderId: 'staff', readBy: { other: 1 } },
        { id: 'm3', conversationId: 'c2', senderId: 'staff', status: 'read' },
    ];
    assert.equal(chatNotificationRead('conv-c1', { messageId: 'm1' }, messages, 'admin'), true);
    assert.equal(chatNotificationRead('conv-c1', { messageId: 'm2' }, messages, 'admin'), false);
    assert.equal(chatNotificationRead('conv-c2', { messageId: 'm3' }, messages, 'admin'), true);
    // Not synced yet, from before message ids were sent, or not a chat: stays.
    assert.equal(chatNotificationRead('conv-c1', { messageId: 'm9' }, messages, 'admin'), false);
    assert.equal(chatNotificationRead('conv-c1', {}, messages, 'admin'), false);
    assert.equal(chatNotificationRead('inquiry-i1', { messageId: 'm1' }, messages, 'admin'), false);
});
