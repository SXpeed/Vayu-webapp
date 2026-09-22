// Plans, versions, subscriptions and entitlements.
//
// Rules that shape this file:
//  - A published version never changes. Editing a plan means publishing a new
//    version; organizations move to it only when someone says so, so nobody's
//    contract changes under them.
//  - Limits are enforced on the server. Anything the browser checks is for
//    convenience only.
//  - A downgrade never deletes data. An organization over its new limit keeps
//    everything and is simply blocked from adding more until it is under.

import { auditStmt } from './audit';
import { OrgError, type Actor } from './orgs';
import { FEATURE_FIELDS, LIMIT_FIELDS, MODULE_FIELDS } from './planFields';

/**
 * What a plan allows. Countable limits (null = unlimited), module switches and
 * feature flags, all defined in planFields.ts.
 */
export interface PlanLimits {
  limits: Record<string, number | null>;
  modules: Record<string, boolean>;
  features: Record<string, boolean>;
  integrations: string[];
}

export const DEFAULT_LIMITS: PlanLimits = {
  limits: Object.fromEntries(LIMIT_FIELDS.map(f => [f.key, f.default])),
  modules: Object.fromEntries(MODULE_FIELDS.map(f => [f.key, f.default])),
  features: Object.fromEntries(FEATURE_FIELDS.map(f => [f.key, f.default])),
  integrations: [],
};

const BILLING_TYPES = ['free', 'trial', 'paid', 'custom'] as const;
const PLAN_STATUSES = ['draft', 'published', 'retired', 'archived'] as const;

type BillingType = typeof BILLING_TYPES[number];

function num(v: unknown, field: string, { min = 0, max = 100_000_000, nullable = false } = {}): number | null {
  if ((v === null || v === undefined || v === '') && nullable) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new OrgError(400, 'invalid', `${field} must be a number between ${min} and ${max}${nullable ? ', or empty for unlimited' : ''}.`);
  }
  return Math.floor(v);
}

function flags(raw: unknown, fields: typeof MODULE_FIELDS): Record<string, boolean> {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return Object.fromEntries(fields.map(f => [
    f.key,
    // Part of every plan: never switchable, whatever the caller sends.
    f.alwaysOn ? true : (typeof src[f.key] === 'boolean' ? src[f.key] as boolean : f.default),
  ]));
}

/** Validates and fills in anything the caller left out. */
export function parseLimits(raw: unknown): PlanLimits {
  const l = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  // Accept either the nested shape or a flat one (older payloads and
  // single-key overrides both arrive flat).
  const limitsSrc = (l.limits && typeof l.limits === 'object' ? l.limits : l) as Record<string, unknown>;
  const limits: Record<string, number | null> = {};
  for (const f of LIMIT_FIELDS) {
    const value = limitsSrc[f.key] === undefined ? f.default : limitsSrc[f.key];
    limits[f.key] = num(value, f.label, { nullable: f.nullable, max: f.max, min: f.nullable ? 0 : 1 });
  }
  const integrations = Array.isArray(l.integrations)
    ? (l.integrations as unknown[]).filter(i => typeof i === 'string').slice(0, 20) as string[]
    : [];
  return {
    limits,
    modules: flags(l.modules, MODULE_FIELDS),
    features: flags(l.features ?? l, FEATURE_FIELDS),
    integrations,
  };
}

/** One limit's value for an organization, after overrides. */
export function limitOf(entitlements: { limits: PlanLimits }, key: string): number | null {
  return entitlements.limits.limits[key] ?? null;
}

const str = (v: unknown, field: string, max = 200, min = 1): string => {
  if (typeof v !== 'string' || v.trim().length < min || v.trim().length > max) {
    throw new OrgError(400, 'invalid', `${field} must be ${min}–${max} characters.`);
  }
  return v.trim();
};

// ── Plans ─────────────────────────────────────────────────────────────────

