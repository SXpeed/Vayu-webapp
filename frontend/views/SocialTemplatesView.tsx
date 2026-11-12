// Social → templates: the list (with each one's review), how a template looks
// to the person who gets it, and the builders for WhatsApp (every part MSG91
// and Meta allow for an invite) and email. Server: social.ts.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
    AlertCircle, Bold, CheckCheck, Code, Copy, ExternalLink, FileText, Image as ImageIcon, Italic, Languages, Loader2, Mail, MapPin, MessageCircle,
    Phone, Plus, RefreshCw, Reply, Search, Send, Strikethrough, Trash2, Upload, Video, X,
} from 'lucide-react';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { PageRoot, PageHeader, PageBody, GhostIconButton, Button, Card, SectionTitle, Field, Input, Textarea, Select, Pill, Badge, EmptyState, ToggleRow } from '../components/ui';
import { PhotoAttachments } from '../components/PhotoAttachments';
import storageService from '../services/storageService';
import { socialService } from '../services/socialService';
import {
    BUTTON_LIMITS, CATEGORIES, FIELDS, HEADERS, LANGUAGES, MAX_BODY, MAX_BUTTONS, MAX_EMAIL_BODY, MAX_FOOTER, MAX_HEADER_TEXT, MEDIA_HEADERS, MEDIA_RULES, RSVP_BUTTONS,
    NAME_TOKEN, RSVP_NO, RSVP_YES, SAMPLE, fieldLabel, sendSlots, fieldsNeedingSamples, filledBody, parseTemplate, sampleOf, templateFields, templateSlug, templateTitle,
    type ButtonKind, type Category, type Channel, type FieldValues, type HeaderKind, type SocialTemplate, type TemplateButton, type TemplateInput,
} from '../socialRules';

export const message = (e: unknown) => (e as Error).message || 'Something went wrong. Please try again.';
export const spinner = <div className="py-16 flex justify-center text-[var(--neu-text-dim)]"><Loader2 size={22} className="animate-spin" /></div>;
export const TONE: Partial<Record<string, string>> = {
    approved: '!text-emerald-700 dark:!text-emerald-400', sent: '!text-emerald-700 dark:!text-emerald-400', read: '!text-emerald-700 dark:!text-emerald-400',
    rejected: '!text-red-700 dark:!text-red-400', failed: '!text-red-700 dark:!text-red-400', scheduled: '!text-gold-700 dark:!text-gold-300',
};
const TEMPLATE_LABEL = { pending: 'In review', approved: 'Approved', rejected: 'Rejected' };

export const Problem: React.FC<{ children?: React.ReactNode }> = ({ children }) =>
    (children ? <p role="alert" className="text-[13px] text-red-600 dark:text-red-400 flex items-start gap-1.5"><AlertCircle size={14} className="mt-0.5 shrink-0" />{children}</p> : null);

/* ------------------------------- How it looks ------------------------------- */

