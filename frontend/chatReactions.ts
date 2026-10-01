// Reactions on chat messages, shared by the app and the server: the quick
// row shown when a message is held, the fuller picker behind "+", and the
// check the server makes before storing one.

/** The row that opens when a message is held (WhatsApp's six). */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

/** Behind the "+" in that row. */
export const MORE_REACTIONS = [
    '🔥', '🎉', '👏', '😍', '🤩', '😊', '😁', '😅', '🙂', '😎',
    '🥳', '🤔', '😬', '😴', '🙌', '🤝', '💪', '👌', '✅', '💯',
    '✨', '⭐', '🌸', '🎨', '🖼️', '💰', '📦', '❗', '❓', '👀',
] as const;

const ALLOWED = new Set<string>([...QUICK_REACTIONS, ...MORE_REACTIONS]);

/** One of the offered emoji, and nothing else. */
export function isReactionEmoji(value: unknown): value is string {
    return typeof value === 'string' && ALLOWED.has(value);
}
