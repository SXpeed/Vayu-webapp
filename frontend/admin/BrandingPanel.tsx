// The platform's own name, tagline and logo.
//
// Each organization's branding is separate and comes later; this is the
// provider brand shown on the sign-in screen, the app shell and this panel.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { ImageUp, RotateCcw } from 'lucide-react';
import { Button, Field, Input } from '../components/ui';
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

export const BrandingPanel: React.FC = () => {
    const [saved, setSaved] = useState<Branding | null>(null);
    const [appName, setAppName] = useState('');
    const [tagline, setTagline] = useState('');
    const [accentColor, setAccentColor] = useState('');
    const [busy, setBusy] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);

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
                <Skeleton className="h-[26rem] rounded-[18px]" />
                <Skeleton className="h-72 rounded-[18px]" />
            </div>
        );
    }

    const accent = accentColor.trim();
    const accentValid = accent === '' || HEX.test(accent);
    const nameValid = appName.trim().length >= 2 && appName.trim().length <= 40;
    const dirty = appName !== saved.appName || tagline !== saved.tagline || accent !== (saved.accentColor ?? '');
    const shownAccent = accentValid && accent ? accent : DEFAULT_ACCENT;

    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!nameValid || !accentValid) return;
        setBusy(true);
        try {
            const b = await api<Branding>('/admin/settings/branding', {
                method: 'PATCH',
                body: JSON.stringify({ appName: appName.trim(), tagline: tagline.trim(), accentColor: accent || null }),
            });
            adopt(b);
            toast.success('Branding saved');
        } catch (err) { toast.error((err as ApiError).message); } finally { setBusy(false); }
    };

    const upload = async (file: File) => {
        if (file.size > 1024 * 1024) { toast.error('The logo must be 1 MB or smaller.'); return; }
        setBusy(true);
        try {
            // The raw image is the body; the server checks the bytes, not the name.
            const b = await api<Branding>('/admin/settings/branding/logo', {
                method: 'POST',
                headers: { 'Content-Type': file.type },
                body: file,
            });
            // Only the logo changed; keep any unsaved text as it is.
            setSaved(prev => prev ? { ...prev, logoKey: b.logoKey, logoVersion: b.logoVersion } : b);
            toast.success('Logo updated');
        } catch (err) { toast.error((err as ApiError).message); } finally { setBusy(false); }
    };

    const logoUrl = saved.logoKey ? `/api/v2/public/branding/logo?v=${saved.logoVersion}` : '/icon.png';

    return (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)] items-start">
            <form onSubmit={save} className="space-y-6 min-w-0">
                <Section title="Logo" description="PNG, JPEG or WebP · up to 1 MB · 64–2048 pixels. Square works best; SVG is not accepted.">
                    <div className="flex flex-wrap items-center gap-4">
                        <img src={logoUrl} alt="Current logo" width={72} height={72}
                            className="w-[72px] h-[72px] shrink-0 rounded-2xl object-contain neu-inset p-1.5" />
                        <input
                            ref={fileInput}
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            className="hidden"
                            onChange={e => {
                                const f = e.target.files?.[0];
                                if (f) upload(f);
                                // Cleared either way, so choosing the same file again still fires.
                                e.target.value = '';
                            }}
                        />
                        <Button type="button" onClick={() => fileInput.current?.click()} disabled={busy}>
                            <ImageUp size={15} /> Upload a new logo
                        </Button>
                    </div>
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
                    <Button type="button" disabled={!dirty || busy} onClick={() => adopt(saved)}>Discard</Button>
                    <Button type="submit" variant="primary" disabled={!dirty || busy || !nameValid || !accentValid}>
                        {busy ? 'Saving…' : 'Save'}
                    </Button>
                </div>
            </form>

            <aside className="lg:sticky lg:top-6 min-w-0">
                <Section title="Preview" description="How the sign-in screen looks with these settings.">
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
