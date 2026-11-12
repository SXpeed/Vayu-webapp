// Social, after an invite goes out: who got it (each contact's latest invite on
// each channel), sending it again by hand or automatically to those it didn't
// reach, and WhatsApp replies — the conversation, and answering it (freely
// within WhatsApp's 24 hours, with an approved template after).
//
// Email replies are not here: they go to each workspace's own reply-to mailbox.

import { ADMIN_ROLE_ID } from './permissions';
import { contactLists, err, json, text } from './rows';
import type { Env } from './workerEnv';
import { ensureContactSchema } from './contactStore';
import {
    ID, account, body, caller, channelOf, ensureSocialTables, linkBase, msg91, orgEnvById, parseJson, readyFromInvite, refusal, resendRows, sendTo, sendable,
    type Handler, type Maker, type Row, type SocialRoute,
} from './social';
import {
    filledBody, replyWindowLeft, resendSettingsOf, templateTitle,
    type LatestInvite, type PersonTrack, type RecipientStatus, type ReplyMessage, type ReplyThread, type ResendSettings, type Rsvp, type TrackHistory,
} from './socialRules';

const RESEND_KEY = 'social-resend:';
/** An hour; SOCIAL_HOUR_MS shortens it in tests (development only), for the resend delay and WhatsApp's 24 hours. */
const hourOf = (env: Env) => (env.PLATFORM_ENV === 'development' && Number(env.SOCIAL_HOUR_MS) > 0 ? Number(env.SOCIAL_HOUR_MS) : 3_600_000);
const AUTO: Maker = { userId: 'auto', name: 'Automatic resend' };
const PERSON_PATH = new RegExp(`^/social/people/(${ID})$`);
const THREAD_PATH = /^\/social\/replies\/(\d{8,15})$/;

// ── Who got the invites ─────────────────────────────────────────────────────

const latestOf = (r: Row): LatestInvite => ({
    recipientId: text(r.id), inviteId: text(r.invite_id), inviteName: text(r.invite_name), address: text(r.phone),
    status: text(r.status) as RecipientStatus, reason: text(r.reason), at: Number(r.status_at), resent: Number(r.resent) === 1,
});

/**
 * GET /social/people — every contact who was sent an invite, with their latest one on each channel,
 * and the contacts with an address who were never sent one. Scheduled invites don't count yet.
 */
const peopleList: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    await ensureContactSchema(ctx.env);
    const db = ctx.env.VAYU_DB;
    // A person is their contact, or their address when the invite wasn't to a saved contact.
    const sent = `FROM social_recipients r JOIN social_invites i ON i.id = r.invite_id WHERE i.status != 'scheduled'`;
    const [latest, rsvps, contacts, settings] = await Promise.all([
        db.prepare(`SELECT * FROM (SELECT r.id, r.invite_id, r.contact_id, r.name, r.phone, r.status, r.reason, r.status_at, r.resent, i.name AS invite_name, i.channel,
            COALESCE(NULLIF(r.contact_id, ''), r.phone) AS person,
            ROW_NUMBER() OVER (PARTITION BY COALESCE(NULLIF(r.contact_id, ''), r.phone), i.channel ORDER BY r.rowid DESC) AS n,
            COUNT(*) OVER (PARTITION BY COALESCE(NULLIF(r.contact_id, ''), r.phone)) AS total ${sent}) WHERE n = 1`).all<Row>(),
        db.prepare(`SELECT person, rsvp FROM (SELECT COALESCE(NULLIF(r.contact_id, ''), r.phone) AS person, r.rsvp,
            ROW_NUMBER() OVER (PARTITION BY COALESCE(NULLIF(r.contact_id, ''), r.phone) ORDER BY r.rowid DESC) AS n ${sent} AND r.rsvp != '') WHERE n = 1`).all<Row>(),
        db.prepare(`SELECT id, name, phone, phones, email, emails FROM contacts WHERE id NOT IN (SELECT r.contact_id ${sent}) ORDER BY name`).all<Row>(),
        readResend(db),
    ]);
    const rsvpOf = new Map(rsvps.results.map(r => [text(r.person), text(r.rsvp) as Rsvp]));
    const byKey = new Map<string, PersonTrack>();
    for (const r of latest.results) {
        const key = text(r.person);
        const p = byKey.get(key) ?? { key, contactId: text(r.contact_id), name: text(r.name), whatsapp: null, email: null, rsvp: rsvpOf.get(key) ?? '', invites: Number(r.total) };
        p[channelOf(r.channel)] = latestOf(r);
        byKey.set(key, p);
    }
    const never = contacts.results
        .filter(c => contactLists(c).phones.length > 0 || contactLists(c).emails.length > 0)
        .map(c => ({ contactId: text(c.id), name: text(c.name) }));
    return json({ people: [...byKey.values()], never, settings });
};

