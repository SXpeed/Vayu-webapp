// Planning a week quickly: copy last week's plan, or import a spreadsheet
// (the same columns the export writes). Both check every row the way the
// server will, skip what is already there, and save in batches.

import React, { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { CopyPlus, FileUp, Loader2 } from 'lucide-react';
import { Button } from '../../components/ui';
import { addDays, leaveOn, type StaffShift } from '../../staffRosterRules';
import { staffRosterService, type ShiftInput, type StaffRosterData } from '../../services/staffRosterService';
import { dayLabel, rangeLabel } from './shared';
import { Drawer, Msg } from './Panels';
import { addable, readImport } from './planRules';

/** The server takes at most this many shifts in one save (staffRoster.ts). */
const BATCH = 100;
/** The longest span the roster loads at once (staffRoster.ts MAX_RANGE_DAYS). */
const MAX_SPAN_DAYS = 62;

/** Saves in batches the server accepts. Returns how many were saved. */
async function saveAll(list: ShiftInput[], onProgress: (n: number) => void): Promise<number> {
    let saved = 0;
    for (let i = 0; i < list.length; i += BATCH) {
        await staffRosterService.createShifts(list.slice(i, i + BATCH));
        saved += Math.min(BATCH, list.length - i);
        onProgress(saved);
    }
    return saved;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const strip = ({ id: _id, ...rest }: StaffShift): ShiftInput => rest;

/* ─────────────────────────── Copy last week ─────────────────────────── */

export const CopyWeekPanel: React.FC<{ data: StaffRosterData; weekStart: string; onClose: () => void; onDone: () => void }> = ({ data, weekStart, onClose, onDone }) => {
    const from = addDays(weekStart, -7);
    const [source, setSource] = useState<StaffRosterData | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState(0);

    useEffect(() => {
        staffRosterService.load(from, addDays(from, 6)).then(setSource).catch(e => setProblem((e as Error).message || 'Could not load last week'));
    }, [from]);

    const plan = useMemo(() => {
        if (!source) return null;
        const team = new Set(data.people.map(p => p.id));
        let leftTeam = 0, toOpen = 0;
        const inputs: ShiftInput[] = [];
        for (const s of source.shifts.filter(x => x.date >= from && x.date <= addDays(from, 6))) {
            const moved: ShiftInput = { ...strip(s), date: addDays(s.date, 7) };
            if (moved.employeeId && !team.has(moved.employeeId)) {
                if (moved.kind === 'off') { leftTeam++; continue; }
                moved.employeeId = null; toOpen++; leftTeam++;
            } else if (moved.employeeId && moved.kind === 'shift' && leaveOn(data.leaves, moved.employeeId, moved.date)) {
                // On approved leave this week: the shift still needs someone.
                moved.employeeId = null; toOpen++;
            } else if (moved.kind === 'off' && moved.employeeId && leaveOn(data.leaves, moved.employeeId, moved.date)) {
                continue;
            }
            inputs.push(moved);
        }
        const thisWeek = data.shifts.filter(x => x.date >= weekStart && x.date <= addDays(weekStart, 6)).map(strip);
        return { ...addable(inputs, thisWeek), toOpen, leftTeam, found: inputs.length };
    }, [source, data, from, weekStart]);

    const copy = async () => {
        if (!plan?.add.length) return;
        setBusy(true);
        try {
            const n = await saveAll(plan.add, setProgress);
            toast.success(`Copied ${plural(n, 'entry', 'entries')} into ${rangeLabel(weekStart)}`);
            onDone();
        } catch (e) {
            toast.error((e as Error).message || 'Could not copy the week');
            setBusy(false);
        }
    };

    const shifts = plan?.add.filter(s => s.kind === 'shift').length ?? 0;
    const offs = (plan?.add.length ?? 0) - shifts;
    return (
        <Drawer title="Copy last week" onClose={onClose} footer={
            <>
                <span className="flex-1" />
                <Button onClick={onClose}>Cancel</Button>
                <Button variant="primary" disabled={!plan?.add.length || busy} onClick={() => { void copy(); }}
                    icon={busy ? <Loader2 size={14} className="animate-spin" /> : <CopyPlus size={14} />}>
                    {busy ? `Copying ${progress}/${plan?.add.length ?? 0}` : 'Copy into this week'}
                </Button>
            </>
        }>
            <p className="text-[12.5px] text-[var(--neu-text-dim)]">From {rangeLabel(from)} into {rangeLabel(weekStart)}, same days and times. It stays a draft until you publish.</p>
            {problem && <Msg kind="error">{problem}</Msg>}
            {!plan && !problem && (
                <p className="flex items-center gap-2 text-[12.5px] text-[var(--neu-text-dim)]"><Loader2 size={14} className="animate-spin" />Loading last week…</p>
            )}
            {plan && (
                <>
                    <dl className="neu-inset rounded-2xl p-3.5 grid grid-cols-[1fr_auto] gap-y-2 text-[13.5px]">
                        <dt className="text-[var(--neu-text-dim)]">Shifts to add</dt><dd className="font-semibold text-right tabular-nums">{shifts}</dd>
                        <dt className="text-[var(--neu-text-dim)]">Days off to add</dt><dd className="font-semibold text-right tabular-nums">{offs}</dd>
                        <dt className="text-[var(--neu-text-dim)]">Already in this week</dt><dd className="font-semibold text-right tabular-nums">{plan.repeats}</dd>
                    </dl>
                    {plan.found === 0 && <Msg kind="info">Last week has nothing planned.</Msg>}
                    {plan.toOpen > 0 && <Msg kind="warn">{plural(plan.toOpen, 'shift goes', 'shifts go')} in as open (the person is on leave or has left the team).</Msg>}
                    {plan.offClashes > 0 && <Msg kind="info">{plural(plan.offClashes, 'day off is', 'days off are')} skipped: the person already works that day.</Msg>}
                    {plan.found > 0 && plan.add.length === 0 && <Msg kind="info">Everything from last week is already here.</Msg>}
                </>
            )}
        </Drawer>
    );
};

/* ─────────────────────────────── Import ─────────────────────────────── */

const TEMPLATE = 'Date,Employee,Job title,Store,Start,End,Break (min),Status,Note\n';

export const ImportPanel: React.FC<{ data: StaffRosterData; onClose: () => void; onDone: () => void }> = ({ data, onClose, onDone }) => {
    const [text, setText] = useState('');
    const [fileName, setFileName] = useState('');
    const [existing, setExisting] = useState<ShiftInput[] | null>(null);
    const [checking, setChecking] = useState(false);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState(0);

    const read = useMemo(() => (text.trim() ? readImport(text, data) : null), [text, data]);
    const good = useMemo(() => (read?.rows ?? []).filter(r => r.shift).map(r => r.shift as ShiftInput), [read]);
    const bad = (read?.rows ?? []).filter(r => r.problem);
    const dates = good.map(s => s.date).sort((a, b) => a.localeCompare(b));
    const span = dates.length ? [dates[0], dates[dates.length - 1]] as const : null;
    const tooLong = !!span && (Date.parse(span[1]) - Date.parse(span[0])) / 86_400_000 > MAX_SPAN_DAYS;

    // What is already planned on those dates, so a file imported twice adds nothing.
    useEffect(() => {
        setExisting(null);
        if (!span || tooLong) return;
        let cancelled = false;
        setChecking(true);
        staffRosterService.load(span[0], span[1])
            .then(r => { if (!cancelled) setExisting(r.shifts.map(strip)); })
            .catch(() => { if (!cancelled) setExisting([]); })
            .finally(() => { if (!cancelled) setChecking(false); });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [span?.[0], span?.[1], tooLong]);

    const plan = existing ? addable(good, existing) : null;

    const pick = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.size > 1_000_000) { toast.error('That file is over 1 MB. Import a week or a month at a time.'); return; }
        setFileName(file.name);
        setText(await file.text());
    };

    const run = async () => {
        if (!plan?.add.length) return;
        setBusy(true);
        try {
            const n = await saveAll(plan.add, setProgress);
            toast.success(`Imported ${plural(n, 'entry', 'entries')}`);
            onDone();
        } catch (e) {
            toast.error((e as Error).message || 'Could not import');
            setBusy(false);
        }
    };

    const template = () => {
        const url = URL.createObjectURL(new Blob([`﻿${TEMPLATE}`], { type: 'text/csv;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url; a.download = 'roster-template.csv';
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    return (
        <Drawer title="Import roster" onClose={onClose} footer={
            <>
                <Button onClick={template}>Template</Button>
                <span className="flex-1" />
                <Button onClick={onClose}>Cancel</Button>
                <Button variant="primary" disabled={!plan?.add.length || busy} onClick={() => { void run(); }}
                    icon={busy ? <Loader2 size={14} className="animate-spin" /> : <FileUp size={14} />}>
                    {busy ? `Importing ${progress}/${plan?.add.length ?? 0}` : `Import ${plan?.add.length ? plural(plan.add.length, 'entry', 'entries') : ''}`}
                </Button>
            </>
        }>
            <p className="text-[12.5px] text-[var(--neu-text-dim)]">
                A CSV with the export&apos;s columns: Date, Employee, Job title, Store, Start, End, Break (min), Status, Note. Names must match the roster;
                an empty Employee makes an open shift, and &quot;Day off&quot; in Status marks a day off. Rows already planned are skipped, so importing twice is safe.
            </p>
            <label className="neu-raised-sm rounded-2xl p-4 flex items-center gap-3 cursor-pointer active-scale">
                <FileUp size={18} className="text-[var(--neu-gold)] shrink-0" />
                <span className="flex-1 min-w-0 text-[13px] font-semibold truncate">{fileName || 'Choose a CSV file'}</span>
                <input type="file" accept=".csv,text/csv" className="sr-only" onChange={e => { void pick(e); }} />
            </label>
            <details className="text-[12.5px]">
                <summary className="cursor-pointer text-[var(--neu-text-dim)]">Or paste the rows</summary>
                <label htmlFor="import-text" className="sr-only">CSV rows</label>
                <textarea id="import-text" value={text} onChange={e => { setText(e.target.value); setFileName(''); }} placeholder={TEMPLATE}
                    className="neu-field w-full min-h-[160px] mt-2 font-mono text-[11.5px] whitespace-pre" />
            </details>
            {read?.problem && <Msg kind="error">{read.problem}</Msg>}
            {tooLong && <Msg kind="error">The rows span more than {MAX_SPAN_DAYS} days. Import a month at a time.</Msg>}
            {read && !read.problem && !tooLong && (
                checking || !plan ? (
                    good.length ? <p className="flex items-center gap-2 text-[12.5px] text-[var(--neu-text-dim)]"><Loader2 size={14} className="animate-spin" />Checking the rows…</p> : null
                ) : (
                    <dl className="neu-inset rounded-2xl p-3.5 grid grid-cols-[1fr_auto] gap-y-2 text-[13.5px]">
                        <dt className="text-[var(--neu-text-dim)]">Ready to add</dt><dd className="font-semibold text-right tabular-nums">{plan.add.length}</dd>
                        <dt className="text-[var(--neu-text-dim)]">Already planned (skipped)</dt><dd className="font-semibold text-right tabular-nums">{plan.repeats}</dd>
                        {plan.offClashes > 0 && <><dt className="text-[var(--neu-text-dim)]">Days off on a working day (skipped)</dt><dd className="font-semibold text-right tabular-nums">{plan.offClashes}</dd></>}
                        <dt className="text-[var(--neu-text-dim)]">Rows with a problem</dt><dd className={`font-semibold text-right tabular-nums ${bad.length ? 'sr-bad-text' : ''}`}>{bad.length}</dd>
                        {span && <><dt className="text-[var(--neu-text-dim)]">Dates</dt><dd className="font-semibold text-right tabular-nums">{dayLabel(span[0])} – {dayLabel(span[1])}</dd></>}
                    </dl>
                )
            )}
            {bad.length > 0 && (
                <div className="space-y-1.5">
                    <p className="neu-label !mb-0">Not imported</p>
                    {bad.slice(0, 20).map(r => <Msg key={r.line} kind="warn">Row {r.line}: {r.problem}</Msg>)}
                    {bad.length > 20 && <p className="text-[12px] text-[var(--neu-text-dim)]">…and {bad.length - 20} more.</p>}
                </div>
            )}
        </Drawer>
    );
};
