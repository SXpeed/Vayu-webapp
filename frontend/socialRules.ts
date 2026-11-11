// WhatsApp invites: the rules shared by the Worker (social.ts) and the app
// (views/SocialInvitesView.tsx). No dependencies, no I/O: what a template may
// say, how its named fields become WhatsApp's {{1}} {{2}}, what is sent to
// MSG91 and how its delivery reports are read.
//
// MSG91's formats here come from its public docs (2026-11); the template list
// and the image header were not confirmed against a live account
// (docs/IMPLEMENTATION_PLAN.md 8.5).

/** Fields a template may use. `name` is each person's own; the rest are typed when sending. */
export const FIELDS = ['name', 'event', 'date', 'venue'] as const;
export type FieldName = typeof FIELDS[number];
/** What each field says in one invite, by field: a name above, or "1", "2"… in a template brought in from MSG91. */
export type FieldValues = Partial<Record<string, string>>;
/** In a typed value, stands for each person's own first name. */
export const NAME_TOKEN = '{{name}}';

/** What Meta's reviewers (and the preview) see in place of each field. */
export const SAMPLE: Record<FieldName, string> = { name: 'Anjali', event: 'Monsoon Show', date: '14 Nov, 6 pm', venue: 'Vayu Gallery, Mumbai' };

export const LANGUAGES: Record<string, string> = { en: 'English', en_US: 'English (US)', en_GB: 'English (UK)', hi: 'Hindi', gu: 'Gujarati', mr: 'Marathi' };

export const RSVP_YES = 'Yes, I’ll come';
export const RSVP_NO = 'Can’t make it';
export const MAX_BODY = 1024;
export const MAX_FOOTER = 60;
/** shortcut: one invite reaches at most this many people; make it a plan limit when plans price invites. */
export const MAX_RECIPIENTS = 2000;

export type TemplateStatus = 'pending' | 'approved' | 'rejected';
export interface TemplateInput { name: string; language: string; body: string; footer: string; image: boolean; rsvp: boolean }
export interface SocialTemplate extends TemplateInput { id: string; status: TemplateStatus; reason: string; createdAt: number }

export type RecipientStatus = 'queued' | 'submitted' | 'sent' | 'delivered' | 'read' | 'failed';
export type Rsvp = '' | 'yes' | 'no';
export interface Recipient { id: string; name: string; phone: string; status: RecipientStatus; reason: string; rsvp: Rsvp; at: number }
export type Counts = Record<RecipientStatus, number> & { total: number; yes: number; no: number };
export interface Invite {
    id: string; name: string; templateId: string; templateName: string; tagIds: string[]; values: FieldValues; imageUrl: string;
    status: 'scheduled' | 'sending' | 'sent'; sendAt: number; createdAt: number; createdByName: string; counts: Counts;
}
export interface InviteInput { name: string; templateId: string; tagIds: string[]; values: FieldValues; imageUrl: string; sendAt: number }

