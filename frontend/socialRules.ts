// Invites (WhatsApp and email, through each workspace's MSG91 account): the
// rules shared by the Worker (social.ts) and the app (views/SocialInvitesView.tsx).
// No dependencies, no I/O: what a template may hold, how its named fields
// become WhatsApp's {{1}} {{2}}, what is sent to MSG91 and how its delivery
// reports are read.
//
// Formats confirmed against a live MSG91 account (2026-11-11): the WhatsApp
// number list and template list. Taken from MSG91's docs, not yet tried with
// a real send: headers other than text and image, button values, location,
// and email sending and reports (docs/IMPLEMENTATION_PLAN.md 8.5, 8.6).

export type Channel = 'whatsapp' | 'email';
export type Category = 'MARKETING' | 'UTILITY';
export type HeaderKind = 'none' | 'text' | 'image' | 'video' | 'document' | 'location';
export type ButtonKind = 'quick_reply' | 'url' | 'phone' | 'copy_code';
/** url: may end with one field ("https://site/{{code}}"); copy_code: `text` is an example code. */
export interface TemplateButton { kind: ButtonKind; text: string; url?: string; phone?: string }

/** Fields with a ready example. `name` is each person's own; any other field is typed when sending. */
export const FIELDS = ['name', 'event', 'date', 'venue'] as const;
export type FieldName = typeof FIELDS[number];
/** What each field says in one invite: by field name, "1", "2"… in a template from MSG91's panel, `button_N`, `location_*`. */
export type FieldValues = Partial<Record<string, string>>;
/** In a typed value, stands for each person's own first name. */
export const NAME_TOKEN = '{{name}}';

/** What Meta's reviewers (and the preview) see in place of each field. */
export const SAMPLE: Record<FieldName, string> = { name: 'Anjali', event: 'Monsoon Show', date: '14 Nov, 6 pm', venue: 'Vayu Gallery, Mumbai' };

export const LANGUAGES: Record<string, string> = {
    en: 'English', en_US: 'English (US)', en_GB: 'English (UK)', hi: 'Hindi', bn: 'Bengali', gu: 'Gujarati', kn: 'Kannada', ml: 'Malayalam',
    mr: 'Marathi', pa: 'Punjabi', ta: 'Tamil', te: 'Telugu', ur: 'Urdu', ar: 'Arabic', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian',
};
export const CATEGORIES: Record<Category, string> = { MARKETING: 'Marketing', UTILITY: 'Utility' };
export const HEADERS: Record<HeaderKind, string> = { none: 'None', text: 'Text', image: 'Image', video: 'Video', document: 'Document', location: 'Location' };
export const MEDIA_HEADERS: ReadonlySet<HeaderKind> = new Set(['image', 'video', 'document']);
/** What WhatsApp takes as each kind of header file. */
export const MEDIA_RULES: Partial<Record<HeaderKind, { types: RegExp; maxMb: number; accept: string; words: string }>> = {
    image: { types: /^image\/(jpeg|png)$/, maxMb: 5, accept: 'image/jpeg,image/png', words: 'JPG or PNG, up to 5 MB' },
    video: { types: /^video\/(mp4|3gpp)$/, maxMb: 16, accept: 'video/mp4,video/3gpp', words: 'MP4, up to 16 MB' },
    document: { types: /^application\/pdf$/, maxMb: 100, accept: 'application/pdf', words: 'PDF, up to 100 MB' },
};
export const BUTTON_LIMITS: Record<ButtonKind, { label: string; max: number }> = {
    quick_reply: { label: 'Quick reply', max: 10 }, url: { label: 'Visit website', max: 2 }, phone: { label: 'Call phone number', max: 1 }, copy_code: { label: 'Copy offer code', max: 1 },
};
export const MAX_BUTTONS = 10;

export const RSVP_YES = 'Yes, I’ll come';
export const RSVP_NO = 'Can’t make it';
export const RSVP_BUTTONS: TemplateButton[] = [{ kind: 'quick_reply', text: RSVP_YES }, { kind: 'quick_reply', text: RSVP_NO }];
export const MAX_BODY = 1024;
export const MAX_EMAIL_BODY = 5000;
export const MAX_FOOTER = 60;
export const MAX_HEADER_TEXT = 60;
/** shortcut: one invite reaches at most this many people; make it a plan limit when plans price invites. */
export const MAX_RECIPIENTS = 2000;

export type TemplateStatus = 'pending' | 'approved' | 'rejected';
export interface TemplateInput {
    channel: Channel; name: string; language: string; category: Category;
    /** Email: 'image' or 'none'. */
    header: HeaderKind;
    /** WhatsApp: the text header; email: the subject line. */
    headerText: string;
    body: string; footer: string;
    /** Email: only the RSVP pair. */
    buttons: TemplateButton[];
    /** Examples for fields without a ready one, and for button fields (Meta's review needs them). */
    samples: FieldValues;
}
export interface SocialTemplate extends TemplateInput { id: string; status: TemplateStatus; reason: string; createdAt: number }