/** GET /social/people/:key — every invite one contact (or address) was sent, newest first. */
const personHistory: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const key = PERSON_PATH.exec(ctx.path)![1];
    const { results } = await ctx.env.VAYU_DB.prepare(`SELECT r.id, r.invite_id, r.phone, r.status, r.reason, r.rsvp, r.status_at, i.name AS invite_name, i.channel, i.auto
        FROM social_recipients r JOIN social_invites i ON i.id = r.invite_id WHERE (r.contact_id = ? OR (r.contact_id = '' AND r.phone = ?)) AND i.status != 'scheduled'
        ORDER BY r.rowid DESC LIMIT 100`).bind(key, key).all<Row>();
    const history: TrackHistory[] = results.map(r => ({
        recipientId: text(r.id), inviteId: text(r.invite_id), inviteName: text(r.invite_name), channel: channelOf(r.channel), address: text(r.phone),
        status: text(r.status) as RecipientStatus, reason: text(r.reason), rsvp: text(r.rsvp) as Rsvp, at: Number(r.status_at), auto: Number(r.auto) === 1,
    }));
    return json({ history });
};

// ── Sending again ───────────────────────────────────────────────────────────

/** Rows that may be sent again: their invite has finished, it didn't reach them, and they weren't sent it again already. */
const RESENDABLE = "r.resent = 0 AND r.status IN ('failed', 'submitted', 'sent') AND i.status = 'sent'";

/**
 * POST /social/resend { recipientIds } — the same message again to these people, one new invite per
 * original invite. People it reached, who were resent already, or who opted out are left out.
 */
const resendPost: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const b = await body(ctx);
    const ids = [...new Set((Array.isArray(b.recipientIds) ? b.recipientIds : []).filter((v): v is string => typeof v === 'string' && v.length <= 64))].slice(0, 2000);
    if (!ids.length) return err('Choose who to send it to again.');
    const db = ctx.env.VAYU_DB;
    const rows: Row[] = [];
    for (let i = 0; i < ids.length; i += 90) {
        const part = ids.slice(i, i + 90);
        const stmt = db.prepare(`SELECT r.id, r.invite_id FROM social_recipients r JOIN social_invites i ON i.id = r.invite_id
            WHERE ${RESENDABLE} AND r.id IN (${part.map(() => '?').join(',')})`).bind(...part);
        const { results } = await stmt.all<Row>(); // NOSONAR: in turn
        rows.push(...results);
    }
    if (!rows.length) return err('Nobody here can be sent it again: they got it, were sent it again already, or their invite is still sending.', 409);
    const byInvite = new Map<string, string[]>();
    for (const r of rows) byInvite.set(text(r.invite_id), [...(byInvite.get(text(r.invite_id)) ?? []), text(r.id)]);
    let invites = 0;
    let people = 0;
    const problems: string[] = [];
    for (const [inviteId, rowIds] of byInvite) {
        const invite = await db.prepare('SELECT * FROM social_invites WHERE id = ?').bind(inviteId).first<Row>(); // NOSONAR: invites go in turn
        const acct = await account(ctx, channelOf(invite!.channel)); // NOSONAR: invites go in turn
        if (acct instanceof Response) {
            const said = await acct.json().catch(() => null) as { error?: string } | null; // NOSONAR: invites go in turn
            problems.push(`${text(invite!.name)}: ${said?.error ?? 'its channel is not ready'}`);
            continue;
        }
        const ready = await readyFromInvite(db, invite!); // NOSONAR: invites go in turn
        if (typeof ready === 'string') { problems.push(`${text(invite!.name)}: ${ready}`); continue; }
        const made = await resendRows(ctx.env, session, invite!, ready, rowIds, { base: linkBase(ctx), start: w => ctx.execCtx.waitUntil(w) }); // NOSONAR: invites go in turn
        if (made) { invites++; people += made.people; }
    }
    if (!people) return err(problems[0] ?? 'Nobody could be sent it again (they may have opted out).', 409);
    return json({ invites, people, problems }, 201);
};