export const STATUS_LABEL: Record<RecipientStatus, string> = { queued: 'Queued', submitted: 'Sending', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed' };

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
/** {{ anything }}; what is inside is trimmed by `inner`. */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const inner = (m: RegExpMatchArray | string) => (typeof m === 'string' ? m : m[1]).trim();

/** The fields a body uses, in the order they first appear (that order is their WhatsApp number). */
export function templateFields(body: string): string[] {
    const found: string[] = [];
    for (const m of body.matchAll(PLACEHOLDER)) {
        const f = inner(m);
        if ((isNamed(f) || /^\d{1,2}$/.test(f)) && !found.includes(f)) found.push(f);
    }
    return found;
}
const isNamed = (f: string): f is FieldName => (FIELDS as readonly string[]).includes(f);

/** A field's WhatsApp number: its own for "1", "2"…; for a named field, its place in the body. */
const position = (fields: string[], f: string): number => (isNamed(f) ? fields.indexOf(f) + 1 : Number(f));

/** "Hello {{name}}" → "Hello {{1}}". */
export const numberedBody = (body: string): string => {
    const fields = templateFields(body);
    const numberOf = (f: string) => String(position(fields, f));
    return body.replace(PLACEHOLDER, (m, raw: string) => (fields.includes(inner(raw)) ? `{{${numberOf(inner(raw))}}}` : m));
};

/** A field's words for one person: their first name for `name`, and wherever a typed value says {{name}}. */
const valueFor = (f: string, values: FieldValues, name: string): string =>
    (f === 'name' ? name : (values[f] ?? '').replaceAll(NAME_TOKEN, name));

const sampleOr = (f: string, written: string): string => (isNamed(f) ? SAMPLE[f] : written);

/** The body as one person reads it; a field not filled in yet shows its sample, or stays as written. */
export const filledBody = (body: string, values: FieldValues): string =>
    body.replace(PLACEHOLDER, (m, raw: string) => valueFor(inner(raw), values, values.name || SAMPLE.name) || sampleOr(inner(raw), m));

/** "Summer Show invite!" → "summer_show_invite": the only spelling WhatsApp takes for a template's name. */
export const templateSlug = (title: string): string =>
    title.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_').replace(/^_/, '').replace(/_$/, '').slice(0, 60);

/** "exhibition_opening_26_11_11" → "Exhibition opening": the name people gave it, without the date that keeps it unique. */
export function templateTitle(name: string): string {
    const words = name.replace(/_\d{2}_\d{2}_\d{2}$/, '').replaceAll('_', ' ').trim();
    return words ? words[0].toUpperCase() + words.slice(1) : name;
}

const FIELD_LIST = FIELDS.map(f => `{{${f}}}`).join(', ');

/** A template as typed, checked against WhatsApp's rules so Meta's review rarely refuses it. */
export function parseTemplate(raw: unknown): TemplateInput | { problem: string } {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const t: TemplateInput = {
        name: str(r.name, 60), language: str(r.language, 10) || 'en', body: str(r.body, MAX_BODY + 1), footer: str(r.footer, MAX_FOOTER + 1),
        image: r.image === true, rsvp: r.rsvp === true,
    };
    if (!/^[a-z][a-z0-9_]{2,59}$/.test(t.name)) return { problem: 'Give the template a name: small letters, numbers and underscores, at least 3 characters.' };
    if (!Object.hasOwn(LANGUAGES, t.language)) return { problem: 'Choose a language.' };
    if (t.body.length < 10) return { problem: 'Write the message.' };
    if (t.body.length > MAX_BODY) return { problem: `The message can be up to ${MAX_BODY} characters.` };
    const unknown = [...t.body.matchAll(PLACEHOLDER)].find(m => !isNamed(inner(m)));
    if (unknown) return { problem: `"${unknown[0]}" is not a field. Use ${FIELD_LIST}.` };
    if (/^\{\{[^{}]*\}\}/.test(t.body) || /\{\{[^{}]*\}\}$/.test(t.body)) return { problem: 'WhatsApp does not allow a message to start or end with a field. Add a word before or after it.' };
    if (/\}\}\s*\{\{/.test(t.body)) return { problem: 'Put some words between two fields.' };
    if (/\n{3,}/.test(t.body)) return { problem: 'Leave at most one empty line between paragraphs.' };
    if (t.footer.length > MAX_FOOTER) return { problem: `The small print can be up to ${MAX_FOOTER} characters.` };
    if (/\{\{/.test(t.footer)) return { problem: 'The small print cannot use fields.' };
    return t;
}

/** What MSG91 is sent to create a template (it passes it to Meta for review). */
export function createTemplatePayload(number: string, t: TemplateInput, sampleImageUrl: string): Record<string, unknown> {
    const fields = templateFields(t.body);
    return {
        integrated_number: number, template_name: t.name, language: t.language, category: 'MARKETING', button_url: false,
        components: [
            ...(t.image ? [{ type: 'HEADER', format: 'IMAGE', example: { header_handle: [sampleImageUrl] } }] : []),
            { type: 'BODY', text: numberedBody(t.body), ...(fields.length ? { example: { body_text: [fields.map(f => (isNamed(f) ? SAMPLE[f] : f))] } } : {}) },
            ...(t.footer ? [{ type: 'FOOTER', text: t.footer }] : []),
            ...(t.rsvp ? [{ type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: RSVP_YES }, { type: 'QUICK_REPLY', text: RSVP_NO }] }] : []),
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

/** What a field is called on screen: "event", or "field 2" in a template brought in from MSG91. */
export const fieldLabel = (f: string): string => (isNamed(f) ? f : `field ${f}`);

/** One bulk request to MSG91: each person has their own entry, so each gets their own name. */
export function sendPayload(opts: {
    number: string; template: Pick<TemplateInput, 'name' | 'language' | 'body' | 'image'>; namespace: string;
    values: FieldValues; imageUrl: string; recipients: { id: string; phone: string; name: string }[];
}): Record<string, unknown> {
    const fields = templateFields(opts.template.body);
    return {
        integrated_number: opts.number, content_type: 'template',
        payload: {
            messaging_product: 'whatsapp', type: 'template',
            template: {
                name: opts.template.name, language: { code: opts.template.language, policy: 'deterministic' },
                ...(opts.namespace ? { namespace: opts.namespace } : {}),
                to_and_components: opts.recipients.map(r => ({
                    to: [r.phone],
                    // Comes back on every delivery report, so a report finds its person.
                    CRQID: r.id,
                    components: {
                        ...(opts.template.image && opts.imageUrl ? { header_1: { type: 'image', value: opts.imageUrl } } : {}),
                        ...Object.fromEntries(fields.map(f => [`body_${position(fields, f)}`, {
                            type: 'text', value: valueFor(f, opts.values, firstName(r.name)).slice(0, 200),
                        }])),
                    },
                })),
            },
        },
    };
}

/** What sending needs that isn't given: a field left empty, or the picture. */
export function inviteProblem(t: Pick<TemplateInput, 'body' | 'image'>, values: FieldValues, imageUrl: string): string | null {
    const empty = templateFields(t.body).find(f => f !== 'name' && !values[f]?.trim());
    if (empty) return `Fill in "${fieldLabel(empty)}".`;
    if (t.image && !imageUrl) return 'This template has a picture. Add one.';
    return null;
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

export type WebhookEvent =
    | { kind: 'status'; id: string; requestId: string; phone: string; status: RecipientStatus; reason: string }
    | { kind: 'reply'; phone: string; text: string };

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

/** One MSG91 webhook payload, in either spelling it has used (camelCase and snake_case); null when it isn't one we act on. */
export function parseWebhook(raw: unknown): WebhookEvent | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    const phone = digits(pick(o, 'customerNumber', 'customer_number', 'mobile', 'to'));
    if (!phone) return null;
    const direction = pick(o, 'direction').toLowerCase();
    if (direction === '0' || direction === 'inbound') {
        const text = buttonText(o.button) || pick(o, 'text', 'message');
        return text ? { kind: 'reply', phone, text: text.slice(0, 500) } : null;
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

export interface AccountTemplate extends TemplateInput {
    status: TemplateStatus; reason: string; namespace: string;
    /** False: it uses something this app can't send yet (a video, a link with a field…). */
    sendable: boolean;
}

type Json = Record<string, unknown>;

/** Meta's review result, from one language entry of MSG91's list. */
function reviewStatus(l: Json): TemplateStatus {
    const raw = pick(l, 'status').toLowerCase();
    if (raw === 'approved' && !Number(l.is_disabled)) return 'approved';
    return /reject|disabled|paused|fail|approved/.test(raw) ? 'rejected' : 'pending';
}

/** One template in one language, from MSG91's list entry `t` and its language entry `l`. */
function accountTemplate(t: Json, l: Json, name: string): AccountTemplate {
    const reason = pick(l, 'rejection_reason', 'rejected_reason', 'reason');
    const parts = (Array.isArray(l.code) ? l.code : []) as Json[];
    const part = (type: string) => parts.find(c => pick(c, 'type').toUpperCase() === type) ?? {};
    const body = pick(part('BODY'), 'text');
    const variables = Array.isArray(l.variables) ? l.variables.map(String) : [];
    const types = (l.variable_type ?? {}) as Record<string, { type?: string }>;
    const image = variables.includes('header_1') && types.header_1?.type === 'image';
    // Sendable: only a picture on top and numbered words in the body need filling.
    const numbered = pick(l, 'parameter_format').toUpperCase() !== 'NAMED' || variables.every(v => v === 'header_1');
    const fillable = variables.every(v => /^body_\d{1,2}$/.test(v) || (v === 'header_1' && image));
    return {
        name, language: pick(l, 'language', 'language_code') || 'en', body, footer: pick(part('FOOTER'), 'text'), image, rsvp: false,
        status: reviewStatus(l), reason: /^none$/i.test(reason) ? '' : reason.slice(0, 300), namespace: pick(t, 'namespace') || pick(l, 'namespace'),
        sendable: !!body && numbered && fillable,
    };
}

/**
 * The templates on the MSG91 account, from its list (one entry per name and
 * language): Meta's review result for each, and its words, so templates made
 * in MSG91's own panel can be used here too.
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