export type RecipientStatus = 'queued' | 'submitted' | 'sent' | 'delivered' | 'read' | 'failed';
export type Rsvp = '' | 'yes' | 'no';
/** `phone` holds the email address for an email invite. */
export interface Recipient { id: string; name: string; phone: string; status: RecipientStatus; reason: string; rsvp: Rsvp; at: number }
export type Counts = Record<RecipientStatus, number> & { total: number; yes: number; no: number };
export interface Invite {
    id: string; channel: Channel; name: string; templateId: string; templateName: string; tagIds: string[]; values: FieldValues; imageUrl: string;
    status: 'scheduled' | 'sending' | 'sent'; sendAt: number; createdAt: number; createdByName: string; counts: Counts;
}
/** `imageUrl`: the header file (picture, video or PDF) chosen for this invite. */
export interface InviteInput { name: string; templateId: string; tagIds: string[]; values: FieldValues; imageUrl: string; sendAt: number }

export const STATUS_LABEL: Record<RecipientStatus, string> = { queued: 'Queued', submitted: 'Sending', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed' };
/** "Read" on WhatsApp is "Opened" on email. */
export const readLabel = (c: Channel) => (c === 'email' ? 'Opened' : 'Read');

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
/** {{ anything }}; what is inside is trimmed by `inner`. */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const inner = (m: RegExpMatchArray | string) => (typeof m === 'string' ? m : m[1]).trim();
const FIELD_NAME = /^[a-z][a-z0-9_]{0,29}$/;
const isNumbered = (f: string) => /^\d{1,2}$/.test(f);
const isKnown = (f: string): f is FieldName => (FIELDS as readonly string[]).includes(f);

/** The fields a text uses, in the order they first appear (that order is their WhatsApp number). */
export function templateFields(body: string): string[] {
    const found: string[] = [];
    for (const m of body.matchAll(PLACEHOLDER)) {
        const f = inner(m);
        if ((FIELD_NAME.test(f) || isNumbered(f)) && !found.includes(f)) found.push(f);
    }
    return found;
}

/** A field's WhatsApp number: its own for "1", "2"…; for a named field, its place in the text. */
const position = (fields: string[], f: string): number => (isNumbered(f) ? Number(f) : fields.indexOf(f) + 1);

/** "Hello {{name}}" → "Hello {{1}}". */
export const numberedBody = (body: string): string => {
    const fields = templateFields(body);
    const numberOf = (f: string) => String(position(fields, f));
    return body.replace(PLACEHOLDER, (m, raw: string) => (fields.includes(inner(raw)) ? `{{${numberOf(inner(raw))}}}` : m));
};

/** A field's words for one person: their first name for `name`, and wherever a typed value says {{name}}. */
const valueFor = (f: string, values: FieldValues, name: string): string =>
    (f === 'name' ? name : (values[f] ?? '').replaceAll(NAME_TOKEN, name));

/** A field's example: a ready one, the template's own, or the field as written. */
export const sampleOf = (f: string, samples: FieldValues = {}): string => samples[f] || (isKnown(f) ? SAMPLE[f] : '');

/** A text as one person reads it; a field not filled in yet shows its example, or stays as written. */
export const filledBody = (body: string, values: FieldValues, samples: FieldValues = {}): string =>
    body.replace(PLACEHOLDER, (m, raw: string) => valueFor(inner(raw), values, values.name || SAMPLE.name) || sampleOf(inner(raw), samples) || m);

/** "Summer Show invite!" → "summer_show_invite": the only spelling WhatsApp takes for a template's name. */
export const templateSlug = (title: string): string =>
    title.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_').replace(/^_/, '').replace(/_$/, '').slice(0, 60);

/** "exhibition_opening_26_11_11" → "Exhibition opening": the name people gave it, without the date that keeps it unique. */
export function templateTitle(name: string): string {
    const words = name.replace(/_\d{2}_\d{2}_\d{2}$/, '').replaceAll('_', ' ').trim();
    return words ? words[0].toUpperCase() + words.slice(1) : name;
}

/** What a field is called on screen: "event", or "field 2" in a template from MSG91's panel. */
export const fieldLabel = (f: string): string => (isNumbered(f) ? `field ${f}` : f.replaceAll('_', ' '));

// ── Checking a template ─────────────────────────────────────────────────────

/** The one field a text header or a website link may hold, or ''. */
export const singleField = (s: string): string => templateFields(s)[0] ?? '';

function parseButton(raw: unknown): TemplateButton | null {
    const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const kind = b.kind as ButtonKind;
    if (!Object.hasOwn(BUTTON_LIMITS, kind)) return null;
    return { kind, text: str(b.text, 30), ...(kind === 'url' ? { url: str(b.url, 2000) } : {}), ...(kind === 'phone' ? { phone: str(b.phone, 20) } : {}) };
}

function buttonProblem(b: TemplateButton): string | null {
    if (b.kind === 'copy_code') return /^[A-Za-z0-9]{1,15}$/.test(b.text) ? null : 'The offer code example can be up to 15 letters and numbers.';
    if (!b.text) return 'Give every button its words.';
    if (b.text.length > 25) return `"${b.text}" is too long for a button: up to 25 characters.`;
    if (b.kind === 'phone' && !/^\+\d{8,15}$/.test((b.phone ?? '').replaceAll(/[\s-]/g, ''))) return 'Give the button’s phone number with + and the country code.';
    if (b.kind === 'url') {
        const url = b.url ?? '';
        if (!/^https?:\/\/[^\s{}]+\.[^\s{}]*/.test(url)) return 'Give each website button a full link starting with https://.';
        const fields = templateFields(url);
        if (fields.length > 1 || (fields.length === 1 && !url.trimEnd().endsWith('}}'))) return 'A website link may hold one field, only at its end.';
    }
    return null;
}

/** Quick replies first: WhatsApp doesn't allow them mixed in among the other buttons. */
const ordered = (buttons: TemplateButton[]) => [...buttons.filter(b => b.kind === 'quick_reply'), ...buttons.filter(b => b.kind !== 'quick_reply')];

function buttonsProblem(buttons: TemplateButton[]): string | null {
    if (buttons.length > MAX_BUTTONS) return `A template can have up to ${MAX_BUTTONS} buttons.`;
    for (const [kind, { label, max }] of Object.entries(BUTTON_LIMITS)) {
        const plural = max > 1 ? 's' : '';
        if (buttons.filter(b => b.kind === kind).length > max) return `Up to ${max} “${label}” button${plural}.`;
    }
    for (const b of buttons) {
        const p = buttonProblem(b);
        if (p) return p;
    }
    return null;
}

function bodyProblem(body: string, max: number): string | null {
    if (body.length < 10) return 'Write the message.';
    if (body.length > max) return `The message can be up to ${max} characters.`;
    const odd = [...body.matchAll(PLACEHOLDER)].find(m => !FIELD_NAME.test(inner(m)));
    if (odd) return `"${odd[0]}" is not a field. Use small letters and underscores, like {{event}} or {{offer_code}}.`;
    return null;
}

function whatsappProblem(t: TemplateInput): string | null {
    if (/^\{\{[^{}]*\}\}/.test(t.body) || /\{\{[^{}]*\}\}$/.test(t.body)) return 'WhatsApp does not allow a message to start or end with a field. Add a word before or after it.';
    if (/\}\}\s*\{\{/.test(t.body)) return 'Put some words between two fields.';
    if (/\n{3,}/.test(t.body)) return 'Leave at most one empty line between paragraphs.';
    if (t.header === 'text') {
        if (!t.headerText) return 'Write the header, or choose no header.';
        if (t.headerText.length > MAX_HEADER_TEXT) return `The header can be up to ${MAX_HEADER_TEXT} characters.`;
        if (templateFields(t.headerText).length > 1) return 'The header may hold one field at most.';
    }
    if (t.footer.length > MAX_FOOTER) return `The small print can be up to ${MAX_FOOTER} characters.`;
    if (/\{\{/.test(t.footer)) return 'The small print cannot use fields.';
    return buttonsProblem(t.buttons);
}

/** The parts that decide what a template needs filled in. */
export type TemplateParts = Pick<TemplateInput, 'body' | 'header' | 'headerText' | 'buttons' | 'channel'>;

/** The fields whose examples must be given: those without a ready one, in the body, header and links. */
export const fieldsNeedingSamples = (t: TemplateParts): string[] => {
    const fromHeader = t.header === 'text' || t.channel === 'email' ? templateFields(t.headerText) : [];
    const fromLinks = t.buttons.flatMap(b => (b.kind === 'url' ? templateFields(b.url ?? '') : []));
    return [...new Set([...templateFields(t.body), ...fromHeader, ...fromLinks])].filter(f => !isKnown(f));
};

/** The template as sent, trimmed and limited; an email keeps only a picture header and the RSVP pair. */
function draftOf(r: Record<string, unknown>): TemplateInput {
    const channel: Channel = r.channel === 'email' ? 'email' : 'whatsapp';
    const email = channel === 'email';
    const header = (Object.hasOwn(HEADERS, r.header as string) ? r.header : 'none') as HeaderKind;
    const buttons = ordered((Array.isArray(r.buttons) ? r.buttons : []).slice(0, MAX_BUTTONS + 1).map(parseButton).filter((b): b is TemplateButton => !!b));
    const emailButtons = buttons.length ? RSVP_BUTTONS : [];
    return {
        channel, name: str(r.name, 60), language: str(r.language, 10) || 'en', category: r.category === 'UTILITY' ? 'UTILITY' : 'MARKETING',
        header: email && header !== 'image' ? 'none' : header, headerText: str(r.headerText, 200),
        body: str(r.body, MAX_EMAIL_BODY + 1), footer: email ? '' : str(r.footer, MAX_FOOTER + 1),
        buttons: email ? emailButtons : buttons, samples: {},
    };
}

function draftProblem(t: TemplateInput): string | null {
    if (!/^[a-z][a-z0-9_]{2,59}$/.test(t.name)) return 'Give the template a name: small letters, numbers and underscores, at least 3 characters.';
    if (!Object.hasOwn(LANGUAGES, t.language)) return 'Choose a language.';
    if (t.channel === 'email') return t.headerText ? bodyProblem(t.body, MAX_EMAIL_BODY) : 'Write the subject line.';
    return bodyProblem(t.body, MAX_BODY) ?? whatsappProblem(t);
}

/** A template as typed, checked against WhatsApp's (or the email's) rules so a review rarely refuses it. */
export function parseTemplate(raw: unknown): TemplateInput | { problem: string } {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const t = draftOf(r);
    const problem = draftProblem(t);
    if (problem) return { problem };
    const samplesIn = (r.samples && typeof r.samples === 'object' ? r.samples : {}) as Record<string, unknown>;
    for (const f of fieldsNeedingSamples(t)) {
        const s = str(samplesIn[f], 200);
        if (!s) return { problem: `Give an example for {{${f}}}: reviewers want to see one.` };
        t.samples[f] = s;
    }
    return t;
}

/** A website link with its field filled: Meta wants the whole link as an example. */
const exampleUrl = (url: string, samples: FieldValues) => url.replace(PLACEHOLDER, (_m, raw: string) => sampleOf(inner(raw), samples));

function buttonComponent(b: TemplateButton, samples: FieldValues): Record<string, unknown> {
    if (b.kind === 'quick_reply') return { type: 'QUICK_REPLY', text: b.text };
    if (b.kind === 'phone') return { type: 'PHONE_NUMBER', text: b.text, phone_number: (b.phone ?? '').replaceAll(/[\s-]/g, '') };
    if (b.kind === 'copy_code') return { type: 'COPY_CODE', example: b.text };
    const url = b.url ?? '';
    return { type: 'URL', text: b.text, url: numberedBody(url), ...(singleField(url) ? { example: [exampleUrl(url, samples)] } : {}) };
}

function headerComponent(t: TemplateInput, mediaSampleUrl: string): Record<string, unknown>[] {
    if (t.header === 'none') return [];
    if (t.header === 'location') return [{ type: 'HEADER', format: 'LOCATION' }];
    if (t.header === 'text') {
        const f = singleField(t.headerText);
        return [{ type: 'HEADER', format: 'TEXT', text: numberedBody(t.headerText), ...(f ? { example: { header_text: [sampleOf(f, t.samples)] } } : {}) }];
    }
    return [{ type: 'HEADER', format: t.header.toUpperCase(), example: { header_handle: [mediaSampleUrl] } }];
}

/** What MSG91 is sent to create a WhatsApp template (it passes it to Meta for review). */
export function createTemplatePayload(number: string, t: TemplateInput, mediaSampleUrl: string): Record<string, unknown> {
    const fields = templateFields(t.body);
    return {
        integrated_number: number, template_name: t.name, language: t.language, category: t.category, button_url: false,
        components: [
            ...headerComponent(t, mediaSampleUrl),
            { type: 'BODY', text: numberedBody(t.body), ...(fields.length ? { example: { body_text: [fields.map(f => sampleOf(f, t.samples))] } } : {}) },
            ...(t.footer ? [{ type: 'FOOTER', text: t.footer }] : []),
            ...(t.buttons.length ? [{ type: 'BUTTONS', buttons: t.buttons.map(b => buttonComponent(b, t.samples)) }] : []),
        ],
    };
}

const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'shri', 'smt', 'sri', 'm/s']);

/** "Anjali Mehta" → "Anjali"; "Dr. Mehta" stays whole; nobody saved → "there" ("Hello there"). */
export function firstName(full: string): string {
    const words = full.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return 'there';
    return TITLES.has(words[0].toLowerCase().replace(/\.$/, '')) ? words.join(' ') : words[0];
}

// ── What sending needs ──────────────────────────────────────────────────────

/** The value key of the text header's field ("h1" for a numbered one), or ''. */
export const headerField = (t: Pick<TemplateInput, 'header' | 'headerText'>): string => {
    const f = t.header === 'text' ? singleField(t.headerText) : '';
    return isNumbered(f) ? 'h1' : f;
};
/** Buttons whose words are filled when sending: a website link ending in a field, or an offer code. */
const dynamicButton = (b: TemplateButton) => b.kind === 'copy_code' || (b.kind === 'url' && !!singleField(b.url ?? ''));
export const LOCATION_KEYS = ['location_lat', 'location_lng', 'location_name', 'location_address'] as const;

export interface Slot { key: string; label: string; hint?: string }

/** Everything typed when sending this template, in screen order (the person's own name is never typed). */
export function sendSlots(t: TemplateParts): Slot[] {
    const hf = t.channel === 'email' ? '' : headerField(t);
    const subject = t.channel === 'email' ? templateFields(t.headerText) : [];
    const body = [...new Set([...subject, ...templateFields(t.body)])].filter(f => f !== 'name' && f !== hf);
    return [
        ...(hf && hf !== 'name' ? [{ key: hf, label: hf === 'h1' ? 'Header field' : fieldLabel(hf) }] : []),
        ...body.map(f => ({ key: f, label: fieldLabel(f) })),
        ...(t.header === 'location' ? [
            { key: 'location_name', label: 'Place name' }, { key: 'location_address', label: 'Address' },
            { key: 'location_lat', label: 'Latitude', hint: 'Like 19.0760' }, { key: 'location_lng', label: 'Longitude', hint: 'Like 72.8777' },
        ] : []),
        ...t.buttons.flatMap((b, i) => (dynamicButton(b) ? [{ key: `button_${i + 1}`, label: b.kind === 'copy_code' ? 'Offer code' : `End of the “${b.text}” link` }] : [])),
    ];
}

/** What sending needs that isn't given: a field left empty, the location, or the header file. */
export function inviteProblem(t: TemplateParts, values: FieldValues, mediaUrl: string): string | null {
    const empty = sendSlots(t).find(s => !values[s.key]?.trim());
    if (empty) return `Fill in "${empty.label}".`;
    if (t.header === 'location' && [values.location_lat, values.location_lng].some(v => !Number.isFinite(Number(v)) || v!.trim() === '')) return 'Give the latitude and longitude as numbers.';
    const what = t.header === 'image' ? 'a picture' : `a ${t.header}`;
    if (MEDIA_HEADERS.has(t.header) && !mediaUrl) return `This template has ${what} on top. Add one.`;
    return null;
}

/** The header as MSG91 sends it, or null for no header (or a text header without a field). */
function headerParam(t: Pick<TemplateInput, 'header' | 'headerText'>, values: FieldValues, mediaUrl: string, name: string): Record<string, unknown> | null {
    if (MEDIA_HEADERS.has(t.header)) return mediaUrl ? { type: t.header, value: mediaUrl, ...(t.header === 'document' ? { filename: 'Invitation.pdf' } : {}) } : null;
    if (t.header === 'location') {
        return { type: 'location', latitude: values.location_lat, longitude: values.location_lng, name: values.location_name, address: values.location_address };
    }
    const f = headerField(t);
    return f ? { type: 'text', value: valueFor(f, values, name).slice(0, 60) } : null;
}

/** One bulk request to MSG91: each person has their own entry, so each gets their own name. */
export function sendPayload(opts: {
    number: string; template: Pick<TemplateInput, 'name' | 'language' | 'body' | 'header' | 'headerText' | 'buttons'>; namespace: string;
    values: FieldValues; imageUrl: string; recipients: { id: string; phone: string; name: string }[];
}): Record<string, unknown> {
    const { template: t, values } = opts;
    const fields = templateFields(t.body);
    const components = (name: string) => {
        const header = headerParam(t, values, opts.imageUrl, name);
        return {
            ...(header ? { header_1: header } : {}),
            ...Object.fromEntries(fields.map(f => [`body_${position(fields, f)}`, { type: 'text', value: valueFor(f, values, name).slice(0, 200) }])),
            ...Object.fromEntries(t.buttons.flatMap((b, i) => (dynamicButton(b)
                ? [[`button_${i + 1}`, { subtype: b.kind === 'copy_code' ? 'COPY_CODE' : 'url', type: b.kind === 'copy_code' ? 'coupon_code' : 'text', value: values[`button_${i + 1}`] ?? '' }]]
                : []))),
        };
    };
    return {
        integrated_number: opts.number, content_type: 'template',
        payload: {
            messaging_product: 'whatsapp', type: 'template',
            template: {
                name: t.name, language: { code: t.language, policy: 'deterministic' },
                ...(opts.namespace ? { namespace: opts.namespace } : {}),
                to_and_components: opts.recipients.map(r => ({
                    to: [r.phone],
                    // Comes back on every delivery report, so a report finds its person.
                    CRQID: r.id,
                    components: components(firstName(r.name)),
                })),
            },
        },
    };
}

// ── Email ───────────────────────────────────────────────────────────────────

/** Set for each person when an email is sent: their RSVP and unsubscribe links, and the invite's picture. */
export const EMAIL_LINKS = ['image_url', 'rsvp_yes_url', 'rsvp_no_url', 'unsubscribe_url'] as const;

const escapeHtml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/**
 * The email's HTML, as stored in MSG91 (handlebars): the picture, the
 * message's paragraphs, the RSVP buttons and the unsubscribe line. Fields stay
 * as {{field}} for MSG91 to fill per person.
 */
export function emailHtml(t: Pick<TemplateInput, 'header' | 'body' | 'buttons'>, sender: string): string {
    const paragraphs = t.body.split(/\n{2,}/).map(p => `<p style="margin:0 0 14px;line-height:1.55">${escapeHtml(p).replaceAll('\n', '<br>')}</p>`).join('');
    const button = (href: string, label: string, primary: boolean) =>
        `<a href="{{${href}}}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;${primary ? 'background:#b8902f;color:#fff' : 'border:1px solid #b8902f;color:#8a6a1f'}">${escapeHtml(label)}</a>`;
    return [
        '<!doctype html><html><body style="margin:0;background:#f4f2ee;font-family:Arial,Helvetica,sans-serif;color:#1f1f1f">',
        '<div style="max-width:560px;margin:0 auto;padding:24px 16px"><div style="background:#fff;border-radius:12px;padding:24px">',
        t.header === 'image' ? '<img src="{{image_url}}" alt="" style="display:block;width:100%;height:auto;border-radius:8px;margin:0 0 18px">' : '',
        paragraphs,
        t.buttons.length ? `<div style="margin-top:8px">${button('rsvp_yes_url', RSVP_YES, true)}${button('rsvp_no_url', RSVP_NO, false)}</div>` : '',
        '</div>',
        `<p style="font-size:12px;color:#777;text-align:center;margin:14px 0 0">${escapeHtml(sender)} · <a href="{{unsubscribe_url}}" style="color:#777">Unsubscribe</a></p>`,
        '</div></body></html>',
    ].join('');
}

/** The handlebars variables for one person's email. */
export function emailVariables(t: Pick<TemplateInput, 'body' | 'headerText'>, values: FieldValues, person: string, links: Record<typeof EMAIL_LINKS[number], string>): Record<string, string> {
    const name = firstName(person);
    const fields = [...new Set([...templateFields(t.headerText), ...templateFields(t.body)])];
    return { ...Object.fromEntries(fields.map(f => [f, valueFor(f, values, name)])), ...links };
}

/** An email template's review result in MSG91's list: 1 pending, 2 verified, 5 rejected (no status: usable). */
export function emailTemplateStatus(raw: unknown): TemplateStatus {
    const id = Number(raw);
    if (id === 5) return 'rejected';
    return id === 1 ? 'pending' : 'approved';
}

// ── Delivery reports ────────────────────────────────────────────────────────

const RANK: Record<RecipientStatus, number> = { queued: 0, submitted: 1, sent: 2, delivered: 3, read: 4, failed: 2 };

/**
 * A person's status after a report: only ever forward (reports arrive late
 * and out of order), and "failed" never undoes a delivery.
 */
export function nextStatus(current: RecipientStatus, incoming: RecipientStatus): RecipientStatus {
    if (current === 'failed') return incoming === 'delivered' || incoming === 'read' ? incoming : current;
    if (incoming === 'failed') return RANK[current] <= RANK.sent ? 'failed' : current;
    return RANK[incoming] > RANK[current] ? incoming : current;
}

/** `phone` is the email address for an email report; `stop` marks an email unsubscribe. */
export type WebhookEvent =
    | { kind: 'status'; id: string; requestId: string; phone: string; status: RecipientStatus; reason: string }
    | { kind: 'reply'; phone: string; text: string }
    | { kind: 'stop'; phone: string };

const pick = (o: Record<string, unknown>, ...keys: string[]): string => {
    for (const k of keys) {
        const v = o[k];
        if (typeof v === 'string' && v) return v;
        if (typeof v === 'number') return String(v);
    }
    return '';
};
const digits = (v: string) => v.replaceAll(/\D/g, '');

/** A quick-reply button's words: an object, or the same as a JSON string. */
function buttonText(raw: unknown): string {
    let b = raw;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { return b as string; } }
    return b && typeof b === 'object' ? pick(b as Record<string, unknown>, 'text', 'payload', 'title') : '';
}

