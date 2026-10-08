// The staff roster: weekly shifts at the workspace's stores (the ones set up
// under Attendance → Stores), days off, leave requests, and publishing.
//
// Who can do what comes from the "Staff roster" permission (permissions.ts):
//   view   — see the published roster, and ask for leave for yourself
//   edit   — plan shifts and days off, approve or decline leave, set job
//            titles, and publish a week
//
// Publishing saves a snapshot of the week. People who only view the roster
// see that snapshot, so a manager can keep planning without half-finished
// changes showing; the week then reads "Unpublished changes" until it is
// published again. Publishing is refused while a week has overlapping shifts
// or shifts during approved leave (staffRosterRules.ts); open shifts are fine.
//
// Storage: four tables in the workspace's own database, created on first use.
// Like the showcase Roster, nothing here goes through change_log: a change
// sends a signal-only "schedule" invalidate and an open roster refetches.

import { err, json, runSetupOnce } from './rows';
import {
    DEFAULT_JOB_TITLES, LEAVE_TYPES, addDays, findConflicts, isIsoDate, mondayOf, shiftFieldErrors, toTs,
    type LeaveStatus, type ShiftKind, type StaffLeave, type StaffShift,
} from './staffRosterRules';
import type { ChangeEvent, Ctx, SessionData } from './workerEnv';
import { getSession, type StoredUser } from './workerRoles';

const MAX_RANGE_DAYS = 62;
// A save: one shift, the same shift on several days, a copied week or an import.
const MAX_SHIFTS_PER_SAVE = 100;
const MAX_LEAVE_DAYS = 60;

export function ensureStaffRosterTables(db: D1Database): Promise<void> {
    return runSetupOnce(db, 'staffRosterTables', async () => {
        await db.prepare(`CREATE TABLE IF NOT EXISTS staff_shifts (
            id          TEXT PRIMARY KEY,
            kind        TEXT NOT NULL DEFAULT 'shift',
            employee_id TEXT,
            store_id    TEXT,
            date        TEXT NOT NULL,
            start_min   INTEGER NOT NULL DEFAULT 0,
            end_min     INTEGER NOT NULL DEFAULT 0,
            break_min   INTEGER NOT NULL DEFAULT 0,
            role        TEXT NOT NULL DEFAULT '',
            note        TEXT NOT NULL DEFAULT '',
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL,
            updated_by  TEXT
        )`).run();
        await db.prepare('CREATE INDEX IF NOT EXISTS idx_staff_shifts_date ON staff_shifts (date)').run();
        await db.prepare(`CREATE TABLE IF NOT EXISTS staff_leaves (
            id              TEXT PRIMARY KEY,
            employee_id     TEXT NOT NULL,
            from_date       TEXT NOT NULL,
            to_date         TEXT NOT NULL,
            type            TEXT NOT NULL DEFAULT '',
            reason          TEXT NOT NULL DEFAULT '',
            status          TEXT NOT NULL DEFAULT 'pending',
            requested_at    INTEGER NOT NULL,
            requested_by    TEXT,
            decided_at      INTEGER,
            decided_by      TEXT,
            decided_by_name TEXT NOT NULL DEFAULT ''
        )`).run();
        await db.prepare(`CREATE TABLE IF NOT EXISTS staff_weeks (
            week_start        TEXT PRIMARY KEY,
            published_at      INTEGER NOT NULL,
            published_by      TEXT,
            published_by_name TEXT NOT NULL DEFAULT '',
            snapshot          TEXT NOT NULL DEFAULT '[]',
            changed           INTEGER NOT NULL DEFAULT 0
        )`).run();
        await db.prepare(`CREATE TABLE IF NOT EXISTS staff_titles (
            employee_id TEXT PRIMARY KEY,
            title       TEXT NOT NULL DEFAULT ''
        )`).run();
    });
}

// ── Rows ────────────────────────────────────────────────────────────────────

function rowToShift(r: Record<string, unknown>): StaffShift {
    return {
        id: text(r.id),
        kind: r.kind === 'off' ? 'off' : 'shift',
        employeeId: r.employee_id ? text(r.employee_id) : null,
        storeId: r.store_id ? text(r.store_id) : null,
        date: text(r.date),
        startMin: Number(r.start_min) || 0,
        endMin: Number(r.end_min) || 0,
        breakMin: Number(r.break_min) || 0,
        role: text(r.role),
        note: text(r.note),
    };
}

