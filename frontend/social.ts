// Social → invites on WhatsApp and by email, sent through each workspace's
// own MSG91 account (docs/IMPLEMENTATION_PLAN.md 8.5, 8.6): the connection,
// templates and their review, invites to contacts by tag, and who each one
// reached.
//
// Storage: tables in the workspace's own database, created on first use.
// Nothing goes through change_log: the screens refetch when they open.
//
// Sending never repeats a message: people are claimed (queued → submitted)
// before MSG91 is called, and a call that fails or times out marks them
// failed instead of trying again.

import { ADMIN_ROLE_ID } from './permissions';
import { contactLists, err, json, runSetupOnce, text } from './rows';
import { fileKeyFromUrl, fileUrl, timingSafeEqual, type Ctx, type Env, type SessionData } from './workerEnv';
import { getSession } from './workerRoles';
import { orgStorageEnv } from './orgApp';
import { ensureContactSchema, orgCountry } from './contactStore';
import { emailKey, phoneKey } from './contactKeys';
import { decryptSecret, encryptSecret, reportDecryptFailure, secretsConfigured } from './platform/secrets';
import {
    MAX_RECIPIENTS, MEDIA_HEADERS, MEDIA_RULES, RSVP_BUTTONS, accountTemplates, createTemplatePayload, emailHtml, emailTemplateStatus, emailVariables,
    emptyCounts, inviteProblem, isStop, nextStatus, parseTemplate, parseWebhook, rsvpOf, sendPayload, sendSlots,
    type Channel, type Counts, type FieldValues, type HeaderKind, type Invite, type Recipient, type RecipientStatus, type Rsvp,
    type SocialTemplate, type TemplateButton, type TemplateInput, type WebhookEvent,
} from './socialRules';

type Handler = (ctx: Ctx) => Promise<Response>;
type Row = Record<string, unknown>;
export interface SocialRoute { method: string; match: (path: string) => boolean; handler: Handler }

/** People per MSG91 request, and requests per run (the scheduled job carries on every 10 minutes). */
const CHUNK = 50;
const CHUNKS_PER_RUN = 20;
const PENDING = 'social-pending:';
const ID = String.raw`[\w-]{1,64}`;
const TEMPLATE_PATH = new RegExp(`^/social/templates/(${ID})$`);
const INVITE_PATH = new RegExp(`^/social/invites/(${ID})$`);
const RETRY_PATH = new RegExp(`^/social/invites/(${ID})/retry$`);
const channelOf = (v: unknown): Channel => (v === 'email' ? 'email' : 'whatsapp');

const NEW_COLUMNS: Record<string, Record<string, string>> = {
    social_templates: { channel: "TEXT NOT NULL DEFAULT 'whatsapp'", category: "TEXT NOT NULL DEFAULT 'MARKETING'", spec: "TEXT NOT NULL DEFAULT ''" },
    social_invites: { channel: "TEXT NOT NULL DEFAULT 'whatsapp'", link_base: "TEXT NOT NULL DEFAULT ''" },
};

function ensureSocialTables(db: D1Database): Promise<void> {
    return runSetupOnce(db, 'socialTables', async () => {
        await db.batch([
            db.prepare('CREATE TABLE IF NOT EXISTS social_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'),
            db.prepare(`CREATE TABLE IF NOT EXISTS social_templates (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, language TEXT NOT NULL, body TEXT NOT NULL, footer TEXT NOT NULL DEFAULT '',
                image INTEGER NOT NULL DEFAULT 0, rsvp INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
                reason TEXT NOT NULL DEFAULT '', namespace TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, UNIQUE (name, language))`),
            db.prepare(`CREATE TABLE IF NOT EXISTS social_invites (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, template_id TEXT NOT NULL, tag_ids TEXT NOT NULL DEFAULT '[]', vals TEXT NOT NULL DEFAULT '{}',
                image_key TEXT NOT NULL DEFAULT '', image_url TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, send_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL, created_by TEXT NOT NULL, created_by_name TEXT NOT NULL)`),
            // `phone` holds the email address for an email invite.
            db.prepare(`CREATE TABLE IF NOT EXISTS social_recipients (
                id TEXT PRIMARY KEY, invite_id TEXT NOT NULL, contact_id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued', reason TEXT NOT NULL DEFAULT '', rsvp TEXT NOT NULL DEFAULT '',
                status_at INTEGER NOT NULL, claim TEXT, request_id TEXT)`),
            db.prepare('CREATE INDEX IF NOT EXISTS idx_social_recipients_invite ON social_recipients (invite_id, status)'),
            db.prepare('CREATE INDEX IF NOT EXISTS idx_social_recipients_phone ON social_recipients (phone)'),
            db.prepare('CREATE INDEX IF NOT EXISTS idx_social_recipients_claim ON social_recipients (claim)'),
            // A WhatsApp number (digits) or an email address (lowercase) that asked not to be messaged.
            db.prepare('CREATE TABLE IF NOT EXISTS social_optouts (phone TEXT PRIMARY KEY, at INTEGER NOT NULL)'),
        ]);
        for (const [table, columns] of Object.entries(NEW_COLUMNS)) {
            for (const [column, definition] of Object.entries(columns)) {
                try {
                    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run(); // NOSONAR: schema steps run one at a time
                } catch (e) {
                    if (!/duplicate column/i.test((e as Error).message)) throw e; // added before, or by another isolate
                }
            }
        }
    });
}

// ── The MSG91 account ───────────────────────────────────────────────────────

interface EmailSender { domain: string; from: string; fromName: string; replyTo: string }

interface Connection {
    /** The WhatsApp number to send from; '' when the account has none (email only). */
    number: string;
    /** Encrypted (platform/secrets.ts); never sent to the app. */
    authKey: string;
    /** In the delivery-updates address: MSG91 doesn't sign its calls, so the address itself is the secret. */
    hookToken: string;
    /** Signs the public addresses of invite files and the RSVP / unsubscribe links. */
    signKey: string;
    connectedAt: number;
    connectedBy: string;
    email?: EmailSender;
}

const keyContext = (env: Env) => `${env.ORG_ID}|msg91|authkey`;
const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes))).map(b => b.toString(16).padStart(2, '0')).join('');

async function readConnection(env: Env): Promise<Connection | null> {
    const row = await env.VAYU_DB.prepare("SELECT value FROM social_settings WHERE key = 'whatsapp'").first<{ value: string }>();
    return row ? JSON.parse(row.value) as Connection : null;
}