const EMAIL_EVENTS: Record<string, RecipientStatus> = { queued: 'sent', accepted: 'sent', sent: 'sent', delivered: 'delivered', opened: 'read', clicked: 'read', failed: 'failed', bounced: 'failed', rejected: 'failed' };

/** One MSG91 email report: delivered, opened, failed, or an unsubscribe. */
function parseEmailReport(o: Record<string, unknown>, email: string): WebhookEvent | null {
    const name = pick(o, 'eventName', 'event_name', 'event').toLowerCase();
    if (/unsubscri|complain/.test(name)) return { kind: 'stop', phone: email };
    const status = EMAIL_EVENTS[name];
    if (!status) return null;
    const reason = status === 'failed' ? pick(o, 'reason', 'description').slice(0, 300) : '';
    return { kind: 'status', phone: email, status, id: pick(o, 'crqid', 'CRQID'), requestId: pick(o, 'requestId', 'request_id', 'uuid', 'unique_id'), reason };
}

/** One MSG91 webhook payload, WhatsApp or email, in either spelling it has used; null when it isn't one we act on. */
export function parseWebhook(raw: unknown): WebhookEvent | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    const email = pick(o, 'recipient').trim().toLowerCase();
    if (email.includes('@')) return parseEmailReport(o, email);
    const phone = digits(pick(o, 'customerNumber', 'customer_number', 'mobile', 'to'));
    if (!phone) return null;
    const direction = pick(o, 'direction').toLowerCase();
    if (direction === '0' || direction === 'inbound') {
        // A photo, voice note or file with no words still belongs in the conversation.
        const kind = pick(o, 'contentType', 'content_type', 'messageType', 'type').toLowerCase();
        const text = buttonText(o.button) || pick(o, 'text', 'message', 'caption') || (kind && kind !== 'text' ? `[${kind}]` : '');
        return text ? { kind: 'reply', phone, text: text.slice(0, 1000) } : null;
    }
    const status = pick(o, 'eventName', 'event_name', 'status', 'event').toLowerCase();
    if (status !== 'sent' && status !== 'delivered' && status !== 'read' && status !== 'failed') return null;
    return {
        kind: 'status', phone, status,
        id: pick(o, 'crqid', 'CRQID'), requestId: pick(o, 'requestId', 'request_id'),
        reason: status === 'failed' ? pick(o, 'reason', 'failureReason', 'failure_reason', 'description').slice(0, 300) : '',
    };
}