const FORMAT = /(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|```[^`]+```)/g;

/** WhatsApp's own formatting: *bold*, _italic_, ~strikethrough~, ```monospace```. */
const Formatted: React.FC<{ text: string }> = ({ text }) => (
    <>
        {text.split(FORMAT).map((part, i) => {
            const key = `${i}-${part.length}`;
            if (part.startsWith('```') && part.endsWith('```') && part.length > 6) return <code key={key} className="font-mono text-[12.5px]">{part.slice(3, -3)}</code>;
            const mark = part.length > 2 ? part[0] : '';
            if (mark && part.endsWith(mark) && '*_~'.includes(mark)) {
                const inside = part.slice(1, -1);
                if (mark === '*') return <strong key={key}>{inside}</strong>;
                if (mark === '_') return <em key={key}>{inside}</em>;
                return <s key={key}>{inside}</s>;
            }
            return <React.Fragment key={key}>{part}</React.Fragment>;
        })}
    </>
);

const BUTTON_ICON: Record<ButtonKind, React.ElementType> = { quick_reply: Reply, url: ExternalLink, phone: Phone, copy_code: Copy };
const MEDIA_ICON: Partial<Record<HeaderKind, React.ElementType>> = { image: ImageIcon, video: Video, document: FileText, location: MapPin };

const HeaderPreview: React.FC<{ t: Pick<TemplateInput, 'header' | 'headerText' | 'samples'>; mediaUrl?: string; values: FieldValues }> = ({ t, mediaUrl, values }) => {
    if (t.header === 'none') return null;
    if (t.header === 'text') return <p className="mb-1 font-semibold text-[14px] text-gray-900 dark:text-gray-100">{filledBody(t.headerText, values, t.samples)}</p>;
    if (t.header === 'image' && mediaUrl) return <img src={mediaUrl} alt="" className="mb-2 w-full max-h-56 object-cover rounded-lg" />;
    const Icon = MEDIA_ICON[t.header] ?? ImageIcon;
    const thing = t.header === 'image' ? 'picture' : t.header;
    const label = t.header === 'location' ? values.location_name || 'Your location' : `Your ${thing}`;
    return (
        <div className="mb-2 h-28 rounded-lg bg-black/5 dark:bg-white/10 flex flex-col items-center justify-center gap-1 text-[11.5px] text-gray-500">
            <Icon size={20} strokeWidth={1.5} aria-hidden />{label}
        </div>
    );
};

/** The WhatsApp message as it looks on the phone: header, words, small print, then its buttons. */
export const Bubble: React.FC<{ t: Pick<TemplateInput, 'header' | 'headerText' | 'body' | 'footer' | 'buttons' | 'samples'>; mediaUrl?: string; values: FieldValues }> = ({ t, mediaUrl, values }) => (
    <div className="neu-inset rounded-2xl p-4">
        <div className="max-w-[88%]">
            <div className="rounded-2xl rounded-tl-sm bg-white dark:bg-[#1f2c22] px-3.5 py-2.5 shadow-sm">
                <HeaderPreview t={t} mediaUrl={mediaUrl} values={values} />
                <p className="text-[13.5px] leading-relaxed whitespace-pre-line break-words text-gray-900 dark:text-gray-100"><Formatted text={filledBody(t.body, values, t.samples) || 'Your message'} /></p>
                {t.footer && <p className="mt-1 text-[11.5px] text-gray-500">{t.footer}</p>}
                <p className="mt-1 text-right text-[10px] text-gray-500">10:42 <CheckCheck size={12} className="inline text-sky-500" /></p>
            </div>
            {t.buttons.map((b, i) => {
                const Icon = BUTTON_ICON[b.kind];
                return (
                    <div key={`${b.kind}-${i}`} className="mt-1 rounded-xl bg-white dark:bg-[#1f2c22] px-3 py-2 shadow-sm flex items-center justify-center gap-1.5 text-[13px] text-sky-700 dark:text-sky-400">
                        <Icon size={13} aria-hidden />{b.kind === 'copy_code' ? 'Copy offer code' : b.text || 'Button'}
                    </div>
                );
            })}
        </div>
    </div>
);

/** The email as it looks in an inbox: subject, picture, message, RSVP buttons, unsubscribe line. */
export const EmailPreview: React.FC<{ t: Pick<TemplateInput, 'header' | 'headerText' | 'body' | 'buttons' | 'samples'>; mediaUrl?: string; values: FieldValues; sender?: string }> = ({ t, mediaUrl, values, sender }) => (
    <Card className="text-[var(--neu-text)]">
        <p className="text-[11px] text-[var(--neu-text-dim)] truncate">From: {sender || 'Your gallery'}</p>
        <p className="mt-1 font-serif text-[16px] text-gray-900 dark:text-white break-words">{filledBody(t.headerText, values, t.samples) || 'Subject'}</p>
        <div className="mt-3 pt-3 border-t border-[var(--neu-line)] space-y-3">
            {t.header === 'image' && <HeaderPreview t={t} mediaUrl={mediaUrl} values={values} />}
            {(filledBody(t.body, values, t.samples) || 'Your message').split(/\n{2,}/).map((p, i) => <p key={`${i}-${p.length}`} className="text-[13.5px] leading-relaxed whitespace-pre-line break-words">{p}</p>)}
            {t.buttons.length > 0 && <div className="flex flex-wrap gap-2"><Button variant="primary" tabIndex={-1}>{RSVP_YES}</Button><Button tabIndex={-1}>{RSVP_NO}</Button></div>}
        </div>
        <p className="mt-4 text-[10.5px] text-[var(--neu-text-dim)]">{sender || 'Your gallery'} · <u>Unsubscribe</u></p>
    </Card>
);

export const TemplatePreview: React.FC<{ t: TemplateInput; mediaUrl?: string; values: FieldValues; sender?: string }> = ({ t, mediaUrl, values, sender }) =>
    (t.channel === 'email' ? <EmailPreview t={t} mediaUrl={mediaUrl} values={values} sender={sender} /> : <Bubble t={t} mediaUrl={mediaUrl} values={values} />);

/* ------------------------------- A header file ------------------------------- */

/** The file at the top of a message: a photo (camera or gallery), or a video or PDF from the device. */
export const MediaPicker: React.FC<{ kind: HeaderKind; urls: string[]; onChange: (urls: string[]) => void; onUploadingChange: (busy: boolean) => void }> = ({ kind, urls, onChange, onUploadingChange }) => {
    const input = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const rule = MEDIA_RULES[kind];
    if (kind === 'image') return <PhotoAttachments urls={urls} onUploadingChange={onUploadingChange} onAdd={u => onChange(u.slice(-1))} onRemove={() => onChange([])} />;
    const pick = async (file: File | undefined) => {
        if (!file) return;
        setBusy(true); onUploadingChange(true);
        try { onChange([(await storageService.upload(file)).url]); } catch (e) { toast.error(message(e)); } finally { setBusy(false); onUploadingChange(false); }
    };
    const Icon = MEDIA_ICON[kind] ?? FileText;
    return (
        <div className="flex items-center gap-2">
            <input ref={input} type="file" accept={rule?.accept} className="sr-only" tabIndex={-1} onChange={e => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
            <Button type="button" disabled={busy} icon={busy ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} onClick={() => input.current?.click()}>
                {urls[0] ? `Change ${kind}` : `Choose a ${kind}`}
            </Button>
            {urls[0] && <span className="inline-flex items-center gap-1 text-[12.5px] text-[var(--neu-text-dim)]"><Icon size={14} aria-hidden />Added</span>}
        </div>
    );
};

/* ------------------------------- The list ------------------------------- */

type TemplateFilter = 'all' | SocialTemplate['status'];
const TEMPLATE_FILTERS: { key: TemplateFilter; label: string }[] = [
    { key: 'all', label: 'All' }, { key: 'approved', label: 'Approved' }, { key: 'pending', label: 'In review' }, { key: 'rejected', label: 'Rejected' },
];

/** One line of the message, as a person would read it. */
const previewLine = (t: SocialTemplate) => filledBody(t.body, SAMPLE, t.samples).replaceAll(/\s+/g, ' ').trim();

/** What a template carries besides its words. */
const TemplateTraits: React.FC<{ t: SocialTemplate }> = ({ t }) => {
    const HeaderIcon = MEDIA_ICON[t.header];
    return (
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-[var(--neu-text-dim)]">
            <span className="inline-flex items-center gap-1"><Languages size={12} aria-hidden />{LANGUAGES[t.language] ?? t.language}</span>
            {t.channel === 'whatsapp' && <span>{CATEGORIES[t.category]}</span>}
            {HeaderIcon && <span className="inline-flex items-center gap-1"><HeaderIcon size={12} aria-hidden />{HEADERS[t.header]}</span>}
            {t.buttons.length > 0 && <span className="inline-flex items-center gap-1"><Reply size={12} aria-hidden />{t.buttons.length === 1 ? '1 button' : `${t.buttons.length} buttons`}</span>}
        </span>
    );
};

const TemplateRow: React.FC<{ t: SocialTemplate; showChannel: boolean; selected: boolean; onOpen: () => void }> = ({ t, showChannel, selected, onOpen }) => (
    <li className="task-row">
        <button type="button" onClick={onOpen} aria-current={selected || undefined}
            className={`w-full flex items-start gap-3 px-2 py-3 text-left rounded-xl active-scale ${selected ? 'neu-inset' : ''}`}>
            <span className="mt-0.5 w-9 h-9 shrink-0 rounded-full neu-inset flex items-center justify-center text-brand-900 dark:text-gold-400">
                {t.header === 'none' ? <MessageCircle size={16} strokeWidth={1.5} /> : React.createElement(MEDIA_ICON[t.header] ?? FileText, { size: 16, strokeWidth: 1.5 })}
            </span>
            <span className="flex-1 min-w-0 space-y-1">
                <span className="flex items-center gap-2">
                    <span className="flex-1 min-w-0 font-serif text-[15px] leading-snug truncate text-gray-900 dark:text-white">{templateTitle(t.name)}</span>
                    {showChannel && <Badge>{CHANNEL_NAME[t.channel]}</Badge>}
                    <Badge className={TONE[t.status] ?? ''}>{TEMPLATE_LABEL[t.status]}</Badge>
                </span>
                {t.channel === 'email' && <span className="block text-[12.5px] truncate text-gray-800 dark:text-gray-200">{filledBody(t.headerText, SAMPLE, t.samples)}</span>}
                <span className="text-[12.5px] leading-snug text-[var(--neu-text-dim)] line-clamp-2 break-words">{previewLine(t)}</span>
                <TemplateTraits t={t} />
            </span>
        </button>
    </li>
);

const reviewer = (c: Channel) => (c === 'email' ? 'MSG91' : 'Meta');

/** One template in full: how it looks, what the review said, and what can be done with it. */
export const TemplateDetail: React.FC<{ t: SocialTemplate; sender?: string; canSend: boolean; onUse: () => void; onRemoved: () => void }> = ({ t, sender, canSend, onUse, onRemoved }) => {
    const [confirm, setConfirm] = useState(false);
    const [busy, setBusy] = useState(false);
    useEffect(() => setConfirm(false), [t.id]);
    const fields = [...new Set([...templateFields(t.headerText), ...templateFields(t.body)])].map(fieldLabel);
    const remove = async () => {
        if (!confirm) { setConfirm(true); return; }
        setBusy(true);
        try { await socialService.removeTemplate(t.id); onRemoved(); } catch (e) { toast.error(message(e)); } finally { setBusy(false); setConfirm(false); }
    };
    return (
        <div className="space-y-4 text-[var(--neu-text)]">
            <Card className="space-y-3">
                <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                        <p className="font-serif text-[18px] leading-snug text-gray-900 dark:text-white break-words">{templateTitle(t.name)}</p>
                        <p className="mt-0.5 text-[11.5px] text-[var(--neu-text-dim)] break-all">{t.name}</p>
                    </div>
                    <Badge className={TONE[t.status] ?? ''}>{TEMPLATE_LABEL[t.status]}</Badge>
                </div>
                <TemplateTraits t={t} />
                {fields.length > 0 && <p className="text-[12.5px] text-[var(--neu-text-dim)]">Filled in for each person or when you send: {fields.join(', ')}.</p>}
                {t.status === 'pending' && <p className="text-[12.5px] text-[var(--neu-text-dim)]">{reviewer(t.channel)} is reviewing it, usually within a day. Open this list again to check.</p>}
                {t.status === 'rejected' && <Problem>{t.reason ? `${reviewer(t.channel)} refused it: ${t.reason}` : 'It was refused. Change the words and send it again under a new name.'}</Problem>}
            </Card>
            <section>
                <SectionTitle className="px-3">How it looks</SectionTitle>
                <TemplatePreview t={t} values={SAMPLE} sender={sender} />
            </section>
            {canSend && (
                <div className="flex flex-col sm:flex-row gap-2">
                    {t.status === 'approved' && <Button variant="primary" className="sm:flex-1" icon={<Send size={15} />} onClick={onUse}>Use in an invite</Button>}
                    <Button variant="danger" className="sm:flex-1" disabled={busy} icon={busy ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />} onClick={() => { void remove(); }}>
                        {confirm ? 'Tap again to remove' : 'Remove from this list'}
                    </Button>
                </div>
            )}
        </div>
    );
};

/** The inputs a template needs filled before sending (not the person's name: that is added for each one). */
export const SlotInputs: React.FC<{ template: SocialTemplate; values: FieldValues; onChange: (v: FieldValues) => void }> = ({ template, values, onChange }) => {
    const slots = sendSlots(template);
    // A template from MSG91's panel has numbered fields; the first is nearly always the person's name.
    const firstNumbered = slots.find(s => /^\d+$/.test(s.key))?.key;
    if (!slots.length) return <p className="text-[13px] text-[var(--neu-text-dim)]">Nothing to fill in: each person’s name is added for you.</p>;
    return (
        <>
            {slots.map(s => (
                <Field key={s.key} label={s.label} htmlFor={`inv-${s.key}`} hint={s.key === firstNumbered ? `${NAME_TOKEN} puts each person’s own first name there.` : s.hint}>
                    <Input id={`inv-${s.key}`} maxLength={200} placeholder={template.samples[s.key] || (SAMPLE as Record<string, string>)[s.key] || ''} value={values[s.key] ?? ''}
                        onChange={e => onChange({ ...values, [s.key]: e.target.value })} />
                </Field>
            ))}
        </>
    );
};

export type ChannelFilter = 'all' | Channel;

/** Two or three big tabs (WhatsApp | Email, Instagram | Facebook | YouTube): one never mixes with the other. */
export function Segmented<K extends string>({ value, onChange, options, label }: Readonly<{
    value: K; onChange: (k: K) => void; label: string; options: { key: K; label: string; Icon: React.ElementType; count?: number }[];
}>) {
    return (
        <div role="tablist" aria-label={label} className={`grid gap-1 p-1 rounded-xl neu-inset ${options.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
            {options.map(o => (
                <button key={o.key} type="button" role="tab" aria-selected={value === o.key} onClick={() => onChange(o.key)}
                    className={`min-w-0 flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-[13px] font-medium transition-colors ${value === o.key ? 'neu-card !border-gold-500 text-brand-900 dark:text-gold-400' : 'text-[var(--neu-text-dim)]'}`}>
                    <o.Icon size={15} className="shrink-0" aria-hidden /><span className="truncate">{o.label}</span>
                    {!!o.count && <span className="tabular-nums text-[11px] opacity-70">{o.count}</span>}
                </button>
            ))}
        </div>
    );
}
export const CHANNEL_ICON: Record<Channel, React.ElementType> = { whatsapp: MessageCircle, email: Mail };
export const CHANNEL_NAME: Record<Channel, string> = { whatsapp: 'WhatsApp', email: 'Email' };