async function readResend(db: D1Database): Promise<ResendSettings> {
    const row = await db.prepare("SELECT value FROM social_settings WHERE key = 'resend'").first<{ value: string }>();
    return resendSettingsOf(parseJson(row?.value, {}));
}

/** PUT /social/resend-settings { on, afterHours, tries } — admins only. */
const resendSettingsPut: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    if (session.role !== ADMIN_ROLE_ID) return err('Only an admin can change automatic resend.', 403);
    const settings = resendSettingsOf(await body(ctx));
    await ctx.env.VAYU_DB.prepare("INSERT INTO social_settings (key, value) VALUES ('resend', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(settings)).run();
    const kv = ctx.env.SHARED_KV ?? ctx.env.VAYU_KV;
    if (settings.on) await kv.put(`${RESEND_KEY}${ctx.env.ORG_ID}`, '1');
    else await kv.delete(`${RESEND_KEY}${ctx.env.ORG_ID}`);
    return json(settings);
};

/**
 * One workspace's automatic resend: people an invite didn't reach after the chosen hours, not yet
 * resent, under the try limit, without an RSVP, within a week. "Not delivered" counts only when the
 * invite had delivery reports at all, so a workspace whose reports aren't set up isn't messaged twice.
 * Gives false when automatic resend is off.
 */
export async function autoResendWorkspace(space: Env): Promise<boolean> {
    const db = space.VAYU_DB;
    await ensureSocialTables(db);
    const s = await readResend(db);
    if (!s.on) return false;
    const now = Date.now();
    const HOUR = hourOf(space);
    const { results } = await db.prepare(`SELECT r.id, r.invite_id FROM social_recipients r JOIN social_invites i ON i.id = r.invite_id
        WHERE ${RESENDABLE} AND r.attempt < ? AND r.rsvp = '' AND r.status_at < ? AND i.created_at > ?
        AND (r.status = 'failed' OR EXISTS (SELECT 1 FROM social_recipients x WHERE x.invite_id = r.invite_id AND x.status IN ('delivered', 'read')))
        AND r.phone NOT IN (SELECT phone FROM social_optouts) LIMIT 500`).bind(s.tries, now - s.afterHours * HOUR, now - 7 * 24 * HOUR).all<Row>();
    const byInvite = new Map<string, string[]>();
    for (const r of results) byInvite.set(text(r.invite_id), [...(byInvite.get(text(r.invite_id)) ?? []), text(r.id)]);
    const sending: Promise<unknown>[] = [];
    for (const [inviteId, rowIds] of byInvite) {
        const invite = await db.prepare('SELECT * FROM social_invites WHERE id = ?').bind(inviteId).first<Row>(); // NOSONAR: invites go in turn
        const ready = invite ? await readyFromInvite(db, invite) : 'gone'; // NOSONAR: invites go in turn
        if (!invite || typeof ready === 'string') {
            // Can't be sent again (template gone or no longer approved): don't look at these people again.
            await db.prepare(`UPDATE social_recipients SET resent = 1 WHERE id IN (${rowIds.map(() => '?').join(',')})`).bind(...rowIds).run(); // NOSONAR: in turn
            continue;
        }
        await resendRows(space, AUTO, invite, ready, rowIds, { auto: true, base: text(invite.link_base), start: w => sending.push(w) }); // NOSONAR: invites go in turn
    }
    await Promise.all(sending);
    return true;
}

/** The scheduled job: automatic resend in each workspace that switched it on. */
export async function autoResendDue(env: Env): Promise<void> {
    const kv = env.SHARED_KV ?? env.VAYU_KV;
    const { keys } = await kv.list({ prefix: RESEND_KEY });
    for (const { name } of keys) {
        try {
            const space = await orgEnvById(env, name.slice(RESEND_KEY.length)); // NOSONAR: workspaces go in turn
            const on = !!space && await autoResendWorkspace(space); // NOSONAR: workspaces go in turn
            if (!on) await kv.delete(name); // NOSONAR: workspaces go in turn
        } catch (e) {
            console.error(JSON.stringify({ event: 'social_auto_resend_failed', org: name.slice(RESEND_KEY.length), reason: (e as Error).message?.slice(0, 200) }));
        }
    }
}