/** A reply read as an RSVP: the template's own buttons, or a typed yes / no. */
export function rsvpOf(text: string): Rsvp {
    const t = text.trim().toLowerCase().replaceAll('’', "'");
    if (t === RSVP_YES.toLowerCase().replaceAll('’', "'") || /^(yes|y|haan|ha)\b/.test(t)) return 'yes';
    if (t === RSVP_NO.toLowerCase().replaceAll('’', "'") || /^(no|n|nahi)\b/.test(t)) return 'no';
    return '';
}

/** "STOP": this person must not be messaged again. */
export const isStop = (text: string): boolean => /^(stop|unsubscribe)\b/i.test(text.trim());

// ── Templates already on the MSG91 account ──────────────────────────────────

export interface AccountTemplate extends TemplateInput {
    status: TemplateStatus; reason: string; namespace: string;
    /** False: it uses something this app can't send (a carousel, a one-time password, named parameters). */
    sendable: boolean;
}

type Json = Record<string, unknown>;

/** Meta's review result, from one language entry of MSG91's list. */
function reviewStatus(l: Json): TemplateStatus {
    const raw = pick(l, 'status').toLowerCase();
    if (raw === 'approved' && !Number(l.is_disabled)) return 'approved';
    return /reject|disabled|paused|fail|approved/.test(raw) ? 'rejected' : 'pending';
}