const saveConnection = (env: Env, conn: Connection) =>
    env.VAYU_DB.prepare("INSERT INTO social_settings (key, value) VALUES ('whatsapp', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(conn)).run();

async function authKeyOf(env: Env, conn: Connection): Promise<string | null> {
    try {
        return await decryptSecret(env, keyContext(env), conn.authKey);
    } catch (e) {
        reportDecryptFailure(keyContext(env), e, 'social');
        return null;
    }
}

interface Msg91Answer { ok: boolean; status: number; data: any; error: string }

/** One MSG91 API call (`path` after /api/v5). A 200 can still be a refusal (hasError), so both are checked. */
async function msg91(env: Env, authKey: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Msg91Answer> {
    // MSG91_API_BASE: tests only, honoured only in development (like RAZORPAY_API_BASE).
    const base = env.PLATFORM_ENV === 'development' && env.MSG91_API_BASE ? env.MSG91_API_BASE.replace(/\/$/, '') : 'https://control.msg91.com';
    try {
        const res = await fetch(`${base}/api/v5${path}`, {
            method,
            headers: { authkey: authKey, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(15_000),
        });
        const data = await res.json().catch(() => ({})) as any;
        const refused = !res.ok || data?.hasError === true || data?.status === 'fail' || data?.type === 'error';
        if (!refused) return { ok: true, status: res.status, data, error: '' };
        const said = data?.errors ?? data?.message ?? data?.data;
        const error = (typeof said === 'string' ? said : JSON.stringify(said ?? '')).slice(0, 300) || `MSG91 answered ${res.status}`;
        return { ok: false, status: res.status === 200 && /unauthori/i.test(error) ? 401 : res.status, data, error };
    } catch {
        return { ok: false, status: 0, data: null, error: 'MSG91 did not answer. Nothing was sent again, to avoid sending twice.' };
    }
}

const KEY_REFUSED = 'MSG91 did not accept this key. Check it, and turn off "IP security" for it in MSG91 (our servers have no fixed address).';

/** MSG91's refusal as this API's answer: a refused key says how to fix it; anything else, what MSG91 said. */
const refusal = (res: Msg91Answer, what: string): Response =>
    (res.status === 401 ? err(KEY_REFUSED) : err(`${what}: ${res.error}`, 502));

const apiOrigin = (ctx: Ctx) => ctx.env.API_ORIGIN || ctx.url.origin;
const hookUrl = (ctx: Ctx, conn: Connection) => `${apiOrigin(ctx)}/api/v2/webhooks/msg91/${ctx.env.ORG_ID}/${conn.hookToken}`;
/** Where this workspace's public invite addresses start: files, RSVP and unsubscribe links. */
const linkBase = (ctx: Ctx) => `${apiOrigin(ctx)}/api/v2/social`;

async function hmacHex(key: string, message: string): Promise<string> {
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message)));
    return Array.from(sig.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** An uploaded file's storage key from its address in the app; '' when it isn't one of this workspace's uploads. */
function uploadKey(url: unknown): string {
    const key = typeof url === 'string' ? fileKeyFromUrl(url.split('?')[0]) : null;
    return key && uploadKeyOk(key) ? key : '';
}
const uploadKeyOk = (key: string) => key.startsWith('uploads/') && !key.includes('..');

/** WhatsApp's own limits on a header file (picture, video, PDF), checked here so the refusal is in plain words. */
async function mediaProblem(env: Env, key: string, kind: HeaderKind): Promise<string | null> {
    const rule = MEDIA_RULES[kind];
    if (!rule) return null;
    const head = await env.VAYU_R2.head(key);
    if (!head) return 'That file was not found. Add it again.';
    if (!rule.types.test(head.httpMetadata?.contentType ?? '')) return `This needs ${rule.words}.`;
    return head.size > rule.maxMb * 1024 * 1024 ? `The file is too large: ${rule.words}.` : null;
}

/** Where WhatsApp or an email fetches a file: public, but only with this workspace's signature for that one file. */
async function publicFileUrl(base: string, orgId: string, conn: Connection, key: string): Promise<string> {
    return `${base}/image/${orgId}/${await hmacHex(conn.signKey, key)}/${key}`;
}

// ── Who is asking ───────────────────────────────────────────────────────────

/** Signed in, inside a workspace, tables ready. (View / edit is the router's ACCESS_TABLE: section `social`.) */
async function caller(ctx: Ctx): Promise<SessionData | Response> {
    const session = await getSession(ctx.request, ctx.env.VAYU_KV);
    if (!session) return err('Unauthorized', 401);
    if (!ctx.env.ORG_ID) return err('Invites work inside a workspace. Sign in with your workspace account.', 409);
    await ensureSocialTables(ctx.env.VAYU_DB);
    return session;
}

async function body(ctx: Ctx): Promise<Record<string, unknown>> {
    const b = await ctx.request.json().catch(() => null);
    return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {};
}

/** The connection and its key, ready for this channel, or the answer that says what is missing. */
async function account(ctx: Ctx, channel: Channel): Promise<{ conn: Connection; authKey: string } | Response> {
    const conn = await readConnection(ctx.env);
    if (!conn) return err('Connect your MSG91 account first.', 409);
    if (channel === 'whatsapp' && !conn.number) return err('This MSG91 account has no WhatsApp number connected.', 409);
    if (channel === 'email' && !conn.email) return err('Set the email sender first: the domain and the address invites come from.', 409);
    const authKey = await authKeyOf(ctx.env, conn);
    if (!authKey) return err('The saved MSG91 key could not be read. Connect it again.', 409);
    return { conn, authKey };
}

// ── Connection routes ───────────────────────────────────────────────────────

const connectionView = (ctx: Ctx, conn: Connection) =>
    ({ connected: true, number: conn.number, webhookUrl: hookUrl(ctx, conn), connectedAt: conn.connectedAt, email: conn.email ?? null });

const connectionGet: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const conn = await readConnection(ctx.env);
    return json(conn ? connectionView(ctx, conn) : { connected: false, available: secretsConfigured(ctx.env) });
};

/** The WhatsApp numbers on a key's MSG91 account (none is fine: email only), or why the key was refused. */
async function accountNumbers(env: Env, authKey: string): Promise<string[] | Response> {
    const res = await msg91(env, authKey, 'GET', '/whatsapp/whatsapp-activation/');
    if (!res.ok) return refusal(res, 'MSG91 said');
    const list = (Array.isArray(res.data?.data) ? res.data.data : []) as Row[];
    return list.map(n => text(n?.integrated_number).replaceAll(/\D/g, '')).filter(Boolean);
}

/** The number to send from: the one asked for if the account has it, its only one, or none; otherwise the answer that lists them. */
function chooseNumber(numbers: string[], wanted: string): string | Response {
    if (numbers.includes(wanted)) return wanted;
    if (!wanted && numbers.length <= 1) return numbers[0] ?? '';
    const list = numbers.map(n => `+${n}`).join(', ');
    if (!numbers.length) return err('This MSG91 account has no WhatsApp number. Leave the number empty to use email only.', 409);
    const theirs = numbers.length === 1 ? `number is ${list}` : `numbers are ${list}`;
    const error = wanted ? `That number is not on this MSG91 account. Its WhatsApp ${theirs}.` : `This MSG91 account has several WhatsApp numbers: ${list}. Type the one to send from.`;
    return json({ error, code: 'choose_number', numbers }, 409);
}

/**
 * PUT /social/whatsapp { authKey?, number? } — the key is checked by asking
 * MSG91 which WhatsApp numbers its account has. One number: that is the one.
 * Several: the answer lists them (code choose_number) and the person types one.
 * Without authKey, the saved key is kept (to change the number only).
 */
const connectionPut: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    if (session.role !== ADMIN_ROLE_ID) return err('Only an admin can connect MSG91.', 403);
    if (!secretsConfigured(ctx.env)) return err('Saving keys is not set up on this server yet. Ask us to switch it on.', 503);
    const b = await body(ctx);
    const old = await readConnection(ctx.env);
    const typed = text(b.authKey).trim();
    const saved = old && !typed ? await authKeyOf(ctx.env, old) : null;
    const authKey = typed || saved || '';
    if (authKey.length < 10 || authKey.length > 200) return err('Paste the auth key from MSG91.');
    const numbers = await accountNumbers(ctx.env, authKey);
    if (numbers instanceof Response) return numbers;
    const number = chooseNumber(numbers, text(b.number).replaceAll(/\D/g, ''));
    if (number instanceof Response) return number;
    const conn: Connection = {
        number, authKey: old && !typed ? old.authKey : await encryptSecret(ctx.env, keyContext(ctx.env), typed),
        // Kept across a key change, so the address pasted into MSG91 keeps working.
        hookToken: old?.hookToken ?? randomHex(24), signKey: old?.signKey ?? randomHex(32),
        connectedAt: Date.now(), connectedBy: session.userId, email: old?.email,
    };
    await saveConnection(ctx.env, conn);
    return json(connectionView(ctx, conn));
};