/** The templates of one channel or both: each review's result asked of MSG91 on opening, with WhatsApp ones made in its panel brought in. */
async function loadTemplates(filter: ChannelFilter, ready: Record<Channel, boolean>): Promise<{ templates: SocialTemplate[]; skipped: number; unchecked: boolean }> {
    const channels = (['whatsapp', 'email'] as const).filter(c => (filter === 'all' || filter === c) && ready[c]);
    const got = await Promise.all(channels.map(c => socialService.refreshTemplates(c)));
    return {
        templates: got.flatMap(g => g.templates).sort((x, y) => y.createdAt - x.createdAt),
        skipped: got.reduce((n, g) => n + g.skipped, 0),
        unchecked: got.some(g => !g.checked),
    };
}

/**
 * The Templates tab: search, channel and review filters, the list, and (on a
 * wide screen) the chosen template beside it. On a phone a template opens as
 * its own page, through `onOpen`.
 */
export const TemplatesPanel: React.FC<{
    filter: ChannelFilter; ready: Record<Channel, boolean>; sender?: string; canSend: boolean;
    onNew: () => void; onUse: (t: SocialTemplate) => void; onOpen: (t: SocialTemplate) => void;
}> = ({ filter, ready, sender, canSend, onNew, onUse, onOpen }) => {
    const isDesktop = useIsDesktop();
    const [templates, setTemplates] = useState<SocialTemplate[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [skipped, setSkipped] = useState(0);
    const [review, setReview] = useState<TemplateFilter>('all');
    const [query, setQuery] = useState('');
    const [selectedId, setSelectedId] = useState('');

    // By value: a new `ready` object each render must not reload the list.
    const { whatsapp, email } = ready;
    const load = useCallback(async () => {
        setBusy(true);
        try {
            const got = await loadTemplates(filter, { whatsapp, email });
            setTemplates(got.templates); setSkipped(got.skipped);
            if (got.unchecked) toast.error('MSG91 did not answer. Showing what was last known.');
        } catch (e) { toast.error(message(e)); setTemplates(t => t ?? []); } finally { setBusy(false); }
    }, [filter, whatsapp, email]);
    useEffect(() => { void load(); }, [load]);

    const q = query.trim().toLowerCase();
    const matches = (templates ?? []).filter(t => !q || `${templateTitle(t.name)} ${t.headerText} ${t.body}`.toLowerCase().includes(q));
    const count = (key: TemplateFilter) => matches.filter(t => key === 'all' || t.status === key).length;
    const shown = matches.filter(t => review === 'all' || t.status === review);
    // Desktop always shows one: the chosen one, or the first in the list.
    const selected = isDesktop ? shown.find(t => t.id === selectedId) ?? shown[0] : undefined;
    const removed = () => { setTemplates(list => (list ?? []).filter(x => x.id !== selected?.id)); setSelectedId(''); toast.success('Removed from this list'); };
    const open = (t: SocialTemplate) => (isDesktop ? setSelectedId(t.id) : onOpen(t));

    if (!ready.whatsapp && !ready.email) {
        return <EmptyState icon={<FileText size={22} strokeWidth={1.5} />} title="Connect MSG91 first" message="Templates live in your MSG91 account. Set it up under Settings." />;
    }
    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[12rem]">
                    <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--neu-text-dim)] pointer-events-none" aria-hidden />
                    <Input aria-label="Search templates" placeholder="Search templates" value={query} onChange={e => setQuery(e.target.value)} className="!pl-10" />
                </div>
                <GhostIconButton label="Check approvals" disabled={busy} onClick={() => { void load(); }} icon={busy ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} className="text-brand-900 dark:text-gold-400" />} />
                {canSend && <Button variant="primary" icon={<Plus size={15} />} onClick={onNew}>New template</Button>}
            </div>
            {!!templates?.length && (
                <div className="flex flex-wrap gap-2">
                    {TEMPLATE_FILTERS.map(f => <Pill key={f.key} active={review === f.key} onClick={() => setReview(f.key)}>{f.label} {count(f.key)}</Pill>)}
                </div>
            )}
            {!templates && spinner}
            {templates?.length === 0 && (
                <EmptyState icon={<FileText size={22} strokeWidth={1.5} />} title="No templates yet"
                    message="WhatsApp templates already approved on your MSG91 account show here by themselves. Or start from a ready-made invite and send it for approval."
                    action={canSend ? <Button variant="primary" className="mt-4" icon={<Plus size={15} />} onClick={onNew}>New template</Button> : undefined} />
            )}
            {!!templates?.length && (
                <div className="grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] gap-4 lg:items-start">
                    <div className="space-y-2 min-w-0">
                        {shown.length > 0
                            ? <ul className="neu-card px-2 py-1">{shown.map(t => <TemplateRow key={t.id} t={t} showChannel={filter === 'all'} selected={t.id === selected?.id} onOpen={() => open(t)} />)}</ul>
                            : <p className="neu-card px-4 py-6 text-center text-[13px] text-[var(--neu-text-dim)]">None match.</p>}
                        {skipped > 0 && <p className="px-3 text-[11.5px] text-[var(--neu-text-dim)]">{skipped} more on your MSG91 account can’t be sent from here (a carousel, a one-time password, or named fields).</p>}
                    </div>
                    {selected && <div className="lg:sticky lg:top-4 min-w-0"><TemplateDetail t={selected} sender={sender} canSend={canSend} onUse={() => onUse(selected)} onRemoved={removed} /></div>}
                </div>
            )}
        </div>
    );
};

