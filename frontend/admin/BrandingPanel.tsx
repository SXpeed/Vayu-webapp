// The platform's own name, tagline and logo.
//
// Each organization's branding is separate and comes later; this is the
// provider brand shown on the sign-in screen, the app shell and this panel.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Image as ImageIcon } from 'lucide-react';
import { Button, Card, Field, Input, SectionTitle } from '../components/ui';
import { api, type ApiError } from './api';

interface Branding {
    appName: string;
    tagline: string;
    logoKey: string | null;
    logoVersion: number;
    accentColor: string | null;
}

export const BrandingPanel: React.FC = () => {
    const [saved, setSaved] = useState<Branding | null>(null);
    const [appName, setAppName] = useState('');
    const [tagline, setTagline] = useState('');
    const [accentColor, setAccentColor] = useState('');
    const [busy, setBusy] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);

    const load = useCallback(async () => {
        try {
            const b = await api<Branding>('/admin/settings/branding');
            setSaved(b);
            setAppName(b.appName);
            setTagline(b.tagline);
            setAccentColor(b.accentColor ?? '');
        } catch (e) { toast.error((e as ApiError).message); }
    }, []);
    useEffect(() => { load(); }, [load]);

    if (!saved) return <Card><p className="text-sm">Loading branding…</p></Card>;

    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        try {
            const b = await api<Branding>('/admin/settings/branding', {
                method: 'PATCH',
                body: JSON.stringify({ appName, tagline, accentColor: accentColor.trim() || null }),
            });
            setSaved(b);
            toast.success('Branding saved');
        } catch (err) { toast.error((err as ApiError).message); } finally { setBusy(false); }
    };

    const upload = async (file: File) => {
        setBusy(true);
        try {
            // The raw image is the body; the server checks the bytes, not the name.
            const b = await api<Branding>('/admin/settings/branding/logo', {
                method: 'POST',
                headers: { 'Content-Type': file.type },
                body: file,
            });
            setSaved(b);
            toast.success('Logo updated');
        } catch (err) { toast.error((err as ApiError).message); } finally { setBusy(false); }
    };

    const logoUrl = saved.logoKey ? `/api/v2/public/branding/logo?v=${saved.logoVersion}` : '/icon.png';

    return (
        <Card padding="lg">
            <SectionTitle actions={<ImageIcon size={16} />}>Platform name and logo</SectionTitle>
            <p className="text-[12px] mb-4 text-gray-600 dark:text-gray-400">
                Shown on the sign-in screen, the app and this panel. Each organization&apos;s own branding is separate.
            </p>

            <div className="flex items-center gap-4 mb-4">
                <img src={logoUrl} alt="Current logo" className="w-16 h-16 rounded-2xl object-contain neu-inset p-1" />
                <div>
                    <input
                        ref={fileInput}
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        className="hidden"
                        onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }}
                    />
                    <Button onClick={() => fileInput.current?.click()} disabled={busy}>Upload a logo</Button>
                    <p className="text-[11px] mt-1 text-gray-600 dark:text-gray-400">
                        PNG, JPEG or WebP · up to 1 MB · 64–2048 pixels · square works best. SVG is not accepted.
                    </p>
                </div>
            </div>

            <form onSubmit={save} className="grid gap-3 sm:grid-cols-3">
                <Field label="Name" htmlFor="br-name" hint="2–40 characters.">
                    <Input id="br-name" required value={appName} onChange={e => setAppName(e.target.value)} />
                </Field>
                <Field label="Tagline" htmlFor="br-tag" hint="Optional, shown under the name.">
                    <Input id="br-tag" value={tagline} onChange={e => setTagline(e.target.value)} />
                </Field>
                <Field label="Accent colour" htmlFor="br-accent" hint="Hex, e.g. #b8860b. Blank keeps the default.">
                    <Input id="br-accent" value={accentColor} onChange={e => setAccentColor(e.target.value)} placeholder="#b8860b" />
                </Field>
                <div className="sm:col-span-3">
                    <Button type="submit" variant="primary" disabled={busy}>Save</Button>
                </div>
            </form>

            <p className="text-[11px] mt-4 text-gray-600 dark:text-gray-400">
                An app already installed on a phone keeps its old icon until the device refreshes it, which browsers do
                on their own schedule. Reinstalling is the only way to force it.
            </p>
        </Card>
    );
};