/** PUT /social/email { domain, from, fromName, replyTo } — the sender of email invites; the domain must be verified in MSG91. */
const emailSenderPut: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    if (session.role !== ADMIN_ROLE_ID) return err('Only an admin can set the email sender.', 403);
    const conn = await readConnection(ctx.env);
    if (!conn) return err('Connect your MSG91 account first.', 409);
    const b = await body(ctx);
    const domain = text(b.domain).trim().toLowerCase().slice(0, 120);
    const from = text(b.from).trim().toLowerCase().slice(0, 200);
    const replyTo = text(b.replyTo).trim().toLowerCase().slice(0, 200);
    const fromName = text(b.fromName).trim().slice(0, 80);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return err('Give the sending domain verified in MSG91, like mail.yourgallery.com.');
    if (!emailKey(from) || !from.endsWith(`@${domain}`)) return err(`The from address must be on ${domain}, like invites@${domain}.`);
    if (replyTo && !emailKey(replyTo)) return err('That reply-to address does not look right.');
    if (!fromName) return err('Give the name invites come from, like your gallery’s name.');
    conn.email = { domain, from, fromName, replyTo };
    await saveConnection(ctx.env, conn);
    return json(connectionView(ctx, conn));
};

const connectionDelete: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    if (session.role !== ADMIN_ROLE_ID) return err('Only an admin can disconnect MSG91.', 403);
    await ctx.env.VAYU_DB.prepare("DELETE FROM social_settings WHERE key = 'whatsapp'").run();
    return json({ connected: false, available: secretsConfigured(ctx.env) });
};

// ── Templates ───────────────────────────────────────────────────────────────

interface Spec { header: HeaderKind; headerText: string; buttons: TemplateButton[]; samples: FieldValues }

const parseJson = <T>(raw: unknown, fallback: T): T => { try { return JSON.parse(text(raw)) as T; } catch { return fallback; } };

/** The stored parts; templates saved before `spec` existed had only a picture and RSVP switch. */
function specOf(r: Row): Spec {
    const spec = parseJson<Partial<Spec> | null>(r.spec, null);
    if (spec?.header) return { header: spec.header, headerText: spec.headerText ?? '', buttons: spec.buttons ?? [], samples: spec.samples ?? {} };
    return { header: r.image ? 'image' : 'none', headerText: '', buttons: r.rsvp ? RSVP_BUTTONS : [], samples: {} };
}

const rowToTemplate = (r: Row): SocialTemplate => ({
    id: text(r.id), channel: channelOf(r.channel), name: text(r.name), language: text(r.language), category: text(r.category) === 'UTILITY' ? 'UTILITY' : 'MARKETING',
    body: text(r.body), footer: text(r.footer), ...specOf(r),
    status: text(r.status) as SocialTemplate['status'], reason: text(r.reason), createdAt: Number(r.created_at),
});

const specJson = (t: Pick<TemplateInput, 'header' | 'headerText' | 'buttons' | 'samples'>) =>
    JSON.stringify({ header: t.header, headerText: t.headerText, buttons: t.buttons, samples: t.samples } satisfies Spec);

