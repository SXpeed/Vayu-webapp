import React from 'react';

/** @mentions in chats, kept apart from MessageParts so tests can load them without its UI imports. */

/** The `@query` being typed just before the caret, or null when not mentioning. */
export const mentionQueryAt = (text: string, caret: number): string | null =>
    /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret))?.[1] ?? null;

/** Message text with each `@Name` of a chat member highlighted. Longest names first, so "@Gulshan P" beats "@Gulshan". */
export function withMentions(text: string, names: string[]): React.ReactNode {
    if (!text.includes('@') || names.length === 0) return text;
    const alternatives = [...new Set(names)].filter(Boolean).sort((a, b) => b.length - a.length)
        .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`));
    if (alternatives.length === 0) return text;
    return text.split(new RegExp(`(@(?:${alternatives.join('|')}))`, 'g')).map((part, i) =>
        i % 2 ? <span key={i} /* NOSONAR: pieces of one fixed string, in order; nothing reorders them */ className="font-semibold text-gold-700 dark:text-gold-300">{part}</span> : part);
}