const HEADER_FORMATS: Record<string, HeaderKind> = { TEXT: 'text', IMAGE: 'image', VIDEO: 'video', DOCUMENT: 'document', LOCATION: 'location' };
const BUTTON_TYPES: Record<string, ButtonKind> = { QUICK_REPLY: 'quick_reply', URL: 'url', PHONE_NUMBER: 'phone', COPY_CODE: 'copy_code' };

/** A panel template's buttons, in its own order (that order is their number when sending). */
function accountButtons(parts: Json[]): TemplateButton[] | null {
    const list = (parts.find(c => pick(c, 'type').toUpperCase() === 'BUTTONS')?.buttons ?? []) as Json[];
    const out: TemplateButton[] = [];
    for (const b of list) {
        const kind = BUTTON_TYPES[pick(b, 'type').toUpperCase()];
        if (!kind) return null;
        const example = Array.isArray(b.example) ? String(b.example[0] ?? '') : pick(b, 'example');
        out.push({ kind, text: kind === 'copy_code' ? example || 'CODE' : pick(b, 'text'), ...(kind === 'url' ? { url: pick(b, 'url') } : {}), ...(kind === 'phone' ? { phone: pick(b, 'phone_number') } : {}) });
    }
    return out;
}

/** One template in one language, from MSG91's list entry `t` and its language entry `l`. */
function accountTemplate(t: Json, l: Json, name: string): AccountTemplate {
    const reason = pick(l, 'rejection_reason', 'rejected_reason', 'reason');
    const parts = (Array.isArray(l.code) ? l.code : []) as Json[];
    const part = (type: string) => parts.find(c => pick(c, 'type').toUpperCase() === type) ?? {};
    const headerPart = part('HEADER');
    const header = HEADER_FORMATS[pick(headerPart, 'format').toUpperCase()] ?? 'none';
    const body = pick(part('BODY'), 'text');
    const buttons = accountButtons(parts);
    const variables = Array.isArray(l.variables) ? l.variables.map(String) : [];
    // Named parameters ({{customer_name}}) are sent differently; carousels and one-time passwords aren't invites.
    const named = pick(l, 'parameter_format').toUpperCase() === 'NAMED' && variables.some(v => v.startsWith('body_'));
    const category = pick(t, 'category').toUpperCase();
    const special = parts.some(c => /CAROUSEL|LIMITED_TIME_OFFER/.test(pick(c, 'type').toUpperCase()));
    return {
        channel: 'whatsapp', name, language: pick(l, 'language', 'language_code') || 'en', category: category === 'UTILITY' ? 'UTILITY' : 'MARKETING',
        header, headerText: header === 'text' ? pick(headerPart, 'text') : '', body, footer: pick(part('FOOTER'), 'text'), buttons: buttons ?? [], samples: {},
        status: reviewStatus(l), reason: /^none$/i.test(reason) ? '' : reason.slice(0, 300), namespace: pick(t, 'namespace') || pick(l, 'namespace'),
        sendable: !!body && !!buttons && !named && !special && category !== 'AUTHENTICATION',
    };
}

