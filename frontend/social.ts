// Social → WhatsApp invites, sent through each workspace's own MSG91 account
// (docs/IMPLEMENTATION_PLAN.md 8.5): the connection, templates and their Meta
// review, invites to contacts by tag, and who each one reached.
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
import { phoneKey } from './contactKeys';
import { delivery } from './fileTypes';
import { decryptSecret, encryptSecret, reportDecryptFailure, secretsConfigured } from './platform/secrets';
import {
    MAX_RECIPIENTS, createTemplatePayload, emptyCounts, inviteProblem, isStop, nextStatus, parseTemplate, parseWebhook, rsvpOf,
    sendPayload, accountTemplates, templateFields, type Counts, type WebhookEvent, type FieldValues, type Invite, type Recipient, type RecipientStatus, type SocialTemplate,
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

function ensureSocialTables(db: D1Database): Promise<void> {
    return runSetupOnce(db, 'socialTables', () => db.batch([
        db.prepare('CREATE TABLE IF NOT EXISTS social_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'),
        db.prepare(`CREATE TABLE IF NOT EXISTS social_templates (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, language TEXT NOT NULL, body TEXT NOT NULL, footer TEXT NOT NULL DEFAULT '',
            image INTEGER NOT NULL DEFAULT 0, rsvp INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
            reason TEXT NOT NULL DEFAULT '', namespace TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, UNIQUE (name, language))`),
        db.prepare(`CREATE TABLE IF NOT EXISTS social_invites (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, template_id TEXT NOT NULL, tag_ids TEXT NOT NULL DEFAULT '[]', vals TEXT NOT NULL DEFAULT '{}',
            image_key TEXT NOT NULL DEFAULT '', image_url TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, send_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL, created_by TEXT NOT NULL, created_by_name TEXT NOT NULL)`),
        db.prepare(`CREATE TABLE IF NOT EXISTS social_recipients (
            id TEXT PRIMARY KEY, invite_id TEXT NOT NULL, contact_id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued', reason TEXT NOT NULL DEFAULT '', rsvp TEXT NOT NULL DEFAULT '',
            status_at INTEGER NOT NULL, claim TEXT, request_id TEXT)`),
        db.prepare('CREATE INDEX IF NOT EXISTS idx_social_recipients_invite ON social_recipients (invite_id, status)'),
        db.prepare('CREATE INDEX IF NOT EXISTS idx_social_recipients_phone ON social_recipients (phone)'),
        db.prepare('CREATE INDEX IF NOT EXISTS idx_social_recipients_claim ON social_recipients (claim)'),
        db.prepare('CREATE TABLE IF NOT EXISTS social_optouts (phone TEXT PRIMARY KEY, at INTEGER NOT NULL)'),
    ]));
}

// ── The MSG91 account ───────────────────────────────────────────────────────

interface Connection {
    number: string;
    /** Encrypted (platform/secrets.ts); never sent to the app. */
    authKey: string;
    /** In the delivery-updates address: MSG91 doesn't sign its calls, so the address itself is the secret. */
    hookToken: string;
    /** Signs the public addresses of invite pictures (WhatsApp fetches them without a sign-in). */
    signKey: string;
    connectedAt: number;
    connectedBy: string;
}

const keyContext = (env: Env) => `${env.ORG_ID}|msg91|authkey`;
const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes))).map(b => b.toString(16).padStart(2, '0')).join('');

async function readConnection(env: Env): Promise<Connection | null> {
    const row = await env.VAYU_DB.prepare("SELECT value FROM social_settings WHERE key = 'whatsapp'").first<{ value: string }>();
    return row ? JSON.parse(row.value) as Connection : null;
}

async function authKeyOf(env: Env, conn: Connection): Promise<string | null> {
    try {
        return await decryptSecret(env, keyContext(env), conn.authKey);
    } catch (e) {
        reportDecryptFailure(keyContext(env), e, 'social');
        return null;
    }
}

interface Msg91Answer { ok: boolean; status: number; data: any; error: string }