/** A template on its own page (phones). */
export const TemplatePage: React.FC<{ t: SocialTemplate; sender?: string; canSend: boolean; onBack: () => void; onUse: () => void }> = ({ t, sender, canSend, onBack, onUse }) => (
    <PageRoot>
        <PageHeader title="Template" subtitle={CHANNEL_NAME[t.channel]} onBack={onBack} />
        <PageBody><TemplateDetail t={t} sender={sender} canSend={canSend} onUse={onUse} onRemoved={() => { toast.success('Removed from this list'); onBack(); }} /></PageBody>
    </PageRoot>
);

/* ------------------------------- Building one ------------------------------- */

const STARTERS: { title: string; subject: string; body: string }[] = [
    { title: 'Exhibition opening', subject: 'You’re invited: {{event}}', body: 'Hello {{name}}, you are invited to the opening of *{{event}}* on {{date}} at {{venue}}. We would love to see you there.' },
    { title: 'Private viewing', subject: 'A private viewing of {{event}}', body: 'Hello {{name}}, we are holding a private viewing of *{{event}}* on {{date}} at {{venue}}, for a few of our collectors. Do join us.' },
    { title: 'Reminder', subject: 'Reminder: {{event}} is on {{date}}', body: 'Hello {{name}}, a reminder that *{{event}}* is on {{date}} at {{venue}}. We look forward to seeing you.' },
];