/**
 * The WhatsApp templates on the MSG91 account, from its list (one entry per
 * name and language): Meta's review result for each, and its parts, so
 * templates made in MSG91's own panel can be used here too.
 */
export function accountTemplates(data: unknown): AccountTemplate[] {
    const d = (data && typeof data === 'object' ? (data as Json).data ?? data : null) as unknown;
    const entries = (Array.isArray(d) ? d : []).filter((t): t is Json => !!t && typeof t === 'object');
    return entries.flatMap(t => {
        const name = pick(t, 'name', 'template_name');
        if (!name) return [];
        return ((Array.isArray(t.languages) ? t.languages : [t]) as Json[]).map(l => accountTemplate(t, l, name));
    });
}

/** People an invite reached at least this far: "delivered" counts those who went on to read it. */
export function reached(c: Counts, step: 'sent' | 'delivered' | 'read'): number {
    const order: RecipientStatus[] = ['sent', 'delivered', 'read'];
    return order.slice(order.indexOf(step)).reduce((s, k) => s + c[k], 0);
}

export const emptyCounts = (): Counts => ({ total: 0, queued: 0, submitted: 0, sent: 0, delivered: 0, read: 0, failed: 0, yes: 0, no: 0 });

// ── Who got the invites, resending, replies ─────────────────────────────────

