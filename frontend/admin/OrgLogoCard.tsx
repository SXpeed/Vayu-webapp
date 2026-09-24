// An organization's own logo: what its app shows on the loading screen.
//
// The background can be taken out here, before upload (logoBackground.ts),
// and the result is previewed on the app's light and dark page colours — the
// two surfaces the logo will actually sit on.

import React, { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { ImageUp, Trash2 } from 'lucide-react';
import { Button } from '../components/ui';
import { api, type ApiError } from './api';
import { Section, useDialogs } from './kit';
import { analyzeLogo, prepareLogo, type LogoAnalysis, type ProcessedLogo } from './logoBackground';

/** The app's page colours (--neu-bg), light and dark. */
const SURFACES = [
    { label: 'Light', bg: '#e9edf4', fg: '#4b5563' },
    { label: 'Dark', bg: '#22252b', fg: '#9ca3af' },
] as const;

interface Draft {
    file: File;
    analysis: LogoAnalysis;
    removeBg: boolean;
    result: ProcessedLogo | null;
}

const Previews: React.FC<{ src: string | null; busy?: boolean }> = ({ src, busy }) => (
    <div className="grid grid-cols-2 gap-3">
        {SURFACES.map(s => (
            <div key={s.label} className="rounded-2xl h-32 flex flex-col items-center justify-center gap-2 p-3" style={{ background: s.bg }}>
                <div className="flex-1 min-h-0 w-full flex items-center justify-center">
                    {src
                        ? <img src={src} alt="" className={`max-w-full max-h-20 object-contain transition-opacity ${busy ? 'opacity-40' : ''}`} />
                        : <span className="text-[12px]" style={{ color: s.fg }}>Platform logo</span>}
                </div>
                <span className="text-[10px] uppercase tracking-[0.14em]" style={{ color: s.fg }}>{s.label}</span>
            </div>
        ))}
    </div>
);

export const OrgLogoCard: React.FC<{ orgId: string; logoUrl: string | null; onChange: (url: string | null) => void }> = ({ orgId, logoUrl, onChange }) => {
    const dialogs = useDialogs();
    const fileInput = useRef<HTMLInputElement>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [working, setWorking] = useState(false);
    const path = `/admin/orgs/${orgId}/logo`;

    // Re-process whenever the file or the background choice changes.
    const file = draft?.file;
    const removeBg = draft?.removeBg;
    useEffect(() => {
        if (!file || removeBg === undefined) return;
        let cancelled = false;
        setWorking(true);
        prepareLogo(file, removeBg)
            .then(result => {
                if (cancelled) { URL.revokeObjectURL(result.url); return; }
                setDraft(d => {
                    if (d?.result) URL.revokeObjectURL(d.result.url);
                    return d ? { ...d, result } : d;
                });
            })
            .catch(() => { if (!cancelled) toast.error('That image could not be read.'); })
            .finally(() => { if (!cancelled) setWorking(false); });
        return () => { cancelled = true; };
    }, [file, removeBg]);

    const choose = async (f: File) => {
        try {
            const analysis = await analyzeLogo(f);
            // Remove by default when there is a background to remove.
            setDraft({ file: f, analysis, removeBg: !analysis.transparent, result: null });
        } catch {
            toast.error('That image could not be read. Use a PNG, JPEG or WebP.');
        }
    };

    const cancel = () => {
        if (draft?.result) URL.revokeObjectURL(draft.result.url);
        setDraft(null);
    };

    const save = async () => {
        if (!draft?.result) return;
        setWorking(true);
        try {
            const res = await api<{ logoUrl: string | null }>(path, {
                method: 'POST', headers: { 'Content-Type': 'image/png' }, body: draft.result.blob,
            });
            onChange(res.logoUrl);
            cancel();
            toast.success('Logo saved');
        } catch (e) { toast.error((e as ApiError).message); } finally { setWorking(false); }
    };

    const remove = async () => {
        if (!(await dialogs.confirm({ title: 'Remove this logo?', body: "The app goes back to showing the platform's logo.", confirmLabel: 'Remove', danger: true }))) return;
        setWorking(true);
        try {
            onChange((await api<{ logoUrl: string | null }>(path, { method: 'DELETE' })).logoUrl);
            toast.success('Logo removed');
        } catch (e) { toast.error((e as ApiError).message); } finally { setWorking(false); }
    };

    let hint = '';
    if (draft?.analysis.transparent) hint = 'This image already has a transparent background.';
    else if (draft && draft.analysis.uniformity < 0.6) hint = "The edge of this image isn't one plain colour, so taking the background out may leave marks. Check both previews.";

    return (
        <Section title="App logo" description="Shown on this organization's app while it loads. PNG, JPEG or WebP; a transparent background suits both themes.">
            <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={e => {
                    const f = e.target.files?.[0];
                    if (f) choose(f);
                    e.target.value = '';
                }}
            />
            {draft ? (
                <div className="space-y-4">
                    <Previews src={draft.result?.url ?? null} busy={working} />
                    <label className="flex items-center gap-2.5 text-[13px] cursor-pointer select-none">
                        <input type="checkbox" checked={draft.removeBg} disabled={working}
                            onChange={e => setDraft(d => (d ? { ...d, removeBg: e.target.checked } : d))}
                            className="w-4 h-4 accent-[var(--ac-accent,#b8860b)]" />
                        Remove the background
                    </label>
                    {hint && <p className="text-[12px] ac-faint">{hint}</p>}
                    {draft.result && (
                        <p className="text-[12px] ac-faint tabular-nums">
                            {draft.result.width}×{draft.result.height} px · {Math.max(1, Math.round(draft.result.blob.size / 1024))} KB PNG
                        </p>
                    )}
                    <div className="flex flex-wrap justify-end gap-2">
                        <Button type="button" onClick={cancel} disabled={working}>Cancel</Button>
                        <Button type="button" variant="primary" onClick={save} disabled={working || !draft.result}>
                            {working ? 'Working…' : 'Save logo'}
                        </Button>
                    </div>
                </div>
            ) : (
                <div className="space-y-4">
                    <Previews src={logoUrl} />
                    <div className="flex flex-wrap gap-2">
                        <Button type="button" onClick={() => fileInput.current?.click()} disabled={working}>
                            <ImageUp size={15} /> {logoUrl ? 'Replace logo' : 'Upload a logo'}
                        </Button>
                        {logoUrl && (
                            <Button type="button" variant="danger" onClick={remove} disabled={working}>
                                <Trash2 size={15} /> Remove
                            </Button>
                        )}
                    </div>
                </div>
            )}
        </Section>
    );
};