/** Wraps the selected words of a text box in a WhatsApp mark (or puts the mark at the cursor). */
function wrapSelection(el: HTMLTextAreaElement | null, value: string, mark: string, set: (v: string) => void) {
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    set(`${value.slice(0, start)}${mark}${value.slice(start, end)}${mark}${value.slice(end)}`);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + mark.length, end + mark.length); });
}

/** Puts a field at the cursor, with a space before it when needed. */
function insertAt(el: HTMLTextAreaElement | HTMLInputElement | null, value: string, insert: string, set: (v: string) => void) {
    const at = el?.selectionStart ?? value.length;
    const before = value.slice(0, at);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    set(`${before}${pad}${insert}${value.slice(at)}`);
    requestAnimationFrame(() => { el?.focus(); const p = at + pad.length + insert.length; el?.setSelectionRange(p, p); });
}

const MARKS: { mark: string; label: string; Icon: React.ElementType }[] = [
    { mark: '*', label: 'Bold', Icon: Bold }, { mark: '_', label: 'Italic', Icon: Italic }, { mark: '~', label: 'Strikethrough', Icon: Strikethrough }, { mark: '```', label: 'Monospace', Icon: Code },
];

/** The field buttons under a text box, and a box for a field of your own. */
const FieldInserter: React.FC<{ target: string; onInsert: (field: string) => void; extra: string[] }> = ({ target, onInsert, extra }) => {
    const [own, setOwn] = useState('');
    const slug = own.toLowerCase().trim().replaceAll(/[^a-z0-9]+/g, '_').replace(/^_/, '').slice(0, 30);
    const add = () => { if (/^[a-z]/.test(slug)) { onInsert(slug); setOwn(''); } };
    return (
        <div className="flex flex-wrap items-center gap-2 mt-2">
            {[...FIELDS, ...extra.filter(f => !(FIELDS as readonly string[]).includes(f))].map(f => <Pill key={f} onClick={() => onInsert(f)}>+ {fieldLabel(f)}</Pill>)}
            <span className="inline-flex items-center gap-1">
                <Input aria-label={`Your own field for the ${target}`} placeholder="Own field, like offer" value={own} onChange={e => setOwn(e.target.value)} className="!w-40 !py-1.5 text-[13px]"
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
                <GhostIconButton label={`Add this field to the ${target}`} disabled={!/^[a-z]/.test(slug)} onClick={add} icon={<Plus size={14} />} />
            </span>
        </div>
    );
};