/** Where a person's latest invite on a channel stands: got it, not yet, or failed. */
export type TrackState = 'got' | 'waiting' | 'failed';
export const trackState = (s: RecipientStatus): TrackState => {
    if (s === 'delivered' || s === 'read') return 'got';
    return s === 'failed' ? 'failed' : 'waiting';
};

/** A person's latest invite on one channel. */
export interface LatestInvite { recipientId: string; inviteId: string; inviteName: string; address: string; status: RecipientStatus; reason: string; at: number; resent: boolean }
/** One contact across every invite: their latest on each channel and how many they were sent. */
export interface PersonTrack { key: string; contactId: string; name: string; whatsapp: LatestInvite | null; email: LatestInvite | null; rsvp: Rsvp; invites: number }
export interface TrackHistory { recipientId: string; inviteId: string; inviteName: string; channel: Channel; address: string; status: RecipientStatus; reason: string; rsvp: Rsvp; at: number; auto: boolean }

/** Automatic resend: after how long without a delivery, and how many more tries. Same channel, same message. */
export interface ResendSettings { on: boolean; afterHours: number; tries: number }
export const RESEND_HOURS = [1, 6, 24] as const;
export const RESEND_TRIES = [1, 2, 3] as const;
export const RESEND_OFF: ResendSettings = { on: false, afterHours: 6, tries: 1 };