export async function listPlans(db: D1Database) {
  // One query for the whole list, including what the current published
  // version costs and allows, so the list never needs a request per plan.
  const { results } = await db.prepare(
    `SELECT p.*,
            (SELECT COUNT(*) FROM plan_versions v WHERE v.plan_id = p.id) AS versions,
            (SELECT COUNT(*) FROM plan_versions v WHERE v.plan_id = p.id AND v.status = 'draft') AS drafts,
            (SELECT COUNT(*) FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id WHERE v.plan_id = p.id) AS organizations,
            cur.version AS published_version, cur.billing_type, cur.currency, cur.price_monthly, cur.price_annual,
            cur.trial_days, cur.limits AS published_limits
     FROM plans p
     LEFT JOIN plan_versions cur ON cur.id = (
       SELECT v.id FROM plan_versions v WHERE v.plan_id = p.id AND v.status = 'published' ORDER BY v.version DESC LIMIT 1)
     ORDER BY p.sort_order, p.name`,
  ).all();
  return results;
}

export async function getPlan(db: D1Database, planId: string) {
  const plan = await db.prepare('SELECT * FROM plans WHERE id = ?').bind(planId).first();
  if (!plan) throw new OrgError(404, 'plan_not_found', 'Plan not found.');
  const { results: versions } = await db.prepare(
    `SELECT v.*, (SELECT COUNT(*) FROM subscriptions s WHERE s.plan_version_id = v.id) AS organizations
     FROM plan_versions v WHERE v.plan_id = ? ORDER BY v.version DESC`,
  ).bind(planId).all();
  return { ...plan, versions };
}

export async function createPlan(db: D1Database, body: Record<string, unknown>, actor: Actor) {
  const name = str(body.name, 'Plan name', 80);
  const key = str(body.key ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), 'Plan key', 40)
    .toLowerCase().replace(/[^a-z0-9-]/g, '');
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await db.batch([
      db.prepare(`INSERT INTO plans (id, key, name, description, status, is_public, sort_order, created_at, created_by, updated_at)
                  VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`)
        .bind(id, key, name, typeof body.description === 'string' ? body.description.slice(0, 500) : '',
          body.isPublic === true ? 1 : 0, num(body.sortOrder ?? 0, 'Sort order', { max: 1000 }), now, actor.userId, now),
      auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'plan.create', targetType: 'plan', targetId: id, details: { key, name }, ip: actor.ip }),
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String((e as Error).message))) throw new OrgError(409, 'plan_key_taken', `A plan with the key "${key}" already exists.`);
    throw e;
  }
  return getPlan(db, id);
}

export async function updatePlan(db: D1Database, planId: string, body: Record<string, unknown>, actor: Actor) {
  const current = await db.prepare('SELECT * FROM plans WHERE id = ?').bind(planId).first<{ status: string; name: string }>();
  if (!current) throw new OrgError(404, 'plan_not_found', 'Plan not found.');
  const name = body.name === undefined ? current.name : str(body.name, 'Plan name', 80);
  const status = body.status === undefined ? current.status
    : (PLAN_STATUSES.includes(body.status as never) ? body.status as string
      : (() => { throw new OrgError(400, 'invalid', `Status must be one of: ${PLAN_STATUSES.join(', ')}.`); })());
  if (status === 'published') {
    const published = await db.prepare("SELECT 1 FROM plan_versions WHERE plan_id = ? AND status = 'published'").bind(planId).first();
    if (!published) throw new OrgError(409, 'no_published_version', 'Publish a version before publishing the plan.');
  }
  const isPublic = body.isPublic === undefined ? null : (body.isPublic === true ? 1 : 0);
  await db.batch([
    db.prepare(`UPDATE plans SET name = ?, description = COALESCE(?, description), status = ?,
                  is_public = COALESCE(?, is_public), sort_order = COALESCE(?, sort_order), updated_at = ?
                WHERE id = ?`)
      .bind(name, typeof body.description === 'string' ? body.description.slice(0, 500) : null, status,
        isPublic, body.sortOrder === undefined ? null : num(body.sortOrder, 'Sort order', { max: 1000 }), Date.now(), planId),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'plan.update', targetType: 'plan', targetId: planId, details: { name, status, isPublic }, ip: actor.ip }),
  ]);
  return getPlan(db, planId);
}

