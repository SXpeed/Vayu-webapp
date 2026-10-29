import React, { useId, useMemo, useState } from 'react';
import { User } from 'lucide-react';
import type { Contact } from '../types';
import { searchContacts } from '../contactSearch';

/** What the wrapped input needs to become a combobox over the suggestions. */
export type ContactSuggestInputProps = Pick<React.InputHTMLAttributes<HTMLInputElement>,
    'role' | 'aria-autocomplete' | 'aria-expanded' | 'aria-controls' | 'aria-activedescendant' | 'autoComplete' | 'onFocus' | 'onBlur' | 'onInput' | 'onKeyDown'>;

/**
 * Saved contacts under a customer's name, phone or email field: on focus the
 * most recent ones, then whatever matches what is typed. Picking one hands it
 * to `onPick`, which fills the form. The field itself is rendered by the
 * caller (`children`), so it keeps its own look; the list floats over the
 * form and moves nothing. With no saved contacts it is just the field.
 */
export const ContactSuggest: React.FC<{
    contacts: readonly Contact[];
    /** The field's current text. */
    query: string;
    onPick: (contact: Contact) => void;
    children: (inputProps: ContactSuggestInputProps) => React.ReactNode;
}> = ({ contacts, query, onPick, children }) => {
    const id = useId();
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const matches = useMemo(() => (open ? searchContacts(contacts, query) : []), [open, contacts, query]);
    const shown = open && matches.length > 0;

    if (!contacts.length) return <>{children({})}</>;

    const pick = (c: Contact) => {
        onPick(c);
        setOpen(false);
    };
    const reopen = () => { setOpen(true); setActive(0); };

    return (
        <div className="relative">
            {children({
                role: 'combobox',
                'aria-autocomplete': 'list',
                'aria-expanded': shown,
                'aria-controls': `${id}-list`,
                'aria-activedescendant': shown ? `${id}-${active}` : undefined,
                autoComplete: 'off',
                onFocus: reopen,
                onBlur: () => setOpen(false),
                // Typing reopens the list after a pick or Escape; filling in from a pick doesn't.
                onInput: reopen,
                onKeyDown: e => {
                    if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        if (shown) setActive(i => Math.min(i + 1, matches.length - 1));
                        else reopen();
                    } else if (e.key === 'ArrowUp' && shown) {
                        e.preventDefault();
                        setActive(i => Math.max(i - 1, 0));
                    } else if (e.key === 'Enter' && shown) {
                        e.preventDefault();
                        pick(matches[active]);
                    } else if (e.key === 'Escape' && shown) {
                        // Close the list, not the sheet the form is in.
                        e.preventDefault();
                        e.stopPropagation();
                        setOpen(false);
                    }
                },
            })}
            {shown && (
                <ul
                    id={`${id}-list`}
                    role="listbox"
                    aria-label="Saved contacts"
                    className="absolute left-0 right-0 top-full mt-1.5 z-[90] max-h-64 overflow-y-auto overscroll-contain rounded-2xl neu-raised p-1.5 animate-fade-in"
                >
                    {matches.map((c, i) => (
                        <li
                            key={c.id}
                            id={`${id}-${i}`}
                            role="option"
                            aria-selected={i === active}
                            // Keep focus in the field so the pick lands before blur closes the list.
                            onMouseDown={e => e.preventDefault()}
                            onClick={() => pick(c)}
                            onMouseEnter={() => setActive(i)}
                            className={`flex items-center gap-2.5 px-3 py-2 rounded-xl cursor-pointer ${i === active ? 'neu-inset' : ''}`}
                        >
                            <User size={14} className="shrink-0 text-gold-600 dark:text-gold-400" />
                            <span className="min-w-0 flex-1">
                                <span className="block truncate text-[13px] text-[var(--neu-text)]">{c.name || c.phone || c.email}</span>
                                <span className="block truncate text-[11px] text-[var(--neu-text-dim)]">{[c.phone, c.email].filter(Boolean).join(' · ') || 'No phone or email'}</span>
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};
