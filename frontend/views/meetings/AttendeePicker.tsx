// Who was in the meeting, picked from the team. The AI uses the names to
// say who said and owns what; sharing by email goes to them.
import React, { useState } from 'react';
import { Users } from 'lucide-react';
import { Pill } from '../../components/ui';
import type { Attendee } from '../../meetingRules';

export interface Member { id: string; name: string; email?: string }

export const AttendeePicker: React.FC<{ team: Member[]; value: Attendee[]; onChange: (a: Attendee[]) => void }> = ({ team, value, onChange }) => {
    const [open, setOpen] = useState(false);
    const chosen = new Set(value.map(a => a.id));
    const toggle = (m: Member) => onChange(chosen.has(m.id) ? value.filter(a => a.id !== m.id) : [...value, { id: m.id, name: m.name }]);
    const summary = value.length ? value.map(a => a.name).join(', ') : 'No one picked yet';
    return (
        <fieldset>
            <legend className="mb-2 text-[13px] font-medium">People in the meeting</legend>
            <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
                className="w-full flex items-center gap-2 rounded-xl neu-inset px-3 py-2.5 text-left text-[13px] active-scale">
                <Users size={15} className="shrink-0 text-[var(--neu-text-dim)]" />
                <span className="flex-1 min-w-0 truncate">{summary}</span>
                <span className="text-[12px] text-gold-700 dark:text-gold-400">{open ? 'Done' : 'Choose'}</span>
            </button>
            {open && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                    {team.map(m => <Pill key={m.id} active={chosen.has(m.id)} onClick={() => toggle(m)}>{m.name}</Pill>)}
                    {team.length === 0 && <p className="text-[12px] text-[var(--neu-text-dim)]">No team members to pick from.</p>}
                </div>
            )}
        </fieldset>
    );
};