// ── WhatsApp replies ────────────────────────────────────────────────────────

/** GET /social/replies — WhatsApp conversations, latest first, with unread counts. Email replies go to `replyTo`. */
const threadsList: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const db = ctx.env.VAYU_DB;
    const [{ results }, conn] = await Promise.all([
        db.prepare(`SELECT m.phone, m.body, m.dir, m.at, t.unread, t.last_in FROM social_messages m JOIN (
            SELECT phone, MAX(rowid) AS last_row, SUM(dir = 'in' AND seen = 0) AS unread, MAX(CASE WHEN dir = 'in' THEN at ELSE 0 END) AS last_in
            FROM social_messages GROUP BY phone) t ON m.rowid = t.last_row ORDER BY m.at DESC LIMIT 300`).all<Row>(),
        db.prepare("SELECT value FROM social_settings WHERE key = 'whatsapp'").first<{ value: string }>(),
    ]);
    const who = await peopleByPhone(db, results.map(r => text(r.phone)));
    const threads: ReplyThread[] = results.map(r => {
        const p = who.get(text(r.phone));
        return {
            phone: text(r.phone), name: p?.name ?? '', inviteName: p?.invite ?? '', rsvp: (p?.rsvp ?? '') as Rsvp,
            lastText: text(r.body), lastDir: r.dir === 'in' ? 'in' : 'out', lastAt: Number(r.at), lastInAt: Number(r.last_in), unread: Number(r.unread),
        };
    });
    const email = parseJson<{ email?: { replyTo?: string; from?: string } }>(conn?.value, {}).email;
    return json({ threads, replyTo: email?.replyTo || email?.from || '' });
};

/** Each number's name, latest WhatsApp invite and RSVP, from the invites they were sent. */
async function peopleByPhone(db: D1Database, phones: string[]): Promise<Map<string, { name: string; invite: string; rsvp: string }>> {
    const out = new Map<string, { name: string; invite: string; rsvp: string }>();
    for (let i = 0; i < phones.length; i += 90) {
        const part = phones.slice(i, i + 90);
        if (!part.length) break;
        const stmt = db.prepare(`SELECT r.phone, r.name, r.rsvp, i.name AS invite FROM social_recipients r JOIN social_invites i ON i.id = r.invite_id
            WHERE i.channel = 'whatsapp' AND r.phone IN (${part.map(() => '?').join(',')}) ORDER BY r.rowid DESC`).bind(...part);
        const { results } = await stmt.all<Row>(); // NOSONAR: in turn
        for (const r of results) if (!out.has(text(r.phone))) out.set(text(r.phone), { name: text(r.name), invite: text(r.invite), rsvp: text(r.rsvp) });
    }
    return out;
}

/** GET /social/replies/:phone — the conversation with the invites they were sent; their messages count as read. */
const threadGet: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const phone = THREAD_PATH.exec(ctx.path)![1];
    const db = ctx.env.VAYU_DB;
    const [messages, invites, stopped] = await Promise.all([
        db.prepare('SELECT id, dir, body, template, by_name, at FROM social_messages WHERE phone = ? ORDER BY at DESC LIMIT 300').bind(phone).all<Row>(),
        db.prepare(`SELECT r.id, r.name, r.status, r.status_at, i.vals, i.created_at, t.body, t.name AS template FROM social_recipients r
            JOIN social_invites i ON i.id = r.invite_id LEFT JOIN social_templates t ON t.id = i.template_id
            WHERE r.phone = ? AND i.channel = 'whatsapp' AND i.status != 'scheduled' ORDER BY r.rowid DESC LIMIT 50`).bind(phone).all<Row>(),
        db.prepare('SELECT 1 FROM social_optouts WHERE phone = ?').bind(phone).first(),
    ]);
    const list: ReplyMessage[] = [
        ...messages.results.map(m => ({ id: text(m.id), dir: (m.dir === 'in' ? 'in' : 'out') as ReplyMessage['dir'], body: text(m.body), template: text(m.template), byName: text(m.by_name), at: Number(m.at) })),
        ...invites.results.map(r => ({
            id: text(r.id), dir: 'invite' as const, template: templateTitle(text(r.template)), byName: '', at: Number(r.created_at), status: text(r.status) as RecipientStatus,
            body: filledBody(text(r.body), { ...parseJson<Record<string, string>>(r.vals, {}), name: text(r.name) }),
        })),
    ].sort((a, b) => a.at - b.at);
    await db.prepare("UPDATE social_messages SET seen = 1 WHERE phone = ? AND dir = 'in' AND seen = 0").bind(phone).run();
    const lastIn = Math.max(0, ...messages.results.filter(m => m.dir === 'in').map(m => Number(m.at)));
    const name = text(invites.results[0]?.name);
    return json({ phone, name, messages: list, lastInAt: lastIn, windowMs: 24 * hourOf(ctx.env), optedOut: !!stopped });
};