/** One MSG91 WhatsApp API call. A 200 can still be a refusal (hasError), so both are checked. */
async function msg91(env: Env, authKey: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Msg91Answer> {
    // MSG91_API_BASE: tests only, honoured only in development (like RAZORPAY_API_BASE).
    const base = env.PLATFORM_ENV === 'development' && env.MSG91_API_BASE ? env.MSG91_API_BASE.replace(/\/$/, '') : 'https://control.msg91.com';
    try {
        const res = await fetch(`${base}/api/v5/whatsapp${path}`, {
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

const apiOrigin = (ctx: Ctx) => ctx.env.API_ORIGIN || ctx.url.origin;
const hookUrl = (ctx: Ctx, conn: Connection) => `${apiOrigin(ctx)}/api/v2/webhooks/msg91/${ctx.env.ORG_ID}/${conn.hookToken}`;

async function hmacHex(key: string, message: string): Promise<string> {
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message)));
    return Array.from(sig.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** An uploaded picture's storage key from its address in the app; '' when it isn't one of this workspace's uploads. */
function uploadKey(url: unknown): string {
    const key = typeof url === 'string' ? fileKeyFromUrl(url.split('?')[0]) : null;
    return key && uploadKeyOk(key) ? key : '';
}
const uploadKeyOk = (key: string) => key.startsWith('uploads/') && !key.includes('..');

/** WhatsApp's own limits on a template picture, checked here so the refusal is in plain words. */
async function imageProblem(env: Env, key: string): Promise<string | null> {
    const head = await env.VAYU_R2.head(key);
    if (!head) return 'That picture was not found. Add it again.';
    if (!/^image\/(jpeg|png)$/.test(head.httpMetadata?.contentType ?? '')) return 'WhatsApp takes JPG or PNG pictures only.';
    return head.size > 5 * 1024 * 1024 ? 'WhatsApp takes pictures up to 5 MB. Choose a smaller one.' : null;
}

/** Where WhatsApp fetches a picture: public, but only with this workspace's signature for that one file. */
async function publicImageUrl(ctx: Ctx, conn: Connection, key: string): Promise<string> {
    return `${apiOrigin(ctx)}/api/v2/social/image/${ctx.env.ORG_ID}/${await hmacHex(conn.signKey, key)}/${key}`;
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

/** The connection and its key, or the answer that says what is missing. */
async function account(ctx: Ctx): Promise<{ conn: Connection; authKey: string } | Response> {
    const conn = await readConnection(ctx.env);
    if (!conn) return err('Connect your MSG91 WhatsApp number first.', 409);
    const authKey = await authKeyOf(ctx.env, conn);
    if (!authKey) return err('The saved MSG91 key could not be read. Connect it again.', 409);
    return { conn, authKey };
}

// ── Connection routes ───────────────────────────────────────────────────────

const connectionGet: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const conn = await readConnection(ctx.env);
    return json(conn
        ? { connected: true, number: conn.number, webhookUrl: hookUrl(ctx, conn), connectedAt: conn.connectedAt }
        : { connected: false, available: secretsConfigured(ctx.env) });
};

/** MSG91's refusal as this API's answer: a refused key says how to fix it; anything else, what MSG91 said. */
const refusal = (res: Msg91Answer, what: string): Response =>
    (res.status === 401 ? err(KEY_REFUSED) : err(`${what}: ${res.error}`, 502));

/** The WhatsApp numbers on a key's MSG91 account, or the answer that says why there are none to use. */
async function accountNumbers(env: Env, authKey: string): Promise<string[] | Response> {
    const res = await msg91(env, authKey, 'GET', '/whatsapp-activation/');
    if (!res.ok) return refusal(res, 'MSG91 said');
    const list = (Array.isArray(res.data?.data) ? res.data.data : []) as Row[];
    const numbers = list.map(n => text(n?.integrated_number).replaceAll(/\D/g, '')).filter(Boolean);
    return numbers.length ? numbers : err('This MSG91 account has no WhatsApp number yet. Finish the WhatsApp setup in MSG91, then connect.', 409);
}

/** The number to send from: the one asked for if the account has it, or its only one; otherwise the answer that lists them. */
function chooseNumber(numbers: string[], wanted: string): string | Response {
    if (numbers.includes(wanted)) return wanted;
    if (!wanted && numbers.length === 1) return numbers[0];
    const list = numbers.map(n => `+${n}`).join(', ');
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
    if (session.role !== ADMIN_ROLE_ID) return err('Only an admin can connect the WhatsApp number.', 403);
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
        connectedAt: Date.now(), connectedBy: session.userId,
    };
    await ctx.env.VAYU_DB.prepare("INSERT INTO social_settings (key, value) VALUES ('whatsapp', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(JSON.stringify(conn)).run();
    return json({ connected: true, number, webhookUrl: hookUrl(ctx, conn), connectedAt: conn.connectedAt });
};

const connectionDelete: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    if (session.role !== ADMIN_ROLE_ID) return err('Only an admin can disconnect the WhatsApp number.', 403);
    await ctx.env.VAYU_DB.prepare("DELETE FROM social_settings WHERE key = 'whatsapp'").run();
    return json({ connected: false, available: secretsConfigured(ctx.env) });
};

// ── Templates ───────────────────────────────────────────────────────────────

const rowToTemplate = (r: Row): SocialTemplate => ({
    id: text(r.id), name: text(r.name), language: text(r.language), body: text(r.body), footer: text(r.footer),
    image: !!r.image, rsvp: !!r.rsvp, status: text(r.status) as SocialTemplate['status'], reason: text(r.reason), createdAt: Number(r.created_at),
});

/** GET /social/templates[?refresh=1] — refresh asks MSG91 how Meta's review went. */
const templatesList: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const db = ctx.env.VAYU_DB;
    let checked = false;
    let skipped = 0;
    if (ctx.url.searchParams.get('refresh') === '1') {
        const acct = await account(ctx);
        const res = acct instanceof Response ? null : await msg91(ctx.env, acct.authKey, 'GET', `/get-template-client/${acct.conn.number}`);
        if (res?.ok) {
            checked = true;
            const { results } = await db.prepare('SELECT id, name, language, status, reason, namespace FROM social_templates').all<Row>();
            const mine = new Map(results.map(r => [`${text(r.name)}|${text(r.language)}`, r]));
            // Ours: Meta's review result. Not ours yet (made in MSG91's own panel): brought in, if this app can send it.
            const changes = accountTemplates(res.data).flatMap(t => {
                const r = mine.get(`${t.name}|${t.language}`);
                if (r) {
                    if (t.status === r.status && t.reason === r.reason && t.namespace === r.namespace) return [];
                    return [db.prepare('UPDATE social_templates SET status = ?, reason = ?, namespace = ? WHERE id = ?').bind(t.status, t.reason, t.namespace, r.id)];
                }
                if (!t.sendable) { skipped++; return []; }
                return [db.prepare(`INSERT OR IGNORE INTO social_templates (id, name, language, body, footer, image, rsvp, status, reason, namespace, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`).bind(`tpl_${crypto.randomUUID()}`, t.name, t.language, t.body, t.footer, Number(t.image), t.status, t.reason, t.namespace, Date.now())];
            });
            for (let i = 0; i < changes.length; i += 50) await db.batch(changes.slice(i, i + 50)); // NOSONAR: one write batch at a time
        }
    }
    const { results } = await db.prepare('SELECT * FROM social_templates ORDER BY created_at DESC').all<Row>();
    return json({ templates: results.map(rowToTemplate), checked, skipped });
};

/** POST /social/templates — saved here and sent to MSG91, which passes it to Meta for review. */
const templatesCreate: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const b = await body(ctx);
    const t = parseTemplate(b);
    if ('problem' in t) return err(t.problem);
    const sampleKey = uploadKey(b.sampleImageUrl);
    if (t.image && !sampleKey) return err('Add a sample picture: Meta wants to see one when it reviews the template.');
    const badSample = t.image ? await imageProblem(ctx.env, sampleKey) : null;
    if (badSample) return err(badSample);
    const acct = await account(ctx);
    if (acct instanceof Response) return acct;
    const db = ctx.env.VAYU_DB;
    if (await db.prepare('SELECT 1 FROM social_templates WHERE name = ? AND language = ?').bind(t.name, t.language).first()) {
        return err(`There is already a template called "${t.name}". Choose another name.`, 409);
    }
    const sample = t.image ? await publicImageUrl(ctx, acct.conn, sampleKey) : '';
    const res = await msg91(ctx.env, acct.authKey, 'POST', '/client-panel-template/', createTemplatePayload(acct.conn.number, t, sample));
    if (!res.ok) return refusal(res, 'MSG91 did not take the template');
    const row = { id: `tpl_${crypto.randomUUID()}`, ...t, status: 'pending' as const, reason: '', createdAt: Date.now() };
    await db.prepare('INSERT INTO social_templates (id, name, language, body, footer, image, rsvp, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(row.id, t.name, t.language, t.body, t.footer, Number(t.image), Number(t.rsvp), row.status, row.createdAt).run();
    return json(row satisfies SocialTemplate, 201);
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

interface Person { contactId: string; name: string; phone: string }

const tagIdsOf = (raw: unknown): string[] =>
    [...new Set((Array.isArray(raw) ? raw : []).filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128))].slice(0, 20);

/**
 * The contacts with any of these tags who can be messaged: one WhatsApp
 * number each (their first valid one), nobody twice, nobody who replied STOP.
 * shortcut: the tag is the consent list (a "WhatsApp OK" tag); add a per-contact opt-in field if tags prove too loose.
 */
async function audience(env: Env, tagIds: string[]): Promise<{ total: number; optedOut: number; people: Person[] }> {
    if (!tagIds.length) return { total: 0, optedOut: 0, people: [] };
    await ensureContactSchema(env);
    const db = env.VAYU_DB;
    const country = await orgCountry(env);
    const [contacts, optouts] = await Promise.all([
        db.prepare(`SELECT DISTINCT c.id, c.name, c.phone, c.phones FROM contacts c, json_each(c.tags) t WHERE t.value IN (${tagIds.map(() => '?').join(',')}) ORDER BY c.name`)
            .bind(...tagIds).all<Row>(),
        db.prepare('SELECT phone FROM social_optouts').all<{ phone: string }>(),
    ]);
    const stopped = new Set(optouts.results.map(o => o.phone));
    const seen = new Set<string>();
    const people: Person[] = [];
    let optedOut = 0;
    for (const c of contacts.results) {
        const key = contactLists(c).phones.map(p => phoneKey(p, country)).find(Boolean);
        const phone = key?.slice(2); // "p:919876543210" → the digits MSG91 takes
        if (!phone || seen.has(phone)) continue;
        seen.add(phone);
        if (stopped.has(phone)) optedOut++; else people.push({ contactId: text(c.id), name: text(c.name), phone });
    }
    return { total: contacts.results.length, optedOut, people };
}

/** GET /social/audience?tags=a,b — how many people an invite to these tags would reach. */
const audienceGet: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const a = await audience(ctx.env, tagIdsOf((ctx.url.searchParams.get('tags') ?? '').split(',')));
    return json({ total: a.total, optedOut: a.optedOut, reachable: a.people.length, max: MAX_RECIPIENTS });
};

// ── Invites ─────────────────────────────────────────────────────────────────

/** What was typed for each of the template's own fields; anything else sent is dropped. */
function valuesOf(templateBody: string, raw: unknown): FieldValues {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return Object.fromEntries(templateFields(templateBody).filter(f => f !== 'name').map(f => [f, text(r[f]).trim().slice(0, 200)]));
}

const parseJson = <T>(raw: unknown, fallback: T): T => { try { return JSON.parse(text(raw)) as T; } catch { return fallback; } };

function rowToInvite(env: Env, r: Row, templateName: string, counts: Counts): Invite {
    return {
        id: text(r.id), name: text(r.name), templateId: text(r.template_id), templateName,
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

const invitesList: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const db = ctx.env.VAYU_DB;
    const [{ results }, counts, names] = await Promise.all([
        db.prepare('SELECT * FROM social_invites ORDER BY created_at DESC LIMIT 200').all<Row>(), countsByInvite(db), templateNames(db),
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

/** What both a real invite and a test need: an approved template, its fields filled, its picture. */
async function sendable(ctx: Ctx, b: Record<string, unknown>, conn: Connection): Promise<{ template: Row; values: FieldValues; imageKey: string; imageUrl: string } | Response> {
    const template = await ctx.env.VAYU_DB.prepare('SELECT * FROM social_templates WHERE id = ?').bind(text(b.templateId)).first<Row>();
    if (!template) return err('Choose a template.');
    if (template.status !== 'approved') return err('Meta has not approved this template yet. Choose an approved one.', 409);
    const values = valuesOf(text(template.body), b.values);
    const imageKey = template.image ? uploadKey(b.imageUrl) : '';
    const problem = inviteProblem({ body: text(template.body), image: !!template.image }, values, imageKey) ?? (imageKey ? await imageProblem(ctx.env, imageKey) : null);
    if (problem) return err(problem);
    return { template, values, imageKey, imageUrl: imageKey ? await publicImageUrl(ctx, conn, imageKey) : '' };
}

const payloadFor = (conn: Connection, template: Row, values: FieldValues, imageUrl: string, recipients: { id: string; phone: string; name: string }[]) => sendPayload({
    number: conn.number, namespace: text(template.namespace), values, imageUrl, recipients,
    template: { name: text(template.name), language: text(template.language), body: text(template.body), image: !!template.image },
});

/** POST /social/test — the same message, to one number, before it goes to everyone. Not recorded. */
const testSend: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const acct = await account(ctx);
    if (acct instanceof Response) return acct;
    const b = await body(ctx);
    const ready = await sendable(ctx, b, acct.conn);
    if (ready instanceof Response) return ready;
    const phone = phoneKey(text(b.phone), await orgCountry(ctx.env))?.slice(2);
    if (!phone) return err('Give the WhatsApp number to send the test to.');
    const res = await msg91(ctx.env, acct.authKey, 'POST', '/whatsapp-outbound-message/bulk/',
        payloadFor(acct.conn, ready.template, ready.values, ready.imageUrl, [{ id: `test_${crypto.randomUUID()}`, phone, name: session.name }]));
    return res.ok ? json({ ok: true }) : refusal(res, 'MSG91 did not send it');
};

/** POST /social/invites — the people are fixed now (even for a later send time), then sending starts. */
const invitesCreate: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const acct = await account(ctx);
    if (acct instanceof Response) return acct;
    const b = await body(ctx);
    const ready = await sendable(ctx, b, acct.conn);
    if (ready instanceof Response) return ready;
    const name = text(b.name).trim().slice(0, 120);
    if (!name) return err('Give the invite a name.');
    const tagIds = tagIdsOf(b.tagIds);
    if (!tagIds.length) return err('Choose who to send it to.');
    const now = Date.now();
    const sendAt = Number(b.sendAt) || 0;
    if (sendAt && (!Number.isFinite(sendAt) || sendAt < now - 60_000 || sendAt > now + 90 * 86_400_000)) return err('Choose a send time within the next 90 days.');
    const { people } = await audience(ctx.env, tagIds);
    if (!people.length) return err('Nobody with those tags has a WhatsApp number to send to.');
    if (people.length > MAX_RECIPIENTS) return err(`One invite can go to ${MAX_RECIPIENTS} people. These tags have ${people.length}; split them.`, 409);

    const db = ctx.env.VAYU_DB;
    const id = `inv_${now}_${crypto.randomUUID().slice(0, 8)}`;
    const later = sendAt > now;
    const rows = people.map(p => db.prepare('INSERT INTO social_recipients (id, invite_id, contact_id, name, phone, status_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(`r_${crypto.randomUUID()}`, id, p.contactId, p.name, p.phone, now));
    // The invite row goes in with the first people: an invite never exists with nobody on it.
    const invite = db.prepare(`INSERT INTO social_invites (id, name, template_id, tag_ids, vals, image_key, image_url, status, send_at, created_at, created_by, created_by_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, name, ready.template.id, JSON.stringify(tagIds), JSON.stringify(ready.values), ready.imageKey, ready.imageUrl,
        later ? 'scheduled' : 'sending', later ? sendAt : now, now, session.userId, session.name);
    await db.batch([invite, ...rows.slice(0, 80)]);
    for (let i = 80; i < rows.length; i += 80) await db.batch(rows.slice(i, i + 80)); // NOSONAR: one write batch at a time keeps the load bounded
    // The scheduled job finishes what this request doesn't (long lists, later send times).
    await (ctx.env.SHARED_KV ?? ctx.env.VAYU_KV).put(`${PENDING}${ctx.env.ORG_ID}`, '1');
    if (!later) ctx.execCtx.waitUntil(deliverInvite(ctx.env, id).catch(e => console.error('Sending an invite failed:', e)));
    const row = await db.prepare('SELECT * FROM social_invites WHERE id = ?').bind(id).first<Row>();
    return json(rowToInvite(ctx.env, row!, text(ready.template.name), { ...emptyCounts(), total: people.length, queued: people.length }), 201);
};

// ── Sending ─────────────────────────────────────────────────────────────────

const failQueued = (db: D1Database, inviteId: string, reason: string) =>
    db.prepare("UPDATE social_recipients SET status = 'failed', reason = ?, status_at = ? WHERE invite_id = ? AND status = 'queued'").bind(reason, Date.now(), inviteId).run();

/** Up to a run's worth of chunks to MSG91. Each chunk's people are claimed first, so no run (or crash) sends to them again. */
async function sendChunks(env: Env, invite: Row, template: Row, conn: Connection, authKey: string): Promise<void> {
    const db = env.VAYU_DB;
    const values = parseJson<FieldValues>(invite.vals, {});
    for (let i = 0; i < CHUNKS_PER_RUN; i++) {
        const claim = crypto.randomUUID();
        await db.prepare(`UPDATE social_recipients SET status = 'submitted', claim = ?, status_at = ? WHERE id IN
            (SELECT id FROM social_recipients WHERE invite_id = ? AND status = 'queued' LIMIT ${CHUNK})`).bind(claim, Date.now(), invite.id).run(); // NOSONAR: chunks go in turn
        const claimed = db.prepare('SELECT id, phone, name FROM social_recipients WHERE claim = ?').bind(claim);
        const { results } = await claimed.all<{ id: string; phone: string; name: string }>(); // NOSONAR: chunks go in turn
        if (!results.length) return;
        const res = await msg91(env, authKey, 'POST', '/whatsapp-outbound-message/bulk/', payloadFor(conn, template, values, text(invite.image_url), results)); // NOSONAR: chunks go in turn
        if (res.ok) {
            await db.prepare('UPDATE social_recipients SET request_id = ? WHERE claim = ?').bind(text(res.data?.request_id), claim).run(); // NOSONAR: chunks go in turn
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
    if (!conn || !authKey) await failQueued(db, inviteId, 'The MSG91 account was disconnected before this was sent.');
    else if (template) await sendChunks(env, invite, template, conn, authKey);
    else await failQueued(db, inviteId, 'Its template was deleted before this was sent.');
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

// ── What MSG91 and WhatsApp call, without a sign-in ─────────────────────────

const HOOK_PATH = /^\/api\/v2\/webhooks\/msg91\/([A-Za-z0-9-]{1,64})\/([a-f0-9]{48})$/;
const IMAGE_PATH = /^\/api\/v2\/social\/image\/([A-Za-z0-9-]{1,64})\/([a-f0-9]{32})\/(.+)$/;

type StatusEvent = Extract<WebhookEvent, { kind: 'status' }>;
type ReplyEvent = Extract<WebhookEvent, { kind: 'reply' }>;
type Tracked = { id: string; status: RecipientStatus };

/** A delivery report: found by the id sent with the message, or by MSG91's request and the number. */
async function applyStatus(db: D1Database, ev: StatusEvent): Promise<void> {
    let row = ev.id ? await db.prepare('SELECT id, status FROM social_recipients WHERE id = ?').bind(ev.id).first<Tracked>() : null;
    if (!row && ev.requestId) {
        row = await db.prepare('SELECT id, status FROM social_recipients WHERE request_id = ? AND phone = ?').bind(ev.requestId, ev.phone).first<Tracked>();
    }
    if (!row) return;
    const status = nextStatus(row.status, ev.status);
    if (status === row.status) return;
    const reason = status === 'failed' ? ev.reason || 'WhatsApp could not deliver it.' : '';
    // The status it was read at is part of the write: two reports racing can only move it forward.
    await db.prepare('UPDATE social_recipients SET status = ?, reason = ?, status_at = ? WHERE id = ? AND status = ?')
        .bind(status, reason, Date.now(), row.id, row.status).run();
}

/** A reply: STOP leaves the number out from now on; yes / no is their RSVP. */
async function applyReply(db: D1Database, ev: ReplyEvent): Promise<void> {
    if (isStop(ev.text)) {
        await db.prepare('INSERT OR IGNORE INTO social_optouts (phone, at) VALUES (?, ?)').bind(ev.phone, Date.now()).run();
        return;
    }
    const rsvp = rsvpOf(ev.text);
    if (!rsvp) return;
    // Their answer belongs to the latest invite they were sent (within a month).
    await db.prepare(`UPDATE social_recipients SET rsvp = ? WHERE id = (SELECT id FROM social_recipients
        WHERE phone = ? AND status != 'failed' AND status != 'queued' AND status_at > ? ORDER BY rowid DESC LIMIT 1)`)
        .bind(rsvp, ev.phone, Date.now() - 30 * 86_400_000).run();
}

async function applyEvent(db: D1Database, raw: unknown): Promise<void> {
    const ev = parseWebhook(raw);
    if (ev?.kind === 'status') await applyStatus(db, ev);
    else if (ev) await applyReply(db, ev);
}

const notFound = () => err('Not found', 404);

/** MSG91's delivery reports and replies, one or several to a call. */
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

/** An invite's picture, for WhatsApp: only with this workspace's signature for that file, and only a picture. */
async function servePicture(request: Request, space: Env, conn: Connection, signature: string, key: string): Promise<Response> {
    if (request.method !== 'GET' || !uploadKeyOk(key) || !timingSafeEqual(signature, await hmacHex(conn.signKey, key))) return notFound();
    const obj = await space.VAYU_R2.get(key);
    const how = delivery(obj?.httpMetadata?.contentType);
    // Anything else stays behind the staff app.
    if (!obj || !how.contentType.startsWith('image/') || how.disposition !== 'inline') return notFound();
    return new Response(obj.body, { headers: { 'Content-Type': how.contentType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600' } });
}

/**
 * POST /api/v2/webhooks/msg91/<org>/<token> (MSG91's delivery reports and
 * replies) and GET /api/v2/social/image/<org>/<signature>/<file> (WhatsApp
 * fetching an invite's picture). Null for any other address.
 */
export async function handleSocialPublic(request: Request, env: Env): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    const hook = HOOK_PATH.exec(path);
    const image = hook ? null : IMAGE_PATH.exec(path);
    const orgId = (hook ?? image)?.[1];
    if (!orgId) return null;
    const space = await orgEnvById(env, orgId);
    if (!space) return notFound();
    await ensureSocialTables(space.VAYU_DB);
    const conn = await readConnection(space);
    if (!conn) return notFound();
    if (hook) return receiveReports(request, space, conn, hook[2]);
    return servePicture(request, space, conn, image![2], image![3]); // upload keys need no decoding
}

// ── Routes ──────────────────────────────────────────────────────────────────

const isExact = (p: string) => (path: string) => path === p;

export const socialRoutes: SocialRoute[] = [
    { method: 'GET', match: isExact('/social/whatsapp'), handler: connectionGet },
    { method: 'PUT', match: isExact('/social/whatsapp'), handler: connectionPut },
    { method: 'DELETE', match: isExact('/social/whatsapp'), handler: connectionDelete },
    { method: 'GET', match: isExact('/social/templates'), handler: templatesList },
    { method: 'POST', match: isExact('/social/templates'), handler: templatesCreate },
    { method: 'DELETE', match: p => TEMPLATE_PATH.test(p), handler: templatesDelete },
    { method: 'GET', match: isExact('/social/audience'), handler: audienceGet },
    { method: 'POST', match: isExact('/social/test'), handler: testSend },
    { method: 'GET', match: isExact('/social/invites'), handler: invitesList },
    { method: 'POST', match: isExact('/social/invites'), handler: invitesCreate },
    { method: 'GET', match: p => INVITE_PATH.test(p), handler: invitesGet },
];