const insertTemplate = (db: D1Database, id: string, t: TemplateInput, status: string, reason: string, namespace: string) =>
    db.prepare(`INSERT OR IGNORE INTO social_templates (id, channel, name, language, category, body, footer, image, rsvp, spec, status, reason, namespace, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, t.channel, t.name, t.language, t.category, t.body, t.footer,
        Number(MEDIA_HEADERS.has(t.header)), Number(t.buttons.some(b => b.kind === 'quick_reply')), specJson(t), status, reason, namespace, Date.now());

/** MSG91's WhatsApp templates: Meta's review result for ours, and the ones made in MSG91's own panel brought in. Gives how many can't be used here. */
async function syncWhatsappTemplates(env: Env, conn: Connection, authKey: string): Promise<number | null> {
    const res = await msg91(env, authKey, 'GET', `/whatsapp/get-template-client/${conn.number}`);
    if (!res.ok) return null;
    const db = env.VAYU_DB;
    const { results } = await db.prepare("SELECT id, name, language, status, reason, namespace FROM social_templates WHERE channel = 'whatsapp'").all<Row>();
    const mine = new Map(results.map(r => [`${text(r.name)}|${text(r.language)}`, r]));
    let skipped = 0;
    const changes = accountTemplates(res.data).flatMap(t => {
        const r = mine.get(`${t.name}|${t.language}`);
        if (r) {
            if (t.status === r.status && t.reason === r.reason && t.namespace === r.namespace) return [];
            return [db.prepare('UPDATE social_templates SET status = ?, reason = ?, namespace = ? WHERE id = ?').bind(t.status, t.reason, t.namespace, r.id)];
        }
        if (!t.sendable) { skipped++; return []; }
        return [insertTemplate(db, `tpl_${crypto.randomUUID()}`, t, t.status, t.reason, t.namespace)];
    });
    for (let i = 0; i < changes.length; i += 50) await db.batch(changes.slice(i, i + 50)); // NOSONAR: one write batch at a time
    return skipped;
}

/** The review result of our email templates in MSG91 (each is found by its slug, kept in `namespace`). */
async function syncEmailTemplates(env: Env, authKey: string): Promise<boolean> {
    const res = await msg91(env, authKey, 'GET', '/email/templates?per_page=100&with=versions');
    if (!res.ok) return false;
    const list = (Array.isArray(res.data?.data?.data) ? res.data.data.data : res.data?.data) as Row[] | undefined;
    const bySlug = new Map((Array.isArray(list) ? list : []).map(t => {
        const versions = (Array.isArray(t.versions) ? t.versions : []) as Row[];
        const active = versions.find(v => v.is_active) ?? versions[0] ?? t;
        return [text(t.slug), emailTemplateStatus(active.status_id)] as const;
    }));
    const db = env.VAYU_DB;
    const { results } = await db.prepare("SELECT id, namespace, status FROM social_templates WHERE channel = 'email'").all<Row>();
    const changes = results.flatMap(r => {
        const status = bySlug.get(text(r.namespace));
        return status && status !== r.status ? [db.prepare('UPDATE social_templates SET status = ? WHERE id = ?').bind(status, r.id)] : [];
    });
    if (changes.length) await db.batch(changes);
    return true;
}

/** GET /social/templates?channel=&refresh=1 — refresh asks MSG91 how each review went (and brings in WhatsApp templates made there). */
const templatesList: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const channel = channelOf(ctx.url.searchParams.get('channel'));
    let checked = false;
    let skipped = 0;
    const acct = ctx.url.searchParams.get('refresh') === '1' ? await account(ctx, channel) : null;
    if (acct && !(acct instanceof Response)) {
        if (channel === 'email') checked = await syncEmailTemplates(ctx.env, acct.authKey);
        else {
            const n = await syncWhatsappTemplates(ctx.env, acct.conn, acct.authKey);
            checked = n !== null;
            skipped = n ?? 0;
        }
    }
    const { results } = await ctx.env.VAYU_DB.prepare('SELECT * FROM social_templates WHERE channel = ? ORDER BY created_at DESC').bind(channel).all<Row>();
    return json({ templates: results.map(rowToTemplate), checked, skipped });
};

/** A WhatsApp template to MSG91 (it goes to Meta for review); gives its namespace, or the refusal. */
async function submitWhatsapp(ctx: Ctx, t: TemplateInput, conn: Connection, authKey: string, sampleKey: string): Promise<string | Response> {
    const sample = sampleKey ? await publicFileUrl(linkBase(ctx), ctx.env.ORG_ID!, conn, sampleKey) : '';
    const res = await msg91(ctx.env, authKey, 'POST', '/whatsapp/client-panel-template/', createTemplatePayload(conn.number, t, sample));
    return res.ok ? '' : refusal(res, 'MSG91 did not take the template');
}

/** An email template to MSG91; gives the slug it is sent by, or the refusal. */
async function submitEmail(ctx: Ctx, t: TemplateInput, conn: Connection, authKey: string): Promise<string | Response> {
    const html = emailHtml(t, conn.email?.fromName ?? '');
    const res = await msg91(ctx.env, authKey, 'POST', '/email/templates', { name: t.name, slug: t.name, subject: t.headerText, body: html });
    if (!res.ok) return refusal(res, 'MSG91 did not take the email template');
    return text(res.data?.data?.slug) || text(res.data?.data?.versions?.[0]?.slug) || t.name;
}

/** POST /social/templates — saved here and sent to MSG91 (WhatsApp ones on to Meta for review). */
const templatesCreate: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const b = await body(ctx);
    const t = parseTemplate(b);
    if ('problem' in t) return err(t.problem);
    const needsSample = t.channel === 'whatsapp' && MEDIA_HEADERS.has(t.header);
    const sampleKey = needsSample ? uploadKey(b.sampleImageUrl) : '';
    if (needsSample && !sampleKey) return err('Add a sample file for the header: Meta wants to see one when it reviews the template.');
    const badSample = needsSample ? await mediaProblem(ctx.env, sampleKey, t.header) : null;
    if (badSample) return err(badSample);
    const acct = await account(ctx, t.channel);
    if (acct instanceof Response) return acct;
    const db = ctx.env.VAYU_DB;
    if (await db.prepare('SELECT 1 FROM social_templates WHERE name = ? AND language = ?').bind(t.name, t.language).first()) {
        return err(`There is already a template called "${t.name}". Choose another name.`, 409);
    }
    const namespace = t.channel === 'email' ? await submitEmail(ctx, t, acct.conn, acct.authKey) : await submitWhatsapp(ctx, t, acct.conn, acct.authKey, sampleKey);
    if (namespace instanceof Response) return namespace;
    const id = `tpl_${crypto.randomUUID()}`;
    await insertTemplate(db, id, t, 'pending', '', namespace).run();
    return json({ id, ...t, status: 'pending', reason: '', createdAt: Date.now() } satisfies SocialTemplate, 201);
};

// shortcut: removes it from this list only; the template stays in MSG91 (delete it there too once people ask).
const templatesDelete: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const id = TEMPLATE_PATH.exec(ctx.path)![1];
    const db = ctx.env.VAYU_DB;
    if (await db.prepare("SELECT 1 FROM social_invites WHERE template_id = ? AND status != 'sent'").bind(id).first()) {
        return err('An invite that has not finished sending uses this template.', 409);
    }
    const res = await db.prepare('DELETE FROM social_templates WHERE id = ?').bind(id).run();
    return res.meta.changes ? json({ ok: true }) : err('That template was not found.', 404);
};

// ── Audience ────────────────────────────────────────────────────────────────

/** `phone` holds the email address for an email invite. */
interface Person { contactId: string; name: string; phone: string }

const tagIdsOf = (raw: unknown): string[] =>
    [...new Set((Array.isArray(raw) ? raw : []).filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128))].slice(0, 20);

/** A contact's address for this channel: their first valid WhatsApp number (digits) or email (lowercase). */
function addressOf(c: Row, channel: Channel, country: string): string {
    const lists = contactLists(c);
    if (channel === 'email') return lists.emails.map(emailKey).find(Boolean)?.slice(2) ?? '';
    return lists.phones.map(p => phoneKey(p, country)).find(Boolean)?.slice(2) ?? ''; // "p:919876543210" → the digits MSG91 takes
}

/**
 * The contacts with any of these tags who can be reached on this channel: one
 * address each, nobody twice, nobody who said STOP or unsubscribed.
 * shortcut: the tag is the consent list (a "WhatsApp OK" tag); add a per-contact opt-in field if tags prove too loose.
 */
async function audience(env: Env, tagIds: string[], channel: Channel): Promise<{ total: number; optedOut: number; people: Person[] }> {
    if (!tagIds.length) return { total: 0, optedOut: 0, people: [] };
    await ensureContactSchema(env);
    const db = env.VAYU_DB;
    const country = await orgCountry(env);
    const [contacts, optouts] = await Promise.all([
        db.prepare(`SELECT DISTINCT c.id, c.name, c.phone, c.phones, c.email, c.emails FROM contacts c, json_each(c.tags) t
            WHERE t.value IN (${tagIds.map(() => '?').join(',')}) ORDER BY c.name`).bind(...tagIds).all<Row>(),
        db.prepare('SELECT phone FROM social_optouts').all<{ phone: string }>(),
    ]);
    const stopped = new Set(optouts.results.map(o => o.phone));
    const seen = new Set<string>();
    const people: Person[] = [];
    let optedOut = 0;
    for (const c of contacts.results) {
        const address = addressOf(c, channel, country);
        if (!address || seen.has(address)) continue;
        seen.add(address);
        if (stopped.has(address)) optedOut++; else people.push({ contactId: text(c.id), name: text(c.name), phone: address });
    }
    return { total: contacts.results.length, optedOut, people };
}

/** GET /social/audience?tags=a,b&channel= — how many people an invite to these tags would reach. */
const audienceGet: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const a = await audience(ctx.env, tagIdsOf((ctx.url.searchParams.get('tags') ?? '').split(',')), channelOf(ctx.url.searchParams.get('channel')));
    return json({ total: a.total, optedOut: a.optedOut, reachable: a.people.length, max: MAX_RECIPIENTS });
};

// ── Invites ─────────────────────────────────────────────────────────────────

/** What was typed for each of the template's own inputs; anything else sent is dropped. */
function valuesOf(t: SocialTemplate, raw: unknown): FieldValues {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return Object.fromEntries(sendSlots(t).map(s => [s.key, text(r[s.key]).trim().slice(0, 200)]));
}

function rowToInvite(env: Env, r: Row, templateName: string, counts: Counts): Invite {
    return {
        id: text(r.id), channel: channelOf(r.channel), name: text(r.name), templateId: text(r.template_id), templateName,
        tagIds: parseJson<string[]>(r.tag_ids, []), values: parseJson<FieldValues>(r.vals, {}),
        imageUrl: r.image_key ? fileUrl(env, text(r.image_key)) : '', status: text(r.status) as Invite['status'],
        sendAt: Number(r.send_at), createdAt: Number(r.created_at), createdByName: text(r.created_by_name), counts,
    };
}

async function countsByInvite(db: D1Database, inviteId?: string): Promise<Map<string, Counts>> {
    const { results } = await db.prepare(`SELECT invite_id, status, COUNT(*) AS n, SUM(rsvp = 'yes') AS yes, SUM(rsvp = 'no') AS no
        FROM social_recipients ${inviteId ? 'WHERE invite_id = ?' : ''} GROUP BY invite_id, status`).bind(...(inviteId ? [inviteId] : [])).all<Row>();
    const out = new Map<string, Counts>();
    for (const r of results) {
        const c = out.get(text(r.invite_id)) ?? emptyCounts();
        c[text(r.status) as RecipientStatus] += Number(r.n);
        c.total += Number(r.n); c.yes += Number(r.yes); c.no += Number(r.no);
        out.set(text(r.invite_id), c);
    }
    return out;
}

const templateNames = async (db: D1Database) =>
    new Map((await db.prepare('SELECT id, name FROM social_templates').all<{ id: string; name: string }>()).results.map(t => [t.id, t.name]));

/** GET /social/invites?channel= */
const invitesList: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const db = ctx.env.VAYU_DB;
    const channel = channelOf(ctx.url.searchParams.get('channel'));
    const [{ results }, counts, names] = await Promise.all([
        db.prepare('SELECT * FROM social_invites WHERE channel = ? ORDER BY created_at DESC LIMIT 200').bind(channel).all<Row>(), countsByInvite(db), templateNames(db),
    ]);
    return json({ invites: results.map(r => rowToInvite(ctx.env, r, names.get(text(r.template_id)) ?? '', counts.get(text(r.id)) ?? emptyCounts())) });
};

/** GET /social/invites/:id — the invite and each person's status. */
const invitesGet: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const id = INVITE_PATH.exec(ctx.path)![1];
    const db = ctx.env.VAYU_DB;
    const row = await db.prepare('SELECT * FROM social_invites WHERE id = ?').bind(id).first<Row>();
    if (!row) return err('That invite was not found.', 404);
    const [{ results }, counts, names] = await Promise.all([
        db.prepare('SELECT id, name, phone, status, reason, rsvp, status_at FROM social_recipients WHERE invite_id = ? ORDER BY name LIMIT ?').bind(id, MAX_RECIPIENTS).all<Row>(),
        countsByInvite(db, id), templateNames(db),
    ]);
    const recipients: Recipient[] = results.map(r => ({
        id: text(r.id), name: text(r.name), phone: text(r.phone), status: text(r.status) as RecipientStatus,
        reason: text(r.reason), rsvp: text(r.rsvp) as Recipient['rsvp'], at: Number(r.status_at),
    }));
    return json({ invite: rowToInvite(ctx.env, row, names.get(text(row.template_id)) ?? '', counts.get(id) ?? emptyCounts()), recipients });
};

interface Ready { template: SocialTemplate; namespace: string; values: FieldValues; mediaKey: string; mediaUrl: string }
/** What sending needs from a ready invite (the stored file's key stays behind). */
type ToSend = Omit<Ready, 'mediaKey'>;

/** What both a real invite and a test need: an approved template, its inputs filled, its header file. */
async function sendable(ctx: Ctx, b: Record<string, unknown>, conn: Connection): Promise<Ready | Response> {
    const row = await ctx.env.VAYU_DB.prepare('SELECT * FROM social_templates WHERE id = ?').bind(text(b.templateId)).first<Row>();
    if (!row) return err('Choose a template.');
    const template = rowToTemplate(row);
    if (template.status !== 'approved') return err(template.channel === 'email' ? 'MSG91 has not approved this email template yet.' : 'Meta has not approved this template yet. Choose an approved one.', 409);
    const values = valuesOf(template, b.values);
    const mediaKey = MEDIA_HEADERS.has(template.header) ? uploadKey(b.imageUrl) : '';
    const problem = inviteProblem(template, values, mediaKey) ?? (mediaKey ? await mediaProblem(ctx.env, mediaKey, template.header) : null);
    if (problem) return err(problem);
    const mediaUrl = mediaKey ? await publicFileUrl(linkBase(ctx), ctx.env.ORG_ID!, conn, mediaKey) : '';
    return { template, namespace: text(row.namespace), values, mediaKey, mediaUrl };
}

const whatsappPayload = (conn: Connection, r: ToSend, recipients: { id: string; phone: string; name: string }[]) =>
    sendPayload({ number: conn.number, namespace: r.namespace, values: r.values, imageUrl: r.mediaUrl, recipients, template: r.template });

interface Links { base: string; orgId: string }

/** One email request: each person with their own name, RSVP and unsubscribe links. */
async function emailPayload(conn: Connection, r: ToSend, links: Links, recipients: { id: string; phone: string; name: string }[]) {
    const sender = conn.email!;
    const people = await Promise.all(recipients.map(async p => {
        const rsvp = await hmacHex(conn.signKey, `rsvp|${p.id}`);
        const unsub = await hmacHex(conn.signKey, `unsub|${p.id}`);
        const at = `${links.orgId}/${p.id}`;
        const variables = emailVariables(r.template, r.values, p.name, {
            image_url: r.mediaUrl, rsvp_yes_url: `${links.base}/rsvp/${at}/${rsvp}/yes`, rsvp_no_url: `${links.base}/rsvp/${at}/${rsvp}/no`, unsubscribe_url: `${links.base}/unsub/${at}/${unsub}`,
        });
        return { to: [{ name: p.name || p.phone, email: p.phone }], variables };
    }));
    return {
        recipients: people, from: { name: sender.fromName, email: sender.from }, domain: sender.domain, template_id: r.namespace,
        ...(sender.replyTo ? { reply_to: [{ email: sender.replyTo }] } : {}),
    };
}

/** One request to MSG91 for these people, on the template's channel. */
async function sendTo(env: Env, conn: Connection, authKey: string, r: ToSend, links: Links, people: { id: string; phone: string; name: string }[]): Promise<Msg91Answer> {
    if (r.template.channel === 'email') return msg91(env, authKey, 'POST', '/email/send', await emailPayload(conn, r, links, people));
    return msg91(env, authKey, 'POST', '/whatsapp/whatsapp-outbound-message/bulk/', whatsappPayload(conn, r, people));
}

/** POST /social/test — the same message, to one number or address, before it goes to everyone. Not recorded. */
const testSend: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const b = await body(ctx);
    const acct = await account(ctx, channelOf(b.channel));
    if (acct instanceof Response) return acct;
    const ready = await sendable(ctx, b, acct.conn);
    if (ready instanceof Response) return ready;
    const email = ready.template.channel === 'email';
    const to = email ? emailKey(text(b.phone))?.slice(2) : phoneKey(text(b.phone), await orgCountry(ctx.env))?.slice(2);
    if (!to) return err(email ? 'Give the email address to send the test to.' : 'Give the WhatsApp number to send the test to.');
    const res = await sendTo(ctx.env, acct.conn, acct.authKey, ready, { base: linkBase(ctx), orgId: ctx.env.ORG_ID! }, [{ id: `test_${crypto.randomUUID()}`, phone: to, name: session.name }]);
    return res.ok ? json({ ok: true }) : refusal(res, 'MSG91 did not send it');
};

/** A new invite to these people, saved and (unless it is for later) sending; gives its id. */
async function createInvite(ctx: Ctx, session: SessionData, ready: Ready, name: string, tagIds: string[], people: Person[], sendAt: number): Promise<string> {
    const db = ctx.env.VAYU_DB;
    const now = Date.now();
    const id = `inv_${now}_${crypto.randomUUID().slice(0, 8)}`;
    const later = sendAt > now;
    const rows = people.map(p => db.prepare('INSERT INTO social_recipients (id, invite_id, contact_id, name, phone, status_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(`r_${crypto.randomUUID()}`, id, p.contactId, p.name, p.phone, now));
    // The invite row goes in with the first people: an invite never exists with nobody on it.
    const invite = db.prepare(`INSERT INTO social_invites (id, channel, name, template_id, tag_ids, vals, image_key, image_url, link_base, status, send_at, created_at, created_by, created_by_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, ready.template.channel, name, ready.template.id, JSON.stringify(tagIds), JSON.stringify(ready.values), ready.mediaKey,
        ready.mediaUrl, linkBase(ctx), later ? 'scheduled' : 'sending', later ? sendAt : now, now, session.userId, session.name);
    await db.batch([invite, ...rows.slice(0, 80)]);
    for (let i = 80; i < rows.length; i += 80) await db.batch(rows.slice(i, i + 80)); // NOSONAR: one write batch at a time keeps the load bounded
    // The scheduled job finishes what this request doesn't (long lists, later send times).
    await (ctx.env.SHARED_KV ?? ctx.env.VAYU_KV).put(`${PENDING}${ctx.env.ORG_ID}`, '1');
    if (!later) ctx.execCtx.waitUntil(deliverInvite(ctx.env, id).catch(e => console.error('Sending an invite failed:', e)));
    return id;
}