/** Adds a draft version. Drafts can be edited; published ones never change. */
export async function createPlanVersion(db: D1Database, planId: string, body: Record<string, unknown>, actor: Actor) {
  const plan = await db.prepare('SELECT id FROM plans WHERE id = ?').bind(planId).first();
  if (!plan) throw new OrgError(404, 'plan_not_found', 'Plan not found.');
  const billingType = BILLING_TYPES.includes(body.billingType as never) ? body.billingType as BillingType : null;
  if (!billingType) throw new OrgError(400, 'invalid', `Billing type must be one of: ${BILLING_TYPES.join(', ')}.`);
  const limits = parseLimits(body.limits);
  const currency = str(body.currency ?? 'INR', 'Currency', 3, 3).toUpperCase();
  const priceMonthly = num(body.priceMonthly ?? 0, 'Monthly price') as number;
  const priceAnnual = num(body.priceAnnual ?? 0, 'Annual price') as number;
  const trialDays = num(body.trialDays ?? 0, 'Trial days', { max: 365 }) as number;
  if (billingType === 'paid' && priceMonthly === 0 && priceAnnual === 0) {
    throw new OrgError(400, 'invalid', 'A paid plan needs a monthly or annual price.');
  }
  if (billingType === 'trial' && trialDays === 0) throw new OrgError(400, 'invalid', 'A trial plan needs a trial length.');

  const last = await db.prepare('SELECT MAX(version) AS v FROM plan_versions WHERE plan_id = ?').bind(planId).first<{ v: number | null }>();
  const version = (last?.v ?? 0) + 1;
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare(`INSERT INTO plan_versions (id, plan_id, version, status, billing_type, currency, price_monthly, price_annual, trial_days, limits, notes, created_at, created_by)
                VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, planId, version, billingType, currency, priceMonthly, priceAnnual, trialDays,
        JSON.stringify(limits), typeof body.notes === 'string' ? body.notes.slice(0, 500) : null, Date.now(), actor.userId),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'plan.version.create', targetType: 'plan_version', targetId: id, details: { planId, version, billingType, limits }, ip: actor.ip }),
  ]);
  return getPlan(db, planId);
}

export async function updatePlanVersion(db: D1Database, planId: string, versionId: string, body: Record<string, unknown>, actor: Actor) {
  const current = await db.prepare('SELECT * FROM plan_versions WHERE id = ? AND plan_id = ?')
    .bind(versionId, planId).first<{ status: string }>();
  if (!current) throw new OrgError(404, 'version_not_found', 'Plan version not found.');

  if (body.status === 'published') {
    if (current.status === 'published') return getPlan(db, planId);
    await db.batch([
      db.prepare("UPDATE plan_versions SET status = 'published', published_at = ? WHERE id = ?").bind(Date.now(), versionId),
      auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'plan.version.publish', targetType: 'plan_version', targetId: versionId, details: { planId }, ip: actor.ip }),
    ]);
    return getPlan(db, planId);
  }
  if (body.status === 'retired') {
    await db.batch([
      db.prepare("UPDATE plan_versions SET status = 'retired' WHERE id = ?").bind(versionId),
      auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'plan.version.retire', targetType: 'plan_version', targetId: versionId, details: { planId }, ip: actor.ip }),
    ]);
    return getPlan(db, planId);
  }

  if (current.status !== 'draft') {
    throw new OrgError(409, 'version_published', 'A published version cannot be edited. Create a new version instead.');
  }
  const limits = parseLimits(body.limits);
  await db.batch([
    db.prepare(`UPDATE plan_versions SET billing_type = COALESCE(?, billing_type), currency = COALESCE(?, currency),
                  price_monthly = COALESCE(?, price_monthly), price_annual = COALESCE(?, price_annual),
                  trial_days = COALESCE(?, trial_days), limits = ?, notes = COALESCE(?, notes)
                WHERE id = ? AND status = 'draft'`)
      .bind(BILLING_TYPES.includes(body.billingType as never) ? body.billingType as string : null,
        typeof body.currency === 'string' ? body.currency.toUpperCase().slice(0, 3) : null,
        body.priceMonthly === undefined ? null : num(body.priceMonthly, 'Monthly price'),
        body.priceAnnual === undefined ? null : num(body.priceAnnual, 'Annual price'),
        body.trialDays === undefined ? null : num(body.trialDays, 'Trial days', { max: 365 }),
        JSON.stringify(limits), typeof body.notes === 'string' ? body.notes.slice(0, 500) : null, versionId),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'plan.version.update', targetType: 'plan_version', targetId: versionId, details: { planId, limits }, ip: actor.ip }),
  ]);
  return getPlan(db, planId);
}

/** Plans the marketing site may show: published, public, with a published version. */
export async function publicPlans(db: D1Database) {
  const { results } = await db.prepare(
    `SELECT p.key, p.name, p.description, v.billing_type, v.currency, v.price_monthly, v.price_annual, v.trial_days, v.limits
     FROM plans p
     JOIN plan_versions v ON v.plan_id = p.id AND v.status = 'published'
     WHERE p.status = 'published' AND p.is_public = 1
       AND v.version = (SELECT MAX(v2.version) FROM plan_versions v2 WHERE v2.plan_id = p.id AND v2.status = 'published')
     ORDER BY p.sort_order, p.name`,
  ).all();
  // Only what a price card needs; internal ids and notes stay inside.
  return (results as Record<string, unknown>[]).map(r => {
    const limits = JSON.parse(String(r.limits)) as PlanLimits;
    return {
      key: r.key, name: r.name, description: r.description, billingType: r.billing_type,
      currency: r.currency, priceMonthly: r.price_monthly, priceAnnual: r.price_annual, trialDays: r.trial_days,
      highlights: { limits: limits.limits, modules: limits.modules, features: limits.features },
    };
  });
}

// ── Subscriptions and entitlements ────────────────────────────────────────

export interface Entitlements {
  limits: PlanLimits;
  plan: { key: string; name: string; version: number; billingType: string } | null;
  subscription: { status: string; trialEndsAt: number | null; currentPeriodEnd: number | null; paymentWaived: boolean };
  overrides: Record<string, unknown>;
  /** True when the organization may add things (not expired, not blocked). */
  active: boolean;
}

/**
 * The limits actually in force: the plan version's, with any documented
 * per-organization overrides applied on top. An organization with no
 * subscription gets the conservative defaults.
 */
export async function resolveEntitlements(db: D1Database, orgId: string): Promise<Entitlements> {
  const row = await db.prepare(
    `SELECT s.status, s.trial_ends_at, s.current_period_end, s.payment_waived,
            v.version, v.billing_type, v.limits, p.key, p.name
     FROM subscriptions s
     LEFT JOIN plan_versions v ON v.id = s.plan_version_id
     LEFT JOIN plans p ON p.id = v.plan_id
     WHERE s.org_id = ?`,
  ).bind(orgId).first<Record<string, unknown>>();

  const limits = row?.limits ? parseLimits(JSON.parse(String(row.limits))) : { ...DEFAULT_LIMITS };
  const { results: overrideRows } = await db.prepare(
    'SELECT key, value FROM entitlement_overrides WHERE org_id = ? AND (expires_at IS NULL OR expires_at > ?)',
  ).bind(orgId, Date.now()).all();

  const overrides: Record<string, unknown> = {};
  for (const o of overrideRows as { key: string; value: string }[]) {
    try {
      const value = JSON.parse(o.value);
      overrides[o.key] = value;
      // An override names one field: a countable limit, a module or a feature.
      if (o.key in limits.limits) limits.limits[o.key] = value as number | null;
      else if (o.key in limits.modules) limits.modules[o.key] = value === true;
      else if (o.key in limits.features) limits.features[o.key] = value === true;
    } catch { /* ignore an unreadable override rather than failing the request */ }
  }

  const status = (row?.status as string) ?? 'none';
  const trialEndsAt = (row?.trial_ends_at as number) ?? null;
  const trialExpired = status === 'trialing' && !!trialEndsAt && trialEndsAt < Date.now();
  const active = !trialExpired && ['active', 'trialing', 'none'].includes(status);

  return {
    limits,
    plan: row?.key ? { key: String(row.key), name: String(row.name), version: Number(row.version), billingType: String(row.billing_type) } : null,
    subscription: {
      status: trialExpired ? 'trial_expired' : status,
      trialEndsAt,
      currentPeriodEnd: (row?.current_period_end as number) ?? null,
      paymentWaived: row?.payment_waived === 1,
    },
    overrides,
    active,
  };
}

/** Seats used and how much room is left. */
export async function seatUsage(db: D1Database, orgId: string) {
  const entitlements = await resolveEntitlements(db, orgId);
  const row = await db.prepare(
    "SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND status = 'active'",
  ).bind(orgId).first<{ n: number }>();
  const used = row?.n ?? 0;
  const limit = limitOf(entitlements, 'maxMembers');
  return { used, limit, remaining: limit === null ? null : Math.max(limit - used, 0), overLimit: limit !== null && used > limit };
}

/**
 * Adds one active member if a seat is free — in a single statement, so two
 * requests racing for the last seat cannot both win.
 */
export function insertMemberWithinSeatLimit(
  db: D1Database,
  args: { id: string; orgId: string; userId: string; role: string; actorId: string; maxMembers: number | null },
): D1PreparedStatement {
  const now = Date.now();
  if (args.maxMembers === null) {
    return db.prepare(`INSERT INTO memberships (id, org_id, user_id, role, status, created_at, created_by, updated_at)
                       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`)
      .bind(args.id, args.orgId, args.userId, args.role, now, args.actorId, now);
  }
  return db.prepare(
    `INSERT INTO memberships (id, org_id, user_id, role, status, created_at, created_by, updated_at)
     SELECT ?, ?, ?, ?, 'active', ?, ?, ?
     WHERE (SELECT COUNT(*) FROM memberships WHERE org_id = ? AND status = 'active') < ?`,
  ).bind(args.id, args.orgId, args.userId, args.role, now, args.actorId, now, args.orgId, args.maxMembers);
}

export async function setSubscription(db: D1Database, orgId: string, body: Record<string, unknown>, actor: Actor) {
  const org = await db.prepare('SELECT status FROM organizations WHERE id = ?').bind(orgId).first<{ status: string }>();
  if (!org) throw new OrgError(404, 'org_not_found', 'Organization not found.');

  const versionId = typeof body.planVersionId === 'string' ? body.planVersionId : null;
  let version: { id: string; billing_type: string; trial_days: number; status: string } | null = null;
  if (versionId) {
    version = await db.prepare('SELECT id, billing_type, trial_days, status FROM plan_versions WHERE id = ?')
      .bind(versionId).first();
    if (!version) throw new OrgError(404, 'version_not_found', 'Plan version not found.');
    if (version.status !== 'published') throw new OrgError(409, 'version_not_published', 'Only a published version can be assigned.');
  }

  const before = await db.prepare('SELECT status, plan_version_id FROM subscriptions WHERE org_id = ?').bind(orgId).first();
  const waive = body.waivePayment === true;
  const reason = waive || body.status ? str(body.reason, 'Reason', 500, 3) : null;

  let status = typeof body.status === 'string' ? body.status : null;
  let trialEndsAt = typeof body.trialEndsAt === 'number' ? body.trialEndsAt : null;
  if (!status && version) {
    // Default by billing type: free and waived start active, trials start
    // their clock now, paid waits for payment.
    if (version.billing_type === 'free' || waive) status = 'active';
    else if (version.billing_type === 'trial') { status = 'trialing'; trialEndsAt ??= Date.now() + version.trial_days * 86_400_000; }
    else status = 'payment_required';
  }
  status ??= 'none';
  const allowed = ['none', 'trialing', 'payment_required', 'active', 'past_due', 'canceled'];
  if (!allowed.includes(status)) throw new OrgError(400, 'invalid', `Status must be one of: ${allowed.join(', ')}.`);

  const now = Date.now();
  await db.batch([
    db.prepare(
      `INSERT INTO subscriptions (org_id, plan_version_id, status, trial_ends_at, payment_waived, waiver_reason, started_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(org_id) DO UPDATE SET
         plan_version_id = COALESCE(excluded.plan_version_id, subscriptions.plan_version_id),
         status = excluded.status, trial_ends_at = COALESCE(excluded.trial_ends_at, subscriptions.trial_ends_at),
         payment_waived = excluded.payment_waived, waiver_reason = COALESCE(excluded.waiver_reason, subscriptions.waiver_reason),
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).bind(orgId, versionId, status, trialEndsAt, waive ? 1 : 0, reason, now, now, actor.userId),
    auditStmt(db, {
      actorUserId: actor.userId, actorKind: 'provider_admin', action: 'subscription.update',
      targetType: 'organization', targetId: orgId, orgId,
      details: { before, after: { planVersionId: versionId, status, trialEndsAt, waivePayment: waive }, reason }, ip: actor.ip,
    }),
  ]);
  return resolveEntitlements(db, orgId);
}