/** Settings as typed, kept to the choices offered. */
export function resendSettingsOf(raw: unknown): ResendSettings {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const pickOf = <T extends number>(list: readonly T[], v: unknown, fallback: T): T => (list.includes(Number(v) as T) ? Number(v) as T : fallback);
    return { on: r.on === true, afterHours: pickOf(RESEND_HOURS, r.afterHours, 6), tries: pickOf(RESEND_TRIES, r.tries, 1) };
}

/** WhatsApp lets a business write freely for 24 hours after the person's last message; after that only an approved template. */
export const REPLY_WINDOW_MS = 24 * 3_600_000;
export const replyWindowLeft = (lastInAt: number, now = Date.now(), windowMs = REPLY_WINDOW_MS): number => Math.max(0, lastInAt + windowMs - now);

/** A WhatsApp conversation in the list. `phone` is digits. */
export interface ReplyThread { phone: string; name: string; inviteName: string; rsvp: Rsvp; lastText: string; lastDir: 'in' | 'out'; lastAt: number; lastInAt: number; unread: number }
/** One line of a conversation: their message, the team's answer, or an invite that went to them. */
export interface ReplyMessage { id: string; dir: 'in' | 'out' | 'invite'; body: string; template: string; byName: string; at: number; status?: RecipientStatus }

// ── Analytics: Instagram, Facebook Page, YouTube ────────────────────────────

export interface AnalyticsStatus {
    meta: { available: boolean; connected: boolean; pageName: string; igUsername: string; connectedAt: number };
    google: { available: boolean; connected: boolean; channelTitle: string; connectedAt: number };
}
export interface DayValue { date: string; value: number }
/** `problems`: parts Meta or Google didn't give (a retired metric, a missing permission), in their words. */
export interface InstagramReport {
    username: string; followers: number; reachDaily: DayValue[]; problems: string[]; fetchedAt?: number;
    posts: { id: string; kind: string; caption: string; at: number; image: string; permalink: string; views: number; reach: number; likes: number; comments: number; shares: number; saves: number; avgWatchSec?: number }[];
}
export interface FacebookReport {
    name: string; followers: number; link: string; viewsDaily: DayValue[]; engagementDaily: DayValue[]; problems: string[]; fetchedAt?: number;
    posts: { id: string; caption: string; at: number; image: string; permalink: string; reactions: number; comments: number; shares: number }[];
}
export interface YoutubeReport {
    title: string; subscribers: number; totalViews: number; videoCount: number; problems: string[]; fetchedAt?: number;
    daily: { date: string; views: number; minutes: number; avgViewSec: number; subscribers: number }[];
    sources: { name: string; views: number }[];
    top: { id: string; title: string; thumb: string; at: number; views: number; minutes: number; avgViewSec: number; likes: number; comments: number }[];
}