const inviteResponse = async (ctx: Ctx, id: string, templateName: string, people: number) => {
    const row = await ctx.env.VAYU_DB.prepare('SELECT * FROM social_invites WHERE id = ?').bind(id).first<Row>();
    return json(rowToInvite(ctx.env, row!, templateName, { ...emptyCounts(), total: people, queued: people }), 201);
};

/** POST /social/invites — the people are fixed now (even for a later send time), then sending starts. */
const invitesCreate: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const b = await body(ctx);
    const acct = await account(ctx, channelOf(b.channel));
    if (acct instanceof Response) return acct;
    const ready = await sendable(ctx, b, acct.conn);
    if (ready instanceof Response) return ready;
    const channel = ready.template.channel;
    const name = text(b.name).trim().slice(0, 120);
    if (!name) return err('Give the invite a name.');
    const tagIds = tagIdsOf(b.tagIds);
    if (!tagIds.length) return err('Choose who to send it to.');
    const now = Date.now();
    const sendAt = Number(b.sendAt) || 0;
    if (sendAt && (!Number.isFinite(sendAt) || sendAt < now - 60_000 || sendAt > now + 90 * 86_400_000)) return err('Choose a send time within the next 90 days.');
    const { people } = await audience(ctx.env, tagIds, channel);
    if (!people.length) return err(channel === 'email' ? 'Nobody with those tags has an email address to send to.' : 'Nobody with those tags has a WhatsApp number to send to.');
    if (people.length > MAX_RECIPIENTS) return err(`One invite can go to ${MAX_RECIPIENTS} people. These tags have ${people.length}; split them.`, 409);
    const id = await createInvite(ctx, session, ready, name, tagIds, people, sendAt);
    return inviteResponse(ctx, id, ready.template.name, people.length);
};