function rowToLeave(r: Record<string, unknown>): StaffLeave {
    const status = text(r.status) as LeaveStatus;
    return {
        id: text(r.id),
        employeeId: text(r.employee_id),
        from: text(r.from_date),
        to: text(r.to_date),
        type: text(r.type),
        reason: text(r.reason),
        status: status === 'approved' || status === 'declined' ? status : 'pending',
        requestedAt: Number(r.requested_at) || 0,
        decidedAt: r.decided_at ? Number(r.decided_at) : null,
        decidedByName: text(r.decided_by_name),
    };
}

export type WeekStatus = 'draft' | 'published' | 'changed';
export interface WeekInfo { status: WeekStatus; publishedAt: number | null; publishedByName: string }

// ── Routes ──────────────────────────────────────────────────────────────────

type Handler = (ctx: Ctx) => Promise<Response>;
export interface StaffRosterRoute { method: string; match: (path: string) => boolean; handler: Handler }

export interface PushPayload { title: string; body: string; tag?: string; data?: Record<string, unknown> }

/** What these routes borrow from worker.ts. */
export interface StaffRosterDeps {
    people: (ctx: Ctx) => Promise<StoredUser[]>;
    stores: (ctx: Ctx) => Promise<{ id: string; name: string }[]>;
    canManage: (ctx: Ctx, session: SessionData) => Promise<boolean>;
    push: (ctx: Ctx, userIds: string[], payload: PushPayload) => void;
    logChange: (ctx: Ctx, session: SessionData, action: string, entity: string, id: string, details: string) => void;
    notify: (ctx: Ctx, events: ChangeEvent[]) => void;
}

const SHIFT_PATH = /^\/staff-roster\/shifts\/([A-Za-z0-9_-]{1,64})$/;
const LEAVE_PATH = /^\/staff-roster\/leaves\/([A-Za-z0-9_-]{1,64})$/;
const TITLE_PATH = /^\/staff-roster\/titles\/([^/]{1,128})$/;

/** A stored or sent value as text: strings as they are, numbers written out, anything else empty. */
function text(v: unknown): string {
    if (typeof v === 'string') return v;
    return typeof v === 'number' ? String(v) : '';
}
const cleanText = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const intIn = (v: unknown, min: number, max: number): number | null =>
    (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null);
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;