const BUTTON_ORDER: ButtonKind[] = ['quick_reply', 'url', 'phone', 'copy_code'];

/** One button being written: its words, and its link or phone number. */
const ButtonEditor: React.FC<{ b: TemplateButton; index: number; onChange: (b: TemplateButton) => void; onRemove: () => void }> = ({ b, index, onChange, onRemove }) => {
    const Icon = BUTTON_ICON[b.kind];
    const id = `btn-${index}`;
    return (
        <div className="neu-inset rounded-xl p-3 space-y-2">
            <div className="flex items-center gap-2">
                <Icon size={14} className="text-gold-600 dark:text-gold-400 shrink-0" aria-hidden />
                <span className="flex-1 text-[12px] font-semibold uppercase tracking-wider text-[var(--neu-text-dim)]">{BUTTON_LIMITS[b.kind].label}</span>
                <GhostIconButton label="Remove this button" onClick={onRemove} icon={<X size={14} />} />
            </div>
            {b.kind === 'copy_code'
                ? <Field label="Example code" htmlFor={`${id}-t`} hint="The real code is typed when you send."><Input id={`${id}-t`} maxLength={15} value={b.text} onChange={e => onChange({ ...b, text: e.target.value })} placeholder="DIWALI20" /></Field>
                : <Field label="Button words" htmlFor={`${id}-t`} hint={`${b.text.length} / 25`}><Input id={`${id}-t`} maxLength={25} value={b.text} onChange={e => onChange({ ...b, text: e.target.value })} /></Field>}
            {b.kind === 'url' && (
                <Field label="Link" htmlFor={`${id}-u`} hint="May end with one field, like https://vayu.in/rsvp/{{code}}, filled in when you send.">
                    <Input id={`${id}-u`} type="url" inputMode="url" value={b.url ?? ''} onChange={e => onChange({ ...b, url: e.target.value })} placeholder="https://" />
                </Field>
            )}
            {b.kind === 'phone' && (
                <Field label="Phone number" htmlFor={`${id}-p`}><Input id={`${id}-p`} type="tel" inputMode="tel" value={b.phone ?? ''} onChange={e => onChange({ ...b, phone: e.target.value })} placeholder="+91 98765 43210" /></Field>
            )}
        </div>
    );
};

const newButton = (kind: ButtonKind): TemplateButton => {
    if (kind === 'url') return { kind, text: 'See the show', url: 'https://' };
    if (kind === 'phone') return { kind, text: 'Call us', phone: '+91' };
    if (kind === 'copy_code') return { kind, text: 'INVITE' };
    return { kind, text: '' };
};

const ButtonsEditor: React.FC<{ buttons: TemplateButton[]; onChange: (b: TemplateButton[]) => void }> = ({ buttons, onChange }) => {
    const left = (kind: ButtonKind) => buttons.length < MAX_BUTTONS && buttons.filter(b => b.kind === kind).length < BUTTON_LIMITS[kind].max;
    const hasRsvp = buttons.some(b => b.text === RSVP_YES) && buttons.some(b => b.text === RSVP_NO);
    return (
        <div className="space-y-2">
            {buttons.map((b, i) => (
                <ButtonEditor key={`${b.kind}-${i}`} b={b} index={i} onChange={nb => onChange(buttons.map((x, j) => (j === i ? nb : x)))} onRemove={() => onChange(buttons.filter((_, j) => j !== i))} />
            ))}
            <div className="flex flex-wrap gap-2">
                {!hasRsvp && buttons.length <= MAX_BUTTONS - 2 && <Pill onClick={() => onChange([...RSVP_BUTTONS, ...buttons])}>+ RSVP (Yes / No)</Pill>}
                {BUTTON_ORDER.filter(left).map(k => <Pill key={k} onClick={() => onChange([...buttons, newButton(k)])}>+ {BUTTON_LIMITS[k].label}</Pill>)}
            </div>
            <p className="text-[11.5px] text-[var(--neu-text-dim)]">Up to {MAX_BUTTONS} buttons: 2 website links, 1 phone number and 1 offer code at most. Quick replies are shown first.</p>
        </div>
    );
};