/** DELETE /social/invites/:id — a scheduled invite that hasn't started is called off (it and its list are removed). */
const invitesCancel: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const id = INVITE_PATH.exec(ctx.path)![1];
    const db = ctx.env.VAYU_DB;
    // Only while still scheduled: the status check is part of the delete, so a send that just started can't be cut in half.
    const res = await db.prepare("DELETE FROM social_invites WHERE id = ? AND status = 'scheduled'").bind(id).run();
    if (!res.meta.changes) return err('Only an invite that is still scheduled can be cancelled.', 409);
    await db.prepare('DELETE FROM social_recipients WHERE invite_id = ?').bind(id).run();
    return json({ ok: true });
};

/** POST /social/invites/:id/retry — a new invite, the same message, to the people this one failed to reach (and who haven't opted out since). */
const invitesRetry: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const id = RETRY_PATH.exec(ctx.path)![1];
    const db = ctx.env.VAYU_DB;
    const invite = await db.prepare('SELECT * FROM social_invites WHERE id = ?').bind(id).first<Row>();
    if (!invite) return err('That invite was not found.', 404);
    if (invite.status !== 'sent') return err('Wait until this invite has finished sending.', 409);
    const acct = await account(ctx, channelOf(invite.channel));
    if (acct instanceof Response) return acct;
    const row = await db.prepare('SELECT * FROM social_templates WHERE id = ?').bind(invite.template_id).first<Row>();
    if (!row) return err('Its template was removed, so it can’t be sent again.', 409);
    const template = rowToTemplate(row);
    if (template.status !== 'approved') return err('Its template is no longer approved.', 409);
    const { results } = await db.prepare(`SELECT contact_id, name, phone FROM social_recipients WHERE invite_id = ? AND status = 'failed'
        AND phone NOT IN (SELECT phone FROM social_optouts)`).bind(id).all<Row>();
    const people: Person[] = results.map(r => ({ contactId: text(r.contact_id), name: text(r.name), phone: text(r.phone) }));
    if (!people.length) return err('Nobody failed on this invite (or they have since opted out).', 409);
    const ready: Ready = { template, namespace: text(row.namespace), values: parseJson<FieldValues>(invite.vals, {}), mediaKey: text(invite.image_key), mediaUrl: text(invite.image_url) };
    const newId = await createInvite(ctx, session, ready, `${text(invite.name)} (again)`.slice(0, 120), parseJson<string[]>(invite.tag_ids, []), people, 0);
    return inviteResponse(ctx, newId, template.name, people.length);
};

export interface TagReach { tagId: string; name: string; contacts: number; whatsapp: number; email: number }
interface Tally { contacts: number; wa: Set<string>; em: Set<string> }

/** Adds one contact (its reachable addresses) to the totals and to each of its tags. */
function tally(c: Row, country: string, stopped: Set<string>, all: Tally, byTag: Map<string, Tally>): void {
    const usable = (address: string) => (address && !stopped.has(address) ? address : '');
    const wa = usable(addressOf(c, 'whatsapp', country));
    const em = usable(addressOf(c, 'email', country));
    for (const t of [all, ...parseJson<string[]>(c.tags, []).flatMap(id => byTag.get(id) ?? [])]) {
        if (t !== all) t.contacts++;
        if (wa) t.wa.add(wa);
        if (em) t.em.add(em);
    }
}

/** GET /social/reach — for each tag, how many of its contacts each channel can reach; and the opt-outs. */
const reachGet: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    await ensureContactSchema(ctx.env);
    const db = ctx.env.VAYU_DB;
    const country = await orgCountry(ctx.env);
    const [contacts, tags, optouts] = await Promise.all([
        db.prepare('SELECT id, phone, phones, email, emails, tags FROM contacts').all<Row>(),
        db.prepare('SELECT id, name FROM contact_tags ORDER BY name_key').all<{ id: string; name: string }>(),
        db.prepare('SELECT phone, at FROM social_optouts ORDER BY at DESC LIMIT 500').all<{ phone: string; at: number }>(),
    ]);
    const stopped = new Set(optouts.results.map(o => o.phone));
    const byTag = new Map(tags.results.map(t => [t.id, { contacts: 0, wa: new Set<string>(), em: new Set<string>() }]));
    const all: Tally = { contacts: contacts.results.length, wa: new Set(), em: new Set() };
    for (const c of contacts.results) tally(c, country, stopped, all, byTag);
    return json({
        totals: { contacts: all.contacts, whatsapp: all.wa.size, email: all.em.size, optedOut: optouts.results.length },
        tags: tags.results.map(t => {
            const r = byTag.get(t.id)!;
            return { tagId: t.id, name: t.name, contacts: r.contacts, whatsapp: r.wa.size, email: r.em.size } satisfies TagReach;
        }),
        optouts: optouts.results.map(o => ({ address: o.phone, at: Number(o.at) })),
    });
};

// ── Sending ─────────────────────────────────────────────────────────────────

const failQueued = (db: D1Database, inviteId: string, reason: string) =>
    db.prepare("UPDATE social_recipients SET status = 'failed', reason = ?, status_at = ? WHERE invite_id = ? AND status = 'queued'").bind(reason, Date.now(), inviteId).run();

/** The id MSG91 gave a request, which its reports carry. */
const requestIdOf = (res: Msg91Answer) => text(res.data?.request_id) || text(res.data?.data?.unique_id);