export async function extendTrial(db: D1Database, orgId: string, body: Record<string, unknown>, actor: Actor) {
  const days = num(body.days, 'Days', { min: 1, max: 365 }) as number;
  const reason = str(body.reason, 'Reason', 500, 3);
  const current = await db.prepare('SELECT trial_ends_at, status FROM subscriptions WHERE org_id = ?')
    .bind(orgId).first<{ trial_ends_at: number | null; status: string }>();
  if (!current) throw new OrgError(404, 'no_subscription', 'This organization has no subscription yet.');
  const base = Math.max(current.trial_ends_at ?? 0, Date.now());
  const trialEndsAt = base + days * 86_400_000;
  await db.batch([
    db.prepare("UPDATE subscriptions SET trial_ends_at = ?, status = 'trialing', updated_at = ?, updated_by = ? WHERE org_id = ?")
      .bind(trialEndsAt, Date.now(), actor.userId, orgId),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'subscription.trial.extend', targetType: 'organization', targetId: orgId, orgId, details: { days, reason, trialEndsAt }, ip: actor.ip }),
  ]);
  return resolveEntitlements(db, orgId);
}

export async function setOverride(db: D1Database, orgId: string, body: Record<string, unknown>, actor: Actor) {
  const key = str(body.key, 'Key', 40);
  const limitField = LIMIT_FIELDS.find(f => f.key === key);
  const isFlag = [...MODULE_FIELDS, ...FEATURE_FIELDS].some(f => f.key === key);
  if (!limitField && !isFlag) throw new OrgError(400, 'invalid', `"${key}" is not something a plan controls.`);
  const alwaysOn = [...MODULE_FIELDS, ...FEATURE_FIELDS].find(f => f.key === key)?.alwaysOn;
  if (alwaysOn && body.value !== true) throw new OrgError(400, 'invalid', `${key} is part of every plan and cannot be switched off.`);
  const reason = str(body.reason, 'Reason', 500, 3);
  const expiresAt = body.expiresAt === undefined || body.expiresAt === null ? null : num(body.expiresAt, 'Expiry', { max: 4_102_444_800_000 });
  if (body.value === undefined) throw new OrgError(400, 'invalid', 'A value is required.');
  if (limitField) num(body.value, limitField.label, { nullable: limitField.nullable, max: limitField.max });
  else if (typeof body.value !== 'boolean') throw new OrgError(400, 'invalid', `${key} must be true or false.`);
  await db.batch([
    db.prepare(`INSERT INTO entitlement_overrides (org_id, key, value, reason, expires_at, created_at, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value, reason = excluded.reason,
                  expires_at = excluded.expires_at, created_at = excluded.created_at, created_by = excluded.created_by`)
      .bind(orgId, key, JSON.stringify(body.value), reason, expiresAt, Date.now(), actor.userId),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'entitlement.override.set', targetType: 'organization', targetId: orgId, orgId, details: { key, value: body.value, reason, expiresAt }, ip: actor.ip }),
  ]);
  return resolveEntitlements(db, orgId);
}

export async function removeOverride(db: D1Database, orgId: string, key: string, actor: Actor) {
  await db.batch([
    db.prepare('DELETE FROM entitlement_overrides WHERE org_id = ? AND key = ?').bind(orgId, key),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'entitlement.override.remove', targetType: 'organization', targetId: orgId, orgId, details: { key }, ip: actor.ip }),
  ]);
  return resolveEntitlements(db, orgId);
}