async function body(ctx: Ctx): Promise<Record<string, unknown> | null> {
    const parsed = await ctx.request.json().catch(() => null);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

const fmtDay = (iso: string) => new Date(toTs(iso)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtRange = (from: string, to: string) => (from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`);

type ShiftInput = Omit<StaffShift, 'id'>;

async function caller(ctx: Ctx): Promise<SessionData | Response> {
    const session = await getSession(ctx.request, ctx.env.VAYU_KV);
    if (!session) return err('Unauthorized', 401);
    await ensureStaffRosterTables(ctx.env.VAYU_DB);
    return session;
}

/** Published weeks among these dates become "Unpublished changes". */
async function markChanged(db: D1Database, dates: string[]): Promise<void> {
    const weeks = [...new Set(dates.map(mondayOf))];
    if (weeks.length) await db.prepare(`UPDATE staff_weeks SET changed = 1 WHERE week_start IN (${weeks.map(() => '?').join(',')})`).bind(...weeks).run();
}

/** A shift's start, end and break in minutes (a day off has none), or why they can't be used. */
function shiftTimes(kind: ShiftKind, raw: Record<string, unknown>): { startMin: number; endMin: number; breakMin: number } | { problem: string } {
    if (kind === 'off') return { startMin: 0, endMin: 0, breakMin: 0 };
    const startMin = intIn(raw.startMin, 0, 1439);
    const endMin = intIn(raw.endMin, 0, 1439);
    const breakMin = intIn(raw.breakMin, 0, 180);
    if (startMin === null || endMin === null) return { problem: 'Enter a start and an end time.' };
    if (breakMin === null) return { problem: 'A break can be 0 to 180 minutes.' };
    return { startMin, endMin, breakMin };
}

/** The shift a request describes, or why it can't be saved. */
function readShift(raw: Record<string, unknown>, people: Set<string>, stores: Set<string>): { shift: ShiftInput } | { problem: string } {
    const kind: ShiftKind = raw.kind === 'off' ? 'off' : 'shift';
    const employeeId = typeof raw.employeeId === 'string' && raw.employeeId ? raw.employeeId : null;
    if (employeeId && !people.has(employeeId)) return { problem: 'That person is not on this team.' };
    if (kind === 'off' && !employeeId) return { problem: 'A day off needs a person.' };
    const storeId = kind === 'shift' && typeof raw.storeId === 'string' && raw.storeId ? raw.storeId : null;
    if (storeId && !stores.has(storeId)) return { problem: 'That store no longer exists.' };
    const times = shiftTimes(kind, raw);
    if ('problem' in times) return times;
    const shift: ShiftInput = {
        kind, employeeId, storeId, date: text(raw.date), ...times,
        role: kind === 'off' ? '' : cleanText(raw.role, 60), note: cleanText(raw.note, 200),
    };
    const errors = shiftFieldErrors(shift);
    return errors.length ? { problem: errors[0] } : { shift };
}

/** The weeks these dates touch: published, changed since, or draft. */
async function loadWeeks(db: D1Database, from: string, to: string) {
    const weekStarts: string[] = [];
    for (let w = mondayOf(from); w <= to; w = addDays(w, 7)) weekStarts.push(w);
    const weekRows = (await db.prepare(`SELECT * FROM staff_weeks WHERE week_start IN (${weekStarts.map(() => '?').join(',')})`)
        .bind(...weekStarts).all()).results || [];
    const weeks: Record<string, WeekInfo> = {};
    for (const w of weekStarts) weeks[w] = { status: 'draft', publishedAt: null, publishedByName: '' };
    for (const r of weekRows) {
        weeks[text(r.week_start)] = { status: Number(r.changed) ? 'changed' : 'published', publishedAt: Number(r.published_at), publishedByName: text(r.published_by_name) };
    }
    return { weeks, weekRows };
}

/** The live plan, for managers. The day before too: an overnight shift can run into the range. */
async function planShifts(db: D1Database, from: string, to: string): Promise<StaffShift[]> {
    return ((await db.prepare('SELECT * FROM staff_shifts WHERE date >= ? AND date <= ? ORDER BY date, start_min')
        .bind(addDays(from, -1), to).all()).results || []).map(r => rowToShift(r as Record<string, unknown>));
}

/** What everyone else sees: the published snapshots of these weeks. */
function publishedShifts(weekRows: Record<string, unknown>[], from: string, to: string): StaffShift[] {
    const shifts: StaffShift[] = [];
    for (const r of weekRows) {
        try {
            const snap = JSON.parse(text(r.snapshot)) as StaffShift[];
            shifts.push(...snap.filter(s => s.date >= addDays(from, -1) && s.date <= to));
        } catch { /* an unreadable snapshot shows nothing */ }
    }
    return shifts;
}

/** Others' leave shows only once approved, and never with its reason. */
function othersLeaveHidden(leaves: StaffLeave[], me: string, from: string, to: string): StaffLeave[] {
    return leaves
        .filter(l => l.employeeId === me || (l.status === 'approved' && l.from <= to && l.to >= from))
        .map(l => (l.employeeId === me ? l : { ...l, reason: '', type: 'Leave' }));
}

/**
 * Names of people these shifts and leave belong to who are no longer on
 * the team. An organization keeps a removed member's app record
 * (orgTeam.ts); the original workspace deletes it but keeps a copy in the
 * undo archive (deleted_items). Without either the screen says "Former
 * team member".
 */
async function formerNames(ctx: Ctx, team: Set<string>, ids: (string | null)[]): Promise<{ id: string; name: string }[]> {
    const gone = [...new Set(ids.filter((id): id is string => !!id && !team.has(id)))].slice(0, 50);
    const names = new Map<string, string>();
    await Promise.all(gone.map(async id => {
        const raw = await ctx.env.VAYU_KV.get(`auth:user:${id}`).catch(() => null);
        if (!raw) return;
        try {
            const u = JSON.parse(raw) as StoredUser;
            if (u.name || u.email) names.set(id, u.name || u.email);
        } catch { /* an unreadable record has no name */ }
    }));
    const missing = gone.filter(id => !names.has(id));
    if (missing.length) {
        // Only the name is read: the archived record also holds the password hash.
        const rows = await ctx.env.VAYU_DB.prepare(
            `SELECT entity_id, json_extract(payload, '$.name') AS name FROM deleted_items
             WHERE entity = 'user' AND entity_id IN (${missing.map(() => '?').join(',')}) ORDER BY deleted_at DESC`,
        ).bind(...missing).all().then(r => r.results || [], () => []); // no archive yet: no names
        for (const r of rows) {
            const id = text(r.entity_id);
            if (!names.has(id) && typeof r.name === 'string' && r.name) names.set(id, r.name);
        }
    }
    return [...names].map(([id, name]) => ({ id, name }));
}

/**
 * A shift replaces that person's day off; a day off replaces an earlier
 * one, but never a shift (refused). Gives the statement clearing the old
 * day off, if any.
 */
async function replacedDayOff(db: D1Database, s: ShiftInput): Promise<D1PreparedStatement | Response | null> {
    const clear = () => db.prepare("DELETE FROM staff_shifts WHERE kind = 'off' AND employee_id = ? AND date = ?").bind(s.employeeId, s.date);
    if (s.kind === 'shift') return s.employeeId ? clear() : null;
    const busy = await db.prepare("SELECT 1 FROM staff_shifts WHERE kind = 'shift' AND employee_id = ? AND date = ?").bind(s.employeeId, s.date).first();
    if (busy) return err('That person already has a shift that day. Remove it first, then mark the day off.', 409);
    return clear();
}

/** "Added a shift on 3 Oct and 2 more" */
function addedShiftsText(created: ShiftInput[]): string {
    const what = created[0].kind === 'off' ? 'Marked a day off' : 'Added a shift';
    const more = created.length > 1 ? ' and ' + (created.length - 1) + ' more' : '';
    return `${what} on ${fmtDay(created[0].date)}${more}`;
}

/** Asked for yourself: pending. Recorded by a manager for someone else (`decidedBy`): approved at once. */
function newLeave(fields: Pick<StaffLeave, 'employeeId' | 'from' | 'to' | 'type' | 'reason'>, decidedBy: string | null, now: number): StaffLeave {
    return {
        id: newId('lv'), ...fields, requestedAt: now,
        status: decidedBy ? 'approved' : 'pending',
        decidedAt: decidedBy ? now : null, decidedByName: decidedBy ?? '',
    };
}

function leaveDatesProblem(from: string, to: string): string | null {
    if (!isIsoDate(from) || !isIsoDate(to)) return 'Choose the first and last day.';
    if (to < from) return 'The last day is before the first day.';
    return (toTs(to) - toTs(from)) / 86_400_000 >= MAX_LEAVE_DAYS ? `Leave can be up to ${MAX_LEAVE_DAYS} days at a time.` : null;
}

/** A published week where the person has shifts in their newly approved leave needs publishing again. */
async function markChangedForLeave(db: D1Database, leave: StaffLeave): Promise<void> {
    const hit = (await db.prepare("SELECT DISTINCT date FROM staff_shifts WHERE kind = 'shift' AND employee_id = ? AND date >= ? AND date <= ?")
        .bind(leave.employeeId, leave.from, leave.to).all()).results || [];
    await markChanged(db, hit.map(r => text(r.date)));
}

export function staffRosterRoutes(deps: StaffRosterDeps): StaffRosterRoute[] {
    const signal = (ctx: Ctx, id: string) => deps.notify(ctx, [{ entity: 'schedule', id, op: 'put' }]);

    async function lookups(ctx: Ctx) {
        const [people, stores] = await Promise.all([deps.people(ctx), deps.stores(ctx)]);
        return { people, stores, peopleIds: new Set(people.map(p => p.id)), storeIds: new Set(stores.map(s => s.id)) };
    }

    /** GET /staff-roster?from=&to= — everything a screen needs for these dates. */
    const load: Handler = async (ctx) => {
        const session = await caller(ctx);
        if (session instanceof Response) return session;
        const db = ctx.env.VAYU_DB;
        const today = new Date().toISOString().slice(0, 10);
        const from = ctx.url.searchParams.get('from') ?? mondayOf(today);
        const to = ctx.url.searchParams.get('to') ?? addDays(from, 6);
        if (!isIsoDate(from) || !isIsoDate(to) || to < from) return err('Give a valid date range.');
        if ((toTs(to) - toTs(from)) / 86_400_000 > MAX_RANGE_DAYS) return err(`Ask for at most ${MAX_RANGE_DAYS} days at a time.`);
        const manage = await deps.canManage(ctx, session);
        const { people, stores } = await lookups(ctx);
        const titles = new Map(((await db.prepare('SELECT employee_id, title FROM staff_titles').all()).results || [])
            .map(r => [text(r.employee_id), text(r.title)]));

        const { weeks, weekRows } = await loadWeeks(db, from, to);
        const shifts = manage ? await planShifts(db, from, to) : publishedShifts(weekRows, from, to);
        const leaveRows = ((await db.prepare(
            `SELECT * FROM staff_leaves WHERE (from_date <= ? AND to_date >= ?) OR status = 'pending' OR employee_id = ? ORDER BY requested_at DESC LIMIT 500`,
        ).bind(to, from, session.userId).all()).results || []).map(r => rowToLeave(r as Record<string, unknown>));
        const leaves = manage ? leaveRows : othersLeaveHidden(leaveRows, session.userId, from, to);
        const formerPeople = await formerNames(ctx, new Set(people.map(p => p.id)), [...leaves.map(l => l.employeeId), ...shifts.map(s => s.employeeId)]);

        return json({
            canManage: manage,
            me: session.userId,
            people: people.map(p => ({ id: p.id, name: p.name || p.email, title: titles.get(p.id) || '' })),
            formerPeople,
            stores,
            jobTitles: [...new Set([...DEFAULT_JOB_TITLES, ...titles.values()].filter(Boolean))],
            shifts, leaves, weeks,
        });
    };

    /** The shifts a save sends: at least one, at most MAX_SHIFTS_PER_SAVE, each valid. */
    async function readShiftList(ctx: Ctx, raw: Record<string, unknown> | null): Promise<{ shifts: ShiftInput[] } | { problem: string }> {
        const list = Array.isArray(raw?.shifts) ? raw.shifts as Record<string, unknown>[] : null;
        if (!list?.length) return { problem: 'Nothing to save.' };
        if (list.length > MAX_SHIFTS_PER_SAVE) return { problem: `Save at most ${MAX_SHIFTS_PER_SAVE} at once.` };
        const { peopleIds, storeIds } = await lookups(ctx);
        const shifts: ShiftInput[] = [];
        for (const item of list) {
            const one = readShift(item && typeof item === 'object' ? item : {}, peopleIds, storeIds);
            if ('problem' in one) return one;
            shifts.push(one.shift);
        }
        return { shifts };
    }

    /** POST /staff-roster/shifts { shifts: [...] } — one shift, or the same shift on several days. */
    const createShifts: Handler = async (ctx) => {
        const session = await caller(ctx);
        if (session instanceof Response) return session;
        const db = ctx.env.VAYU_DB;
        const read = await readShiftList(ctx, await body(ctx));
        if ('problem' in read) return err(read.problem);
        const inputs = read.shifts;
        const now = Date.now();
        const created = inputs.map(s => ({ ...s, id: newId('sh') }));
        const stmts: D1PreparedStatement[] = [];
        for (const s of created) {
            const replaced = await replacedDayOff(db, s);
            if (replaced instanceof Response) return replaced;
            if (replaced) stmts.push(replaced);
            stmts.push(db.prepare(
                `INSERT INTO staff_shifts (id, kind, employee_id, store_id, date, start_min, end_min, break_min, role, note, created_at, updated_at, updated_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(s.id, s.kind, s.employeeId, s.storeId, s.date, s.startMin, s.endMin, s.breakMin, s.role, s.note, now, now, session.userId));
        }
        await db.batch(stmts);
        await markChanged(db, created.map(s => s.date));
        deps.logChange(ctx, session, 'created', 'shift', created[0].id, addedShiftsText(created));
        signal(ctx, created[0].id);
        return json(created, 201);
    };

    /** PUT /staff-roster/shifts/:id */
    const updateShift: Handler = async (ctx) => {
        const session = await caller(ctx);
        if (session instanceof Response) return session;
        const db = ctx.env.VAYU_DB;
        const id = SHIFT_PATH.exec(ctx.path)?.[1];
        const existing = id ? await db.prepare('SELECT * FROM staff_shifts WHERE id = ?').bind(id).first<Record<string, unknown>>() : null;
        if (!id || !existing) return err('That shift no longer exists.', 404);
        const raw = await body(ctx);
        if (!raw) return err('Invalid request body');
        const { peopleIds, storeIds } = await lookups(ctx);
        const read = readShift({ ...raw, kind: existing.kind }, peopleIds, storeIds);
        if ('problem' in read) return err(read.problem);
        const s = read.shift;
        const stmts = [db.prepare(
            `UPDATE staff_shifts SET employee_id = ?, store_id = ?, date = ?, start_min = ?, end_min = ?, break_min = ?, role = ?, note = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
        ).bind(s.employeeId, s.storeId, s.date, s.startMin, s.endMin, s.breakMin, s.role, s.note, Date.now(), session.userId, id)];
        if (s.kind === 'shift' && s.employeeId) {
            stmts.unshift(db.prepare("DELETE FROM staff_shifts WHERE kind = 'off' AND employee_id = ? AND date = ?").bind(s.employeeId, s.date));
        }
        await db.batch(stmts);
        await markChanged(db, [text(existing.date), s.date]);
        deps.logChange(ctx, session, 'updated', 'shift', id, `Changed a shift on ${fmtDay(s.date)}`);
        signal(ctx, id);
        return json({ ...s, id });
    };

    /** DELETE /staff-roster/shifts/:id */
    const deleteShift: Handler = async (ctx) => {
        const session = await caller(ctx);
        if (session instanceof Response) return session;
        const db = ctx.env.VAYU_DB;
        const id = SHIFT_PATH.exec(ctx.path)?.[1];
        const existing = id ? await db.prepare('SELECT * FROM staff_shifts WHERE id = ?').bind(id).first<Record<string, unknown>>() : null;
        if (!id || !existing) return err('That shift no longer exists.', 404);
        await db.prepare('DELETE FROM staff_shifts WHERE id = ?').bind(id).run();
        await markChanged(db, [text(existing.date)]);
        deps.logChange(ctx, session, 'deleted', 'shift', id, `Removed ${existing.kind === 'off' ? 'a day off' : 'a shift'} on ${fmtDay(text(existing.date))}`);
        signal(ctx, id);
        return json({ success: true });
    };

    /** POST /staff-roster/publish { weekStart, notify } */
    const publish: Handler = async (ctx) => {
        const session = await caller(ctx);
        if (session instanceof Response) return session;
        const db = ctx.env.VAYU_DB;
        const raw = await body(ctx);
        const weekStart = text(raw?.weekStart);
        if (!isIsoDate(weekStart) || mondayOf(weekStart) !== weekStart) return err('Choose a week (its Monday).');
        const end = addDays(weekStart, 6);
        const shifts = ((await db.prepare('SELECT * FROM staff_shifts WHERE date >= ? AND date <= ?')
            .bind(addDays(weekStart, -1), end).all()).results || []).map(r => rowToShift(r as Record<string, unknown>));
        const leaves = ((await db.prepare("SELECT * FROM staff_leaves WHERE status = 'approved' AND from_date <= ? AND to_date >= ?")
            .bind(end, addDays(weekStart, -1)).all()).results || []).map(r => rowToLeave(r as Record<string, unknown>));
        const week = shifts.filter(s => s.date >= weekStart);
        const conflicts = findConflicts(shifts, leaves);
        const blocking = week.filter(s => conflicts.has(s.id)).map(s => s.id);
        if (blocking.length) {
            return json({ error: 'Fix the overlapping shifts and shifts during approved leave first.', code: 'conflicts', shiftIds: blocking }, 409);
        }
        const now = Date.now();
        await db.prepare(
            `INSERT INTO staff_weeks (week_start, published_at, published_by, published_by_name, snapshot, changed) VALUES (?, ?, ?, ?, ?, 0)
             ON CONFLICT(week_start) DO UPDATE SET published_at = excluded.published_at, published_by = excluded.published_by,
               published_by_name = excluded.published_by_name, snapshot = excluded.snapshot, changed = 0`,
        ).bind(weekStart, now, session.userId, session.name, JSON.stringify(week)).run();
        const staff = [...new Set(week.filter(s => s.kind === 'shift' && s.employeeId).map(s => s.employeeId as string))];
        const notified = raw?.notify === true ? staff.filter(id => id !== session.userId) : [];
        if (notified.length) {
            deps.push(ctx, notified, {
                title: 'Your roster is ready',
                body: `${session.name} published the shifts for ${fmtRange(weekStart, end)}.`,
                tag: `roster-${weekStart}`,
                data: { view: 'schedule' },
            });
        }
        deps.logChange(ctx, session, 'updated', 'roster week', weekStart, `Published the roster for ${fmtRange(weekStart, end)}`);
        signal(ctx, weekStart);
        return json({ weekStart, status: 'published', publishedAt: now, publishedByName: session.name, notified: notified.length });
    };

    /** POST /staff-roster/leaves — for yourself (pending), or, as a manager, for someone else (approved). */
    const requestLeave: Handler = async (ctx) => {
        const session = await caller(ctx);
        if (session instanceof Response) return session;
        const db = ctx.env.VAYU_DB;
        const raw = await body(ctx);
        if (!raw) return err('Invalid request body');
        const employeeId = typeof raw.employeeId === 'string' && raw.employeeId ? raw.employeeId : session.userId;
        const forSomeoneElse = employeeId !== session.userId;
        if (forSomeoneElse) {
            if (!(await deps.canManage(ctx, session))) return err('You can only ask for leave for yourself.', 403);
            if (!(await lookups(ctx)).peopleIds.has(employeeId)) return err('That person is not on this team.');
        }
        const from = text(raw.from), to = text(raw.to);
        const datesProblem = leaveDatesProblem(from, to);
        if (datesProblem) return err(datesProblem);
        const asked = text(raw.type);
        const type = (LEAVE_TYPES as readonly string[]).includes(asked) ? asked : 'Other';
        const reason = cleanText(raw.reason, 300);
        const now = Date.now();
        const leave = newLeave({ employeeId, from, to, type, reason }, forSomeoneElse ? session.name : null, now);
        await db.prepare(
            `INSERT INTO staff_leaves (id, employee_id, from_date, to_date, type, reason, status, requested_at, requested_by, decided_at, decided_by, decided_by_name)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(leave.id, employeeId, from, to, type, reason, leave.status, now, session.userId, leave.decidedAt, forSomeoneElse ? session.userId : null, leave.decidedByName).run();
        if (leave.status === 'approved') await markChangedForLeave(db, leave);
        deps.logChange(ctx, session, 'created', 'leave', leave.id, `${forSomeoneElse ? 'Recorded' : 'Asked for'} ${type.toLowerCase()} ${fmtRange(from, to)}`);
        signal(ctx, leave.id);
        return json(leave, 201);
    };

    /** PATCH /staff-roster/leaves/:id { status: 'approved' | 'declined' } — managers. */
    const decideLeave: Handler = async (ctx) => {
        const session = await caller(ctx);
        if (session instanceof Response) return session;
        const db = ctx.env.VAYU_DB;
        const id = LEAVE_PATH.exec(ctx.path)?.[1];
        const row = id ? await db.prepare('SELECT * FROM staff_leaves WHERE id = ?').bind(id).first<Record<string, unknown>>() : null;
        if (!id || !row) return err('That request no longer exists.', 404);
        const raw = await body(ctx);
        const status = raw?.status === 'approved' || raw?.status === 'declined' ? raw.status : null;
        if (!status) return err('Approve or decline.');
        const leave = rowToLeave(row);
        if (leave.status !== 'pending') return err(`This request was already ${leave.status}.`, 409);
        const now = Date.now();
        await db.prepare('UPDATE staff_leaves SET status = ?, decided_at = ?, decided_by = ?, decided_by_name = ? WHERE id = ?')
            .bind(status, now, session.userId, session.name, id).run();
        const decided: StaffLeave = { ...leave, status, decidedAt: now, decidedByName: session.name };
        if (status === 'approved') await markChangedForLeave(db, decided);
        if (leave.employeeId !== session.userId) {
            deps.push(ctx, [leave.employeeId], {
                title: status === 'approved' ? 'Leave approved' : 'Leave declined',
                body: `${session.name} ${status} your ${leave.type.toLowerCase()} for ${fmtRange(leave.from, leave.to)}.`,
                tag: `leave-${id}`,
                data: { view: 'schedule' },
            });
        }
        deps.logChange(ctx, session, 'updated', 'leave', id, `${status === 'approved' ? 'Approved' : 'Declined'} ${leave.type.toLowerCase()} ${fmtRange(leave.from, leave.to)}`);
        signal(ctx, id);
        return json(decided);
    };

    /** DELETE /staff-roster/leaves/:id — withdraw your own pending request; managers can remove any. */
    const deleteLeave: Handler = async (ctx) => {
        const session = await caller(ctx);
        if (session instanceof Response) return session;
        const db = ctx.env.VAYU_DB;
        const id = LEAVE_PATH.exec(ctx.path)?.[1];
        const row = id ? await db.prepare('SELECT * FROM staff_leaves WHERE id = ?').bind(id).first<Record<string, unknown>>() : null;
        if (!id || !row) return err('That request no longer exists.', 404);
        const leave = rowToLeave(row);
        const manage = await deps.canManage(ctx, session);
        if (!manage && !(leave.employeeId === session.userId && leave.status === 'pending')) {
            return err('You can withdraw only your own requests that are still waiting.', 403);
        }
        await db.prepare('DELETE FROM staff_leaves WHERE id = ?').bind(id).run();
        if (leave.status === 'approved') await markChangedForLeave(db, leave);
        deps.logChange(ctx, session, 'deleted', 'leave', id, `Removed ${leave.type.toLowerCase()} ${fmtRange(leave.from, leave.to)}`);
        signal(ctx, id);
        return json({ success: true });
    };

    /** PUT /staff-roster/titles/:employeeId { title } — the job title shown on the roster. */
    const setTitle: Handler = async (ctx) => {
        const session = await caller(ctx);
        if (session instanceof Response) return session;
        const db = ctx.env.VAYU_DB;
        let employeeId = '';
        try { employeeId = decodeURIComponent(TITLE_PATH.exec(ctx.path)?.[1] ?? ''); } catch { /* refused below */ }
        if (!employeeId || !(await lookups(ctx)).peopleIds.has(employeeId)) return err('That person is not on this team.', 404);
        const title = cleanText((await body(ctx))?.title, 60);
        if (title) {
            await db.prepare('INSERT INTO staff_titles (employee_id, title) VALUES (?, ?) ON CONFLICT(employee_id) DO UPDATE SET title = excluded.title')
                .bind(employeeId, title).run();
        } else {
            await db.prepare('DELETE FROM staff_titles WHERE employee_id = ?').bind(employeeId).run();
        }
        signal(ctx, `title-${employeeId}`);
        return json({ employeeId, title });
    };

    return [
        { method: 'GET', match: p => p === '/staff-roster', handler: load },
        { method: 'POST', match: p => p === '/staff-roster/shifts', handler: createShifts },
        { method: 'PUT', match: p => SHIFT_PATH.test(p), handler: updateShift },
        { method: 'DELETE', match: p => SHIFT_PATH.test(p), handler: deleteShift },
        { method: 'POST', match: p => p === '/staff-roster/publish', handler: publish },
        { method: 'POST', match: p => p === '/staff-roster/leaves', handler: requestLeave },
        { method: 'PATCH', match: p => LEAVE_PATH.test(p), handler: decideLeave },
        { method: 'DELETE', match: p => LEAVE_PATH.test(p), handler: deleteLeave },
        { method: 'PUT', match: p => TITLE_PATH.test(p), handler: setTitle },
    ];
}