/** Up to a run's worth of chunks to MSG91. Each chunk's people are claimed first, so no run (or crash) sends to them again. */
async function sendChunks(env: Env, invite: Row, template: Row, conn: Connection, authKey: string): Promise<void> {
    const db = env.VAYU_DB;
    const ready = { template: rowToTemplate(template), namespace: text(template.namespace), values: parseJson<FieldValues>(invite.vals, {}), mediaUrl: text(invite.image_url) };
    const links = { base: text(invite.link_base) || `${env.API_ORIGIN ?? ''}/api/v2/social`, orgId: env.ORG_ID ?? '' };
    for (let i = 0; i < CHUNKS_PER_RUN; i++) {
        const claim = crypto.randomUUID();
        await db.prepare(`UPDATE social_recipients SET status = 'submitted', claim = ?, status_at = ? WHERE id IN
            (SELECT id FROM social_recipients WHERE invite_id = ? AND status = 'queued' LIMIT ${CHUNK})`).bind(claim, Date.now(), invite.id).run(); // NOSONAR: chunks go in turn
        const claimed = db.prepare('SELECT id, phone, name FROM social_recipients WHERE claim = ?').bind(claim);
        const { results } = await claimed.all<{ id: string; phone: string; name: string }>(); // NOSONAR: chunks go in turn
        if (!results.length) return;
        const res = await sendTo(env, conn, authKey, ready, links, results); // NOSONAR: chunks go in turn
        if (res.ok) {
            await db.prepare('UPDATE social_recipients SET request_id = ? WHERE claim = ?').bind(requestIdOf(res), claim).run(); // NOSONAR: chunks go in turn
            continue;
        }
        const reason = res.status === 401 ? 'MSG91 refused the key.' : res.error;
        await db.prepare("UPDATE social_recipients SET status = 'failed', reason = ?, status_at = ? WHERE claim = ? AND status = 'submitted'").bind(reason, Date.now(), claim).run(); // NOSONAR: chunks go in turn
        // A refused key refuses everyone: stop asking.
        if (res.status === 401) {
            await failQueued(db, text(invite.id), reason); // NOSONAR: ends the loop
            return;
        }
    }
}

/** Why an invite's people can't be sent to now, or null. */
function cannotSend(channel: Channel, conn: Connection | null, authKey: string | null, template: Row | null): string | null {
    if (!conn || !authKey) return 'The MSG91 account was disconnected before this was sent.';
    if (!template) return 'Its template was deleted before this was sent.';
    if (channel === 'email' && !conn.email) return 'The email sender was removed before this was sent.';
    return null;
}

/** Sends an invite's queued people, a chunk at a time; true when nobody is left queued. */
async function deliverInvite(env: Env, inviteId: string): Promise<boolean> {
    const db = env.VAYU_DB;
    const invite = await db.prepare('SELECT * FROM social_invites WHERE id = ?').bind(inviteId).first<Row>();
    if (!invite || invite.status === 'sent') return true;
    if (invite.status === 'scheduled') {
        if (Number(invite.send_at) > Date.now()) return false;
        await db.prepare("UPDATE social_invites SET status = 'sending' WHERE id = ?").bind(inviteId).run();
    }
    const conn = await readConnection(env);
    const authKey = conn ? await authKeyOf(env, conn) : null;
    const template = await db.prepare('SELECT * FROM social_templates WHERE id = ?').bind(invite.template_id).first<Row>();
    const blocked = cannotSend(channelOf(invite.channel), conn, authKey, template);
    if (blocked) await failQueued(db, inviteId, blocked);
    else await sendChunks(env, invite, template!, conn!, authKey!);
    const left = await db.prepare("SELECT COUNT(*) AS n FROM social_recipients WHERE invite_id = ? AND status = 'queued'").bind(inviteId).first<{ n: number }>();
    if (Number(left?.n ?? 0) > 0) return false;
    await db.prepare("UPDATE social_invites SET status = 'sent' WHERE id = ?").bind(inviteId).run();
    return true;
}

async function orgEnvById(env: Env, orgId: string): Promise<Env | null> {
    if (!env.PLATFORM_DB) return null;
    const org = await env.PLATFORM_DB.prepare("SELECT id, app_storage FROM organizations WHERE id = ? AND status = 'active'")
        .bind(orgId).first<{ id: string; app_storage: 'own' | 'original' }>();
    return org ? orgStorageEnv(env, org) : null;
}

/** One workspace's due invites; true when it has none left waiting. */
async function deliverWorkspace(space: Env): Promise<boolean> {
    const db = space.VAYU_DB;
    await ensureSocialTables(db);
    const due = db.prepare("SELECT id FROM social_invites WHERE status = 'sending' OR (status = 'scheduled' AND send_at <= ?)").bind(Date.now());
    const { results } = await due.all<{ id: string }>();
    for (const { id } of results) await deliverInvite(space, id); // NOSONAR: one invite at a time
    return !(await db.prepare("SELECT 1 FROM social_invites WHERE status != 'sent'").first());
}

/** The scheduled job: carries on long invites and starts ones whose send time has come, in the workspaces that have any. */
export async function deliverDueInvites(env: Env): Promise<void> {
    const { keys } = await env.VAYU_KV.list({ prefix: PENDING });
    for (const { name } of keys) {
        try {
            const space = await orgEnvById(env, name.slice(PENDING.length)); // NOSONAR: workspaces go in turn
            const finished = !space || await deliverWorkspace(space); // NOSONAR: workspaces go in turn
            if (finished) await env.VAYU_KV.delete(name); // NOSONAR: workspaces go in turn
        } catch (e) {
            console.error(JSON.stringify({ event: 'social_delivery_failed', org: name.slice(PENDING.length), reason: (e as Error).message?.slice(0, 200) }));
        }
    }
}

// ── What MSG91, WhatsApp and email readers call, without a sign-in ──────────

const ORG = '([A-Za-z0-9-]{1,64})';
const HOOK_PATH = new RegExp(`^/api/v2/webhooks/msg91/${ORG}/([a-f0-9]{48})$`);
const FILE_PATH = new RegExp(`^/api/v2/social/image/${ORG}/([a-f0-9]{32})/(.+)$`);
const RSVP_PATH = new RegExp(`^/api/v2/social/rsvp/${ORG}/(${ID})/([a-f0-9]{32})/(yes|no)$`);
const UNSUB_PATH = new RegExp(`^/api/v2/social/unsub/${ORG}/(${ID})/([a-f0-9]{32})$`);

type StatusEvent = Extract<WebhookEvent, { kind: 'status' }>;
type ReplyEvent = Extract<WebhookEvent, { kind: 'reply' }>;
type Tracked = { id: string; status: RecipientStatus };

/** The person a report is about: by the id sent with the message, by MSG91's request and the address, or their latest message. */
async function trackedRow(db: D1Database, ev: StatusEvent): Promise<Tracked | null> {
    if (ev.id) {
        const byId = await db.prepare('SELECT id, status FROM social_recipients WHERE id = ?').bind(ev.id).first<Tracked>();
        if (byId) return byId;
    }
    if (ev.requestId) {
        const byRequest = await db.prepare('SELECT id, status FROM social_recipients WHERE request_id = ? AND phone = ?').bind(ev.requestId, ev.phone).first<Tracked>();
        if (byRequest) return byRequest;
    }
    // shortcut: an email report without our ids goes to that address's latest message (within two weeks); send crqid once MSG91 confirms email takes it.
    return ev.phone.includes('@')
        ? db.prepare(`SELECT id, status FROM social_recipients WHERE phone = ? AND status != 'queued' AND status_at > ? ORDER BY rowid DESC LIMIT 1`)
            .bind(ev.phone, Date.now() - 14 * 86_400_000).first<Tracked>()
        : null;
}

/** A delivery report: the person moves forward, never back. */
async function applyStatus(db: D1Database, ev: StatusEvent): Promise<void> {
    const row = await trackedRow(db, ev);
    if (!row) return;
    const status = nextStatus(row.status, ev.status);
    if (status === row.status) return;
    const reason = status === 'failed' ? ev.reason || 'It could not be delivered.' : '';
    // The status it was read at is part of the write: two reports racing can only move it forward.
    await db.prepare('UPDATE social_recipients SET status = ?, reason = ?, status_at = ? WHERE id = ? AND status = ?')
        .bind(status, reason, Date.now(), row.id, row.status).run();
}