/**
 * POST /social/replies/:phone { text } within 24 hours of their last message, or { templateId, values, imageUrl }
 * (an approved template) at any time. Not to someone who replied STOP.
 */
const threadSend: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const phone = THREAD_PATH.exec(ctx.path)![1];
    const db = ctx.env.VAYU_DB;
    const acct = await account(ctx, 'whatsapp');
    if (acct instanceof Response) return acct;
    if (await db.prepare('SELECT 1 FROM social_optouts WHERE phone = ?').bind(phone).first()) return err('They replied STOP, so they can’t be messaged.', 409);
    const b = await body(ctx);
    const now = Date.now();
    const save = (bodyText: string, template: string) => db.prepare("INSERT INTO social_messages (id, phone, dir, body, template, by_name, at, seen) VALUES (?, ?, 'out', ?, ?, ?, ?, 1)")
        .bind(`m_${crypto.randomUUID()}`, phone, bodyText, template, session.name, now).run();

    if (b.templateId) {
        const ready = await sendable(ctx, b, acct.conn);
        if (ready instanceof Response) return ready;
        if (ready.template.channel !== 'whatsapp') return err('Choose a WhatsApp template.');
        const known = await db.prepare('SELECT name FROM social_recipients WHERE phone = ? ORDER BY rowid DESC LIMIT 1').bind(phone).first<{ name: string }>();
        const res = await sendTo(ctx.env, acct.conn, acct.authKey, ready, { base: linkBase(ctx), orgId: ctx.env.ORG_ID! }, [{ id: `m_${crypto.randomUUID()}`, phone, name: known?.name ?? '' }]);
        if (!res.ok) return refusal(res, 'MSG91 did not send it');
        await save(filledBody(ready.template.body, { ...ready.values, name: known?.name ?? '' }), templateTitle(ready.template.name));
        return json({ ok: true }, 201);
    }

    const words = text(b.text).trim().slice(0, 4096);
    if (!words) return err('Type a reply.');
    const last = await db.prepare("SELECT MAX(at) AS at FROM social_messages WHERE phone = ? AND dir = 'in'").bind(phone).first<{ at: number | null }>();
    if (!replyWindowLeft(Number(last?.at ?? 0), now, 24 * hourOf(ctx.env))) {
        return json({ error: 'It has been more than 24 hours since they last wrote. WhatsApp only allows an approved template now.', code: 'window_closed' }, 409);
    }
    // shortcut: MSG91's session-message fields are sent both in the address and the body until a live account confirms which it reads.
    const fields = { integrated_number: acct.conn.number, content_type: 'text', recipient_number: phone, text: words };
    const res = await msg91(ctx.env, acct.authKey, 'POST', `/whatsapp/whatsapp-outbound-message/?${new URLSearchParams(fields)}`, fields);
    if (!res.ok) return refusal(res, 'MSG91 did not send it');
    await save(words, '');
    return json({ ok: true }, 201);
};

// ── Routes ──────────────────────────────────────────────────────────────────

const isExact = (p: string) => (path: string) => path === p;

export const socialInboxRoutes: SocialRoute[] = [
    { method: 'GET', match: isExact('/social/people'), handler: peopleList },
    { method: 'GET', match: p => PERSON_PATH.test(p), handler: personHistory },
    { method: 'POST', match: isExact('/social/resend'), handler: resendPost },
    { method: 'PUT', match: isExact('/social/resend-settings'), handler: resendSettingsPut },
    { method: 'GET', match: isExact('/social/replies'), handler: threadsList },
    { method: 'GET', match: p => THREAD_PATH.test(p), handler: threadGet },
    { method: 'POST', match: p => THREAD_PATH.test(p), handler: threadSend },
];
