// The platform's own name, tagline and logo.
//
// Each organization's branding is separate and comes later; this is the
// provider brand shown on the sign-in screen, the app shell and this panel.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Check, ImageUp, RotateCcw, X } from 'lucide-react';
import { Button, Field, Input } from '../components/ui';
import { refreshBranding } from '../useBranding';
import { api, type ApiError } from './api';
import { Section, Skeleton } from './kit';

interface Branding {
    appName: string;
    tagline: string;
    logoKey: string | null;
    logoVersion: number;
    accentColor: string | null;
}

const DEFAULT_ACCENT = '#b8860b';
const HEX = /^#[0-9a-fA-F]{6}$/;
const LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** A chosen logo, shown in the preview but not live until it is applied. */
interface StagedLogo { file: File; url: string }

/**
 * The same checks the server makes, so a wrong file is turned away before
 * anything is staged. The server still checks the bytes when it is applied.
 */
async function checkLogo(file: File): Promise<string | null> {
    if (!LOGO_TYPES.has(file.type)) return 'Choose a PNG, JPEG or WebP image. SVG is not accepted.';
    if (file.size > 1024 * 1024) return 'The logo must be 1 MB or smaller.';
    let size: { width: number; height: number };
    try {
        const bitmap = await createImageBitmap(file);
        size = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
    } catch {
        return 'That file is not a readable image.';
    }
    if (size.width < 64 || size.height < 64) return 'The logo must be at least 64×64 pixels.';
    if (size.width > 2048 || size.height > 2048) return 'The logo must be at most 2048×2048 pixels.';
    return null;
}