/** Examples for fields without a ready one: reviewers need to see what goes there. */
const SamplesEditor: React.FC<{ fields: string[]; samples: FieldValues; onChange: (s: FieldValues) => void }> = ({ fields, samples, onChange }) => (
    fields.length ? (
        <div className="space-y-3">
            <SectionTitle>Examples for review</SectionTitle>
            {fields.map(f => (
                <Field key={f} label={`Example for {{${f}}}`} htmlFor={`sample-${f}`}>
                    <Input id={`sample-${f}`} maxLength={200} value={samples[f] ?? ''} onChange={e => onChange({ ...samples, [f]: e.target.value })} />
                </Field>
            ))}
        </div>
    ) : null
);

interface Draft extends TemplateInput { title: string }

const blankDraft = (channel: Channel): Draft => ({
    channel, title: STARTERS[0].title, name: '', language: 'en', category: 'MARKETING', header: 'none', headerText: channel === 'email' ? STARTERS[0].subject : '',
    body: STARTERS[0].body, footer: channel === 'email' ? '' : 'Reply STOP to opt out', buttons: RSVP_BUTTONS, samples: {},
});

/** The parts only a WhatsApp template has: category, header, small print, buttons. */
const WhatsappParts: React.FC<{ d: Draft; set: (p: Partial<Draft>) => void; sample: string[]; setSample: (u: string[]) => void; setUploading: (b: boolean) => void; extra: string[] }> = ({ d, set, sample, setSample, setUploading, extra }) => {
    const headerRef = useRef<HTMLInputElement>(null);
    return (
        <>
            <div className="grid sm:grid-cols-2 gap-3">
                <Field label="Category" htmlFor="tpl-cat" hint={d.category === 'MARKETING' ? 'Invites, offers and news' : 'Updates on something they asked for'}>
                    <Select id="tpl-cat" value={d.category} onChange={e => set({ category: e.target.value as Category })}>
                        {Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </Select>
                </Field>
                <Field label="Header (optional)" htmlFor="tpl-head">
                    <Select id="tpl-head" value={d.header} onChange={e => { set({ header: e.target.value as HeaderKind }); setSample([]); }}>
                        {Object.entries(HEADERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </Select>
                </Field>
            </div>
            {d.header === 'text' && (
                <Field label="Header text" htmlFor="tpl-htext" hint={`${d.headerText.length} / ${MAX_HEADER_TEXT}. May hold one field.`}>
                    <Input ref={headerRef} id="tpl-htext" maxLength={MAX_HEADER_TEXT} value={d.headerText} onChange={e => set({ headerText: e.target.value })} placeholder="You’re invited: {{event}}" />
                    <FieldInserter target="header" extra={extra} onInsert={f => insertAt(headerRef.current, d.headerText, `{{${f}}}`, v => set({ headerText: v }))} />
                </Field>
            )}
            {MEDIA_HEADERS.has(d.header) && (
                <Field label={`One sample ${d.header} for Meta’s review (${MEDIA_RULES[d.header]?.words})`}>
                    <MediaPicker kind={d.header} urls={sample} onChange={setSample} onUploadingChange={setUploading} />
                    <p className="mt-1 text-[11px] text-[var(--neu-text-dim)]">You choose the real one each time you send.</p>
                </Field>
            )}
            {d.header === 'location' && <p className="text-[12px] text-[var(--neu-text-dim)]">The place (name, address and map point) is given each time you send.</p>}
            <Field label="Small print (optional)" htmlFor="tpl-footer" hint={`${d.footer.length} / ${MAX_FOOTER}`}><Input id="tpl-footer" maxLength={MAX_FOOTER} value={d.footer} onChange={e => set({ footer: e.target.value })} /></Field>
            <Field label="Buttons (optional)"><ButtonsEditor buttons={d.buttons} onChange={buttons => set({ buttons })} /></Field>
        </>
    );
};

/** The parts only an email has: the subject line, and a picture and RSVP buttons by switch. */
const EmailParts: React.FC<{ d: Draft; set: (p: Partial<Draft>) => void; extra: string[] }> = ({ d, set, extra }) => {
    const subjectRef = useRef<HTMLInputElement>(null);
    return (
        <>
            <Field label="Subject line" htmlFor="tpl-subject">
                <Input ref={subjectRef} id="tpl-subject" maxLength={150} value={d.headerText} onChange={e => set({ headerText: e.target.value })} />
                <FieldInserter target="subject" extra={extra} onInsert={f => insertAt(subjectRef.current, d.headerText, `{{${f}}}`, v => set({ headerText: v }))} />
            </Field>
            <ToggleRow title="Picture on top" description="You choose the picture each time you send" checked={d.header === 'image'} onChange={() => set({ header: d.header === 'image' ? 'none' : 'image' })} />
            <ToggleRow title="RSVP buttons" description={`“${RSVP_YES}” and “${RSVP_NO}”; answers show on the invite`} checked={d.buttons.length > 0} onChange={() => set({ buttons: d.buttons.length ? [] : RSVP_BUTTONS })} />
            <p className="text-[11.5px] text-[var(--neu-text-dim)]">Every email ends with your name and an unsubscribe link; people who unsubscribe aren’t emailed again.</p>
        </>
    );
};

export const TemplateForm: React.FC<{ channel: Channel; sender?: string; onDone: () => void; onChannel?: (c: Channel) => void; channels?: Channel[] }> = ({ channel, sender, onDone, onChannel, channels = [] }) => {
    const [d, setD] = useState<Draft>(() => blankDraft(channel));
    const [sample, setSample] = useState<string[]>([]);
    const [uploading, setUploading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState('');
    const bodyRef = useRef<HTMLTextAreaElement>(null);
    const set = (p: Partial<Draft>) => { setD(x => ({ ...x, ...p })); setProblem(''); };
    // Fields already used anywhere, so the inserter offers them again.
    const used = [...new Set([...templateFields(d.body), ...templateFields(d.headerText)])];
    const needSamples = fieldsNeedingSamples(d);
    const isEmail = channel === 'email';

    // WhatsApp wants a unique name per template: the date keeps a second "Exhibition opening" from clashing.
    const name = templateSlug(`${d.title} ${new Date().toISOString().slice(2, 10)}`);
    const submit = async () => {
        const t = parseTemplate({ ...d, name });
        if ('problem' in t) { setProblem(t.problem); return; }
        if (!isEmail && MEDIA_HEADERS.has(t.header) && !sample[0]) { setProblem(`Add a sample ${t.header}: Meta wants to see one when it reviews the template.`); return; }
        setBusy(true);
        try {
            await socialService.createTemplate({ ...t, sampleImageUrl: sample[0] });
            toast.success(isEmail ? 'Saved and sent to MSG91' : 'Sent to Meta for approval');
            onDone();
        } catch (e) { setProblem(message(e)); setBusy(false); }
    };

    return (
        <PageRoot width="wide">
            <PageHeader title={isEmail ? 'New email template' : 'New WhatsApp template'} onBack={onDone} />
            <PageBody>
                <div className="grid lg:grid-cols-2 gap-4 lg:items-start">
                    <form className="neu-card p-4 lg:p-5 space-y-4 text-[var(--neu-text)]" onSubmit={e => { e.preventDefault(); void submit(); }}>
                        {onChannel && channels.length > 1 && (
                            <Field label="For">
                                <div className="flex gap-2 mt-1">
                                    {channels.map(c => <Pill key={c} active={c === channel} onClick={() => onChannel(c)}>{React.createElement(CHANNEL_ICON[c], { size: 13, className: 'inline -mt-0.5 mr-1', 'aria-hidden': true })}{CHANNEL_NAME[c]}</Pill>)}
                                </div>
                            </Field>
                        )}
                        <Field label="Start from">
                            <div className="flex flex-wrap gap-2 mt-1">
                                {STARTERS.map(s => <Pill key={s.title} active={d.title === s.title && d.body === s.body} onClick={() => set({ title: s.title, body: s.body, ...(isEmail ? { headerText: s.subject } : {}) })}>{s.title}</Pill>)}
                            </div>
                        </Field>
                        <div className="grid sm:grid-cols-2 gap-3">
                            <Field label="Name (only your team sees this)" htmlFor="tpl-title"><Input id="tpl-title" maxLength={40} value={d.title} onChange={e => set({ title: e.target.value })} /></Field>
                            <Field label="Language" htmlFor="tpl-lang">
                                <Select id="tpl-lang" value={d.language} onChange={e => set({ language: e.target.value })}>
                                    {Object.entries(LANGUAGES).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                                </Select>
                            </Field>
                        </div>
                        {isEmail && <EmailParts d={d} set={set} extra={used} />}
                        <Field label="Message" htmlFor="tpl-body" hint={`${d.body.length} / ${isEmail ? MAX_EMAIL_BODY : MAX_BODY}. Tap a field to put it at the cursor; each person gets their own name.`}>
                            {!isEmail && (
                                <div className="flex gap-1 mb-1.5" role="toolbar" aria-label="Formatting">
                                    {MARKS.map(m => <GhostIconButton key={m.label} label={m.label} onClick={() => wrapSelection(bodyRef.current, d.body, m.mark, v => set({ body: v }))} icon={<m.Icon size={14} />} />)}
                                </div>
                            )}
                            <Textarea ref={bodyRef} id="tpl-body" rows={isEmail ? 9 : 6} maxLength={isEmail ? MAX_EMAIL_BODY : MAX_BODY} value={d.body} onChange={e => set({ body: e.target.value })} />
                            <FieldInserter target="message" extra={used} onInsert={f => insertAt(bodyRef.current, d.body, `{{${f}}}`, v => set({ body: v }))} />
                        </Field>
                        {!isEmail && <WhatsappParts d={d} set={set} sample={sample} setSample={setSample} setUploading={setUploading} extra={used} />}
                        <SamplesEditor fields={needSamples} samples={d.samples} onChange={samples => set({ samples })} />
                        <Problem>{problem}</Problem>
                        <Button type="submit" variant="primary" block disabled={busy || uploading} icon={busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}>
                            {busy ? 'Sending…' : 'Send for approval'}
                        </Button>
                        <p className="text-[11.5px] text-[var(--neu-text-dim)]">{isEmail
                            ? 'MSG91 checks new email templates before they can be sent. It can’t be changed afterwards; make a new one instead.'
                            : 'Meta reviews every template, usually within a day. It can’t be changed afterwards; make a new one instead.'}</p>
                    </form>
                    <section className="lg:sticky lg:top-4">
                        <SectionTitle className="px-3">Preview</SectionTitle>
                        <TemplatePreview t={d} mediaUrl={sample[0]} values={{ ...SAMPLE, ...d.samples, name: SAMPLE.name }} sender={sender} />
                        {used.some(f => !sampleOf(f, d.samples)) && <p className="mt-2 px-3 text-[11.5px] text-[var(--neu-text-dim)]">Fields without an example show as {'{{field}}'}.</p>}
                    </section>
                </div>
            </PageBody>
        </PageRoot>
    );
};

