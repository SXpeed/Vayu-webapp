// Which data an organization works on in the app, and bringing the original
// app's people in (platform/originalApp.ts). Every action is checked on the
// server; this is the control centre's view of it.

import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { Database, Users } from 'lucide-react';
import { Button } from '../components/ui';
import { Section, StatusPill, useDialogs } from './kit';
import { api, guarded as sharedGuarded, type Reauth } from './api';

interface PeopleReport {
    mode: 'dry_run' | 'run';
    found: number; accountsCreated: number; accountsMatched: number; membershipsAdded: number; alreadyMembers: number;
    people: { email: string; outcome: string }[];
    warnings: string[];
}

const guarded = <T,>(reauth: Reauth, fn: () => Promise<T>) => sharedGuarded(reauth, fn, (m) => toast.error(m));
const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });

export const AppDataCard: React.FC<{
    org: { id: string; slug: string; name: string; app_storage?: 'own' | 'original' };
    reauth: Reauth;
    onChanged: () => void;
}> = ({ org, reauth, onChanged }) => {
    const dialogs = useDialogs();
    const [busy, setBusy] = useState(false);
    const original = org.app_storage === 'original';

    const switchData = async () => {
        const to = original ? 'own' : 'original';
        const typed = await dialogs.prompt(to === 'original'
            ? {
                title: `Give ${org.name} the original app's data?`,
                body: 'Its people will see and work on the original app\'s inventory, clients, messages and files (the data staff used before organizations). Its own data stays stored but is not shown while this is on. Only one organization can have the original data.',
                label: `Type ${org.slug} to confirm`, minLength: 1, confirmLabel: 'Use the original data', danger: true,
            }
            : {
                title: `Stop ${org.name} using the original data?`,
                body: 'Its people will work on its own data again. The original data is not changed or deleted.',
                label: `Type ${org.slug} to confirm`, minLength: 1, confirmLabel: 'Use its own data', danger: true,
            });
        if (!typed) return;
        setBusy(true);
        const done = await guarded(reauth, () => api(`/admin/orgs/${org.id}/app-storage`, post({ storage: to, confirm: typed.trim() })));
        setBusy(false);
        if (done) { toast.success(to === 'original' ? 'Now using the original app\'s data' : 'Now using its own data'); onChanged(); }
    };

    const bringPeople = async () => {
        setBusy(true);
        const preview = await guarded(reauth, () => api<PeopleReport>(`/admin/orgs/${org.id}/import-original-people`, post({})));
        setBusy(false);
        if (!preview) return;
        const lines = [
            `${preview.found} ${preview.found === 1 ? 'person' : 'people'} in the original app.`,
            `${preview.membershipsAdded} will join ${org.name}; ${preview.alreadyMembers} already have.`,
            `${preview.accountsCreated} get an account with the password they use today; ${preview.accountsMatched} already have one and keep it.`,
            ...preview.warnings,
        ];
        const body = <ul className="space-y-1.5 list-disc pl-4">{lines.map(line => <li key={line}>{line}</li>)}</ul>;
        if (!(await dialogs.confirm({ title: 'Bring them in?', body, confirmLabel: 'Bring them in' }))) return;
        setBusy(true);
        const done = await guarded(reauth, () => api<PeopleReport>(`/admin/orgs/${org.id}/import-original-people`, post({ dryRun: false })));
        setBusy(false);
        if (done) { toast.success(`${done.membershipsAdded} joined`); onChanged(); }
    };

    return (
        <Section title="App data" actions={<Database size={16} className="ac-faint" />}
            description={original
                ? 'Works on the original app\'s data: the inventory, clients, messages and files staff used before organizations.'
                : 'Works on its own data, separate from every other organization.'}>
            <div className="flex flex-wrap items-center gap-2">
                <StatusPill tone={original ? 'info' : 'neutral'}>{original ? 'Original app data' : 'Its own data'}</StatusPill>
                <span className="flex-1" />
                {original && (
                    <Button variant="primary" onClick={bringPeople} disabled={busy}>
                        <Users size={14} className="inline -mt-0.5 mr-1.5" />Bring in the original app's people
                    </Button>
                )}
                <Button onClick={switchData} disabled={busy}>{original ? 'Use its own data…' : 'Use the original app\'s data…'}</Button>
            </div>
            {original && (
                <p className="mt-3 text-[12px] ac-muted">
                    They sign in to the app with the email and password they use today. Anyone who already has an account keeps it, and keeps everything they wrote.
                </p>
            )}
        </Section>
    );
};