export const BrandingPanel: React.FC = () => {
    const [saved, setSaved] = useState<Branding | null>(null);
    const [appName, setAppName] = useState('');
    const [tagline, setTagline] = useState('');
    const [accentColor, setAccentColor] = useState('');
    const [busy, setBusy] = useState(false);
    const [staged, setStaged] = useState<StagedLogo | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);

    // A staged file's preview address is released when it is replaced or dropped.
    useEffect(() => () => { if (staged) URL.revokeObjectURL(staged.url); }, [staged]);

    const adopt = (b: Branding) => {
        setSaved(b);
        setAppName(b.appName);
        setTagline(b.tagline);
        setAccentColor(b.accentColor ?? '');
    };

    const load = useCallback(async () => {
        try { adopt(await api<Branding>('/admin/settings/branding')); }
        catch (e) { toast.error((e as ApiError).message); }
    }, []);
    useEffect(() => { load(); }, [load]);

    if (!saved) {
        return (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)] items-start">
                <Skeleton className="h-[26rem] rounded-2xl" />
                <Skeleton className="h-72 rounded-2xl" />
            </div>
        );
    }

    const accent = accentColor.trim();
    const accentValid = accent === '' || HEX.test(accent);
    const nameValid = appName.trim().length >= 2 && appName.trim().length <= 40;
    const textDirty = appName !== saved.appName || tagline !== saved.tagline || accent !== (saved.accentColor ?? '');
    const dirty = textDirty || staged !== null;
    const shownAccent = accentValid && accent ? accent : DEFAULT_ACCENT;

    const save = async (e: React.SubmitEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (!nameValid || !accentValid) return;
        setBusy(true);
        try {
            if (staged && !(await applyLogo(staged))) return;
            if (textDirty) {
                const b = await api<Branding>('/admin/settings/branding', {
                    method: 'PATCH',
                    body: JSON.stringify({ appName: appName.trim(), tagline: tagline.trim(), accentColor: accent || null }),
                });
                adopt(b);
            }
            toast.success('Branding saved');
            refreshBranding();
        } catch (err) { toast.error((err as ApiError).message); } finally { setBusy(false); }
    };

    /** Puts the staged logo live. True when it went through. */
    async function applyLogo(logo: StagedLogo): Promise<boolean> {
        try {
            // The raw image is the body; the server checks the bytes, not the name.
            const b = await api<Branding>('/admin/settings/branding/logo', {
                method: 'POST',
                headers: { 'Content-Type': logo.file.type },
                body: logo.file,
            });
            // Only the logo changed; keep any unsaved text as it is.
            setSaved(prev => prev ? { ...prev, logoKey: b.logoKey, logoVersion: b.logoVersion } : b);
            setStaged(null);
            return true;
        } catch (err) {
            toast.error((err as ApiError).message);
            return false;
        }
    }

    const applyStaged = async () => {
        if (!staged) return;
        setBusy(true);
        if (await applyLogo(staged)) {
            toast.success('New logo applied');
            refreshBranding();
        }
        setBusy(false);
    };

    /** Shows a chosen file in the previews; nothing goes live yet. */
    const stage = async (file: File) => {
        const problem = await checkLogo(file);
        if (problem) { toast.error(problem); return; }
        setStaged({ file, url: URL.createObjectURL(file) });
    };

    const discard = () => { adopt(saved); setStaged(null); };

    const liveLogoUrl = saved.logoKey ? `/api/v2/public/branding/logo?v=${saved.logoVersion}` : '/icon.png';
    const logoUrl = staged?.url ?? liveLogoUrl;

    return (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)] items-start">
            <form onSubmit={save} className="space-y-6 min-w-0">
                <Section title="Logo" description="PNG, JPEG or WebP · up to 1 MB · 64–2048 pixels. Square works best; SVG is not accepted.">
                    <div className="flex flex-wrap items-center gap-4">
                        <figure className="shrink-0 text-center">
                            <img src={liveLogoUrl} alt="Current logo" width={72} height={72}
                                className="w-[72px] h-[72px] rounded-2xl object-contain neu-inset p-1.5" />
                            <figcaption className="text-[11px] ac-faint mt-1.5">{staged ? 'Live now' : 'Current'}</figcaption>
                        </figure>
                        {staged && (
                            <figure className="shrink-0 text-center">
                                <img src={staged.url} alt="New logo, not applied yet" width={72} height={72}
                                    className="w-[72px] h-[72px] rounded-2xl object-contain neu-inset p-1.5" />
                                <figcaption className="text-[11px] mt-1.5 text-[var(--ac-warn)]">Not applied</figcaption>
                            </figure>
                        )}
                        <input
                            ref={fileInput}
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            className="hidden"
                            onChange={e => {
                                const f = e.target.files?.[0];
                                if (f) stage(f);
                                // Cleared either way, so choosing the same file again still fires.
                                e.target.value = '';
                            }}
                        />
                        <div className="flex flex-wrap items-center gap-2">
                            <Button type="button" onClick={() => fileInput.current?.click()} disabled={busy}>
                                <ImageUp size={15} /> {staged ? 'Choose another' : 'Upload a new logo'}
                            </Button>
                            {staged && (
                                <>
                                    <Button type="button" variant="primary" onClick={applyStaged} disabled={busy}>
                                        <Check size={15} /> {busy ? 'Applying…' : 'Apply logo'}
                                    </Button>
                                    <Button type="button" onClick={() => setStaged(null)} disabled={busy}>
                                        <X size={15} /> Cancel
                                    </Button>
                                </>
                            )}
                        </div>
                    </div>
                    {staged && (
                        <p className="text-[12px] mt-3 text-[var(--ac-warn)]">
                            Check it in the preview. Nothing changes on the website or the app until you apply it.
                        </p>
                    )}
                    <p className="text-[12px] ac-faint mt-4">
                        A copy already installed on a phone keeps its old icon until the device refreshes it, which
                        browsers do on their own schedule. Reinstalling is the only way to force it.
                    </p>
                </Section>

                <Section title="Name and colour" description="Shown on the sign-in screen, the app and this control centre.">
                    <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="Name" htmlFor="br-name" hint="2–40 characters.">
                            <Input id="br-name" required maxLength={40} value={appName} onChange={e => setAppName(e.target.value)}
                                aria-invalid={!nameValid} />
                        </Field>
                        <Field label="Tagline" htmlFor="br-tag" hint="Optional, up to 80 characters.">
                            <Input id="br-tag" maxLength={80} value={tagline} onChange={e => setTagline(e.target.value)} />
                        </Field>
                        <Field label="Accent colour" htmlFor="br-accent"
                            hint={accentValid ? 'Empty keeps the default gold.' : 'Use six hex digits, like #b8860b.'}>
                            <div className="flex items-center gap-2">
                                <label className="relative shrink-0 w-10 h-10 rounded-xl neu-inset p-1.5 cursor-pointer" title="Pick a colour">
                                    <span className="block w-full h-full rounded-lg" style={{ background: shownAccent }} />
                                    <input type="color" aria-label="Pick an accent colour" value={shownAccent}
                                        onChange={e => setAccentColor(e.target.value)}
                                        className="absolute inset-0 opacity-0 cursor-pointer" />
                                </label>
                                <Input id="br-accent" value={accentColor} onChange={e => setAccentColor(e.target.value)}
                                    placeholder={DEFAULT_ACCENT} aria-invalid={!accentValid} className="font-mono" />
                                {accent && (
                                    <button type="button" onClick={() => setAccentColor('')} title="Use the default"
                                        className="neu-button !px-2.5 shrink-0" aria-label="Use the default colour">
                                        <RotateCcw size={14} />
                                    </button>
                                )}
                            </div>
                        </Field>
                    </div>
                </Section>

                {/* Always rendered, so saving never moves the page. */}
                <div className="flex flex-wrap items-center justify-end gap-3">
                    <span className={`text-[12px] mr-auto transition-opacity ${dirty ? 'opacity-100 text-[var(--ac-warn)]' : 'opacity-0'}`} aria-live="polite">
                        {dirty ? 'Unsaved changes' : 'No changes'}
                    </span>
                    <Button type="button" disabled={!dirty || busy} onClick={discard}>Discard</Button>
                    <Button type="submit" variant="primary" disabled={!dirty || busy || !nameValid || !accentValid}>
                        {busy ? 'Saving…' : 'Save'}
                    </Button>
                </div>
            </form>

            <aside className="lg:sticky lg:top-6 min-w-0">
                <Section title="Preview" description={staged ? 'With the new logo, before it is applied.' : 'How the sign-in screen looks with these settings.'}>
                    <div className="rounded-2xl neu-inset p-5 sm:p-6 text-center">
                        <img src={logoUrl} alt="" width={56} height={56} className="w-14 h-14 mx-auto rounded-2xl object-contain" />
                        <p className="mt-3 font-serif text-xl truncate">{appName.trim() || 'Your name'}</p>
                        <p className="text-[12px] ac-muted min-h-[1.25rem] truncate">{tagline.trim()}</p>
                        <div className="mt-5 space-y-2.5 text-left" aria-hidden>
                            <div className="h-9 rounded-xl neu-inset" />
                            <div className="h-9 rounded-xl neu-inset" />
                            <div className="h-9 rounded-xl flex items-center justify-center text-[13px] font-medium text-white"
                                style={{ background: shownAccent }}>
                                Sign in
                            </div>
                        </div>
                    </div>
                </Section>
            </aside>
        </div>
    );
};