const optOut = (db: D1Database, address: string) => db.prepare('INSERT OR IGNORE INTO social_optouts (phone, at) VALUES (?, ?)').bind(address, Date.now()).run();

/** Their answer belongs to the latest invite they were sent (within a month). */
const saveRsvp = (db: D1Database, address: string, rsvp: Rsvp) => db.prepare(`UPDATE social_recipients SET rsvp = ? WHERE id = (SELECT id FROM social_recipients
    WHERE phone = ? AND status != 'failed' AND status != 'queued' AND status_at > ? ORDER BY rowid DESC LIMIT 1)`).bind(rsvp, address, Date.now() - 30 * 86_400_000).run();

/** A WhatsApp reply: STOP leaves the number out from now on; yes / no is their RSVP. */
async function applyReply(db: D1Database, ev: ReplyEvent): Promise<void> {
    if (isStop(ev.text)) {
        await optOut(db, ev.phone);
        return;
    }
    const rsvp = rsvpOf(ev.text);
    if (rsvp) await saveRsvp(db, ev.phone, rsvp);
}

async function applyEvent(db: D1Database, raw: unknown): Promise<void> {
    const ev = parseWebhook(raw);
    if (ev?.kind === 'status') await applyStatus(db, ev);
    else if (ev?.kind === 'reply') await applyReply(db, ev);
    else if (ev?.kind === 'stop') await optOut(db, ev.phone);
}

const notFound = () => err('Not found', 404);

/** MSG91's delivery reports and replies, WhatsApp and email, one or several to a call. */
async function receiveReports(request: Request, space: Env, conn: Connection, token: string): Promise<Response> {
    if (request.method !== 'POST') return err('Use POST', 405);
    if (!timingSafeEqual(token, conn.hookToken)) return notFound();
    const payload = await request.json().catch(() => null);
    // Always 200 once the address is right: MSG91 pauses a webhook that answers 4xx.
    for (const one of (Array.isArray(payload) ? payload : [payload]).slice(0, 200)) {
        await applyEvent(space.VAYU_DB, one).catch(e => console.error('A MSG91 report was not applied:', e)); // NOSONAR: reports for one person must apply in order
    }
    return json({ ok: true });
}

const PUBLIC_TYPES = /^(image\/(jpeg|png)|video\/(mp4|3gpp)|application\/pdf)$/;

/** An invite's header file, for WhatsApp and email readers: only with this workspace's signature for that file, and only a picture, video or PDF. */
async function serveFile(request: Request, space: Env, conn: Connection, signature: string, key: string): Promise<Response> {
    if (request.method !== 'GET' || !uploadKeyOk(key) || !timingSafeEqual(signature, await hmacHex(conn.signKey, key))) return notFound();
    const obj = await space.VAYU_R2.get(key);
    const type = obj?.httpMetadata?.contentType ?? '';
    // Anything else stays behind the staff app.
    if (!obj || !PUBLIC_TYPES.test(type)) return notFound();
    return new Response(obj.body, { headers: { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'private, max-age=3600' } });
}

/** A small page for someone who tapped a link in an email. */
function page(title: string, line: string): Response {
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;font-family:Arial,Helvetica,sans-serif;background:#f4f2ee;color:#1f1f1f"><div style="max-width:440px;margin:15vh auto;padding:28px;background:#fff;border-radius:12px;text-align:center">
<h1 style="font-size:20px;margin:0 0 10px">${title}</h1><p style="margin:0;line-height:1.5;color:#555">${line}</p></div></body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'Cache-Control': 'no-store' } });
}

/** RSVP from an email: the signature proves the link was ours, for that person. */
async function receiveRsvp(space: Env, conn: Connection, recipientId: string, signature: string, answer: Rsvp): Promise<Response> {
    if (!timingSafeEqual(signature, await hmacHex(conn.signKey, `rsvp|${recipientId}`))) return notFound();
    const res = await space.VAYU_DB.prepare('UPDATE social_recipients SET rsvp = ? WHERE id = ?').bind(answer, recipientId).run();
    if (!res.meta.changes) return page('Thank you', 'This was a test email, so nothing was recorded.');
    return answer === 'yes' ? page('See you there', 'Thank you. We’ve noted that you’re coming.') : page('Thank you for letting us know', 'We’ve noted that you can’t make it.');
}

/** Unsubscribe from an email: that address gets no more invites from this workspace. */
async function receiveUnsubscribe(space: Env, conn: Connection, recipientId: string, signature: string): Promise<Response> {
    if (!timingSafeEqual(signature, await hmacHex(conn.signKey, `unsub|${recipientId}`))) return notFound();
    const row = await space.VAYU_DB.prepare('SELECT phone FROM social_recipients WHERE id = ?').bind(recipientId).first<{ phone: string }>();
    if (!row) return page('Unsubscribed', 'This was a test email, so nothing was changed.');
    await optOut(space.VAYU_DB, row.phone);
    return page('You’re unsubscribed', 'You won’t get more invitations by email from us.');
}

/**
 * Public addresses: POST /api/v2/webhooks/msg91/<org>/<token> (MSG91's reports
 * and replies), GET /api/v2/social/image/<org>/<sig>/<file> (an invite's file),
 * /rsvp/<org>/<person>/<sig>/<yes|no> and /unsub/<org>/<person>/<sig> (email
 * links). Null for any other address.
 */
export async function handleSocialPublic(request: Request, env: Env): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    const match = [HOOK_PATH, FILE_PATH, RSVP_PATH, UNSUB_PATH].map(re => re.exec(path));
    const [hook, file, rsvp, unsub] = match;
    const found = match.find(Boolean);
    if (!found) return null;
    const space = await orgEnvById(env, found[1]);
    if (!space) return notFound();
    await ensureSocialTables(space.VAYU_DB);
    const conn = await readConnection(space);
    if (!conn) return notFound();
    if (hook) return receiveReports(request, space, conn, hook[2]);
    if (request.method !== 'GET') return err('Use GET', 405);
    if (file) return serveFile(request, space, conn, file[2], file[3]); // upload keys need no decoding
    if (rsvp) return receiveRsvp(space, conn, rsvp[2], rsvp[3], rsvp[4] as Rsvp);
    return receiveUnsubscribe(space, conn, unsub![2], unsub![3]);
}

// ── Routes ──────────────────────────────────────────────────────────────────

const isExact = (p: string) => (path: string) => path === p;

export const socialRoutes: SocialRoute[] = [
    { method: 'GET', match: isExact('/social/whatsapp'), handler: connectionGet },
    { method: 'PUT', match: isExact('/social/whatsapp'), handler: connectionPut },
    { method: 'DELETE', match: isExact('/social/whatsapp'), handler: connectionDelete },
    { method: 'PUT', match: isExact('/social/email'), handler: emailSenderPut },
    { method: 'GET', match: isExact('/social/templates'), handler: templatesList },
    { method: 'POST', match: isExact('/social/templates'), handler: templatesCreate },
    { method: 'DELETE', match: p => TEMPLATE_PATH.test(p), handler: templatesDelete },
    { method: 'GET', match: isExact('/social/audience'), handler: audienceGet },
    { method: 'POST', match: isExact('/social/test'), handler: testSend },
    { method: 'GET', match: isExact('/social/invites'), handler: invitesList },
    { method: 'POST', match: isExact('/social/invites'), handler: invitesCreate },
    { method: 'GET', match: p => INVITE_PATH.test(p), handler: invitesGet },
    { method: 'DELETE', match: p => INVITE_PATH.test(p), handler: invitesCancel },
    { method: 'POST', match: p => RETRY_PATH.test(p), handler: invitesRetry },
    { method: 'GET', match: isExact('/social/reach'), handler: reachGet },
];
