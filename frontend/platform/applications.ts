// Business applications: from sign-up to a working organization.
//
//   applicant:  draft ⇄ edit → submit → pending_review
//   provider:   → needs_information (applicant answers, resubmits)
//               → rejected (with a reason)
//               → approved → provisioning → provisioned
//   billing:    free → active · trial → trialing · paid → payment_required
//               (unless the provider records a billing exception)
//
// Review, provisioning and billing are three separate fields. Approving does
// not by itself mean a workspace exists or that anything was paid.
//
// Approval is safe to repeat. The organization takes the application's own id,
// every insert is "if not already there", and a failed provisioning step can
// be retried by approving again — it never creates a second organization,
// database or membership.

import type { Env } from '../workerEnv';
import { auditStmt } from './audit';
import { BUSINESS_TYPES, OrgError, slugify, type Actor } from './orgs';
import { outboxStmt, getNotificationSettings } from './notify';
import { resolveEntitlements, setSubscription } from './plans';
import type { OrgStore } from './orgStore';

const OPEN = ['draft', 'pending_review', 'needs_information'];
const EDITABLE = ['draft', 'pending_review', 'needs_information'];

/** Fields the applicant fills in, with their limits. */
const TEXT_FIELDS: Record<string, number> = {
  business_name: 120, owner_name: 120, phone: 40, address_line: 200, city: 80, region: 80,
  postal_code: 20, country: 2, timezone: 64, website: 200, tax_id: 40, requested_plan_key: 40,
  applicant_note: 1000, business_type: 20,
};
const BODY_TO_COLUMN: Record<string, string> = {
  businessName: 'business_name', businessType: 'business_type', ownerName: 'owner_name', phone: 'phone',
  addressLine: 'address_line', city: 'city', region: 'region', postalCode: 'postal_code', country: 'country',
  timezone: 'timezone', website: 'website', taxId: 'tax_id', requestedPlanKey: 'requested_plan_key',
  applicantNote: 'applicant_note', expectedEmployees: 'expected_employees', expectedStores: 'expected_stores',
  billingCycle: 'billing_cycle',
};

/** Required before submitting. Everything else is optional. */
const REQUIRED = ['business_name', 'business_type', 'owner_name', 'phone', 'address_line', 'city', 'country', 'timezone', 'requested_plan_key'];

type Row = Record<string, unknown> & { id: string; user_id: string; review_status: string; provisioning_status: string };

function event(db: D1Database, applicationId: string, e: { actorUserId: string | null; actorKind: 'applicant' | 'provider_admin' | 'system'; action: string; message?: string | null; visible?: boolean }) {
  return db.prepare(
    `INSERT INTO application_events (id, application_id, at, actor_user_id, actor_kind, action, message, visible_to_applicant)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), applicationId, Date.now(), e.actorUserId, e.actorKind, e.action, e.message ?? null, e.visible === false ? 0 : 1);
}

function toClient(row: Row) {
  return {
    id: row.id,
    reviewStatus: row.review_status,
    provisioningStatus: row.provisioning_status,
    businessName: row.business_name, businessType: row.business_type, ownerName: row.owner_name,
    phone: row.phone, addressLine: row.address_line, city: row.city, region: row.region,
    postalCode: row.postal_code, country: row.country, timezone: row.timezone, website: row.website,
    taxId: row.tax_id, expectedEmployees: row.expected_employees, expectedStores: row.expected_stores,
    requestedPlanKey: row.requested_plan_key, billingCycle: row.billing_cycle, applicantNote: row.applicant_note,
    providerMessage: row.provider_message ?? null,
    orgId: row.org_id ?? null,
    submittedAt: row.submitted_at ?? null,
    decidedAt: row.decided_at ?? null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/**
 * The one status an applicant needs to understand, derived from the three
 * separate internal ones plus the organization's own status.
 */
async function displayStatus(db: D1Database, row: Row): Promise<string> {
  if (row.review_status !== 'approved') return row.review_status;
  if (row.provisioning_status === 'failed') return 'provisioning_failed';
  if (row.provisioning_status !== 'provisioned' || !row.org_id) return 'provisioning';
  const org = await db.prepare('SELECT status FROM organizations WHERE id = ?').bind(row.org_id).first<{ status: string }>();
  if (org?.status === 'suspended') return 'suspended';
  if (org?.status === 'closed') return 'closed';
  const ent = await resolveEntitlements(db, String(row.org_id));
  if (ent.subscription.status === 'payment_required') return 'payment_required';
  if (ent.subscription.status === 'trial_expired') return 'trial_expired';
  return 'active';
}

function readFields(body: Record<string, unknown>): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const [key, column] of Object.entries(BODY_TO_COLUMN)) {
    if (!(key in body)) continue;
    const v = body[key];
    if (column === 'expected_employees' || column === 'expected_stores') {
      if (v === null || v === '' || v === undefined) { out[column] = null; continue; }
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 1_000_000) throw new OrgError(400, 'invalid', `${key} must be a whole number.`);
      out[column] = n;
    } else if (column === 'billing_cycle') {
      if (v !== 'monthly' && v !== 'annual') throw new OrgError(400, 'invalid', 'Billing cycle must be monthly or annual.');
      out[column] = v;
    } else {
      const s = typeof v === 'string' ? v.trim() : '';
      const max = TEXT_FIELDS[column] ?? 200;
      if (s.length > max) throw new OrgError(400, 'invalid', `${key} must be at most ${max} characters.`);
      out[column] = column === 'country' ? s.toUpperCase() : s;
    }
  }
  if (out.business_type && !(BUSINESS_TYPES as readonly string[]).includes(String(out.business_type))) {
    throw new OrgError(400, 'invalid', `Business type must be one of: ${BUSINESS_TYPES.join(', ')}.`);
  }
  if (out.country && !/^[A-Z]{2}$/.test(String(out.country))) throw new OrgError(400, 'invalid', 'Country must be a two-letter code, e.g. IN.');
  if (out.website && !/^https?:\/\/[^\s]+$/i.test(String(out.website))) throw new OrgError(400, 'invalid', 'Website must start with http:// or https://.');
  if (out.phone && !/^[+()\d\s-]{6,40}$/.test(String(out.phone))) throw new OrgError(400, 'invalid', 'Enter a valid phone number.');
  return out;
}

async function openApplication(db: D1Database, userId: string): Promise<Row | null> {
  return db.prepare(
    `SELECT * FROM applications WHERE user_id = ? AND review_status IN ('draft','pending_review','needs_information')`,
  ).bind(userId).first<Row>();
}

async function latestApplication(db: D1Database, userId: string): Promise<Row | null> {
  return db.prepare('SELECT * FROM applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').bind(userId).first<Row>();
}

async function applicantEvents(db: D1Database, applicationId: string) {
  const { results } = await db.prepare(
    `SELECT at, actor_kind, action, message FROM application_events
     WHERE application_id = ? AND visible_to_applicant = 1 ORDER BY at`,
  ).bind(applicationId).all();
  return results;
}

// ── Applicant ─────────────────────────────────────────────────────────────

export async function getMyApplication(db: D1Database, userId: string) {
  const row = await latestApplication(db, userId);
  if (!row) return { application: null };
  return {
    application: { ...toClient(row), status: await displayStatus(db, row) },
    events: await applicantEvents(db, row.id),
  };
}

/** Creates the draft on first save; afterwards updates it. */
export async function saveMyApplication(db: D1Database, userId: string, body: Record<string, unknown>) {
  const fields = readFields(body);
  const now = Date.now();
  let row = await openApplication(db, userId);

  if (!row) {
    const last = await latestApplication(db, userId);
    if (last && last.review_status === 'approved') {
      throw new OrgError(409, 'already_approved', 'Your business is already approved. Open your workspace instead.');
    }
    const id = crypto.randomUUID();
    try {
      await db.batch([
        db.prepare('INSERT INTO applications (id, user_id, review_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .bind(id, userId, 'draft', now, now),
        event(db, id, { actorUserId: userId, actorKind: 'applicant', action: 'draft.created' }),
      ]);
    } catch (e) {
      // Another tab created it a moment ago: use that one.
      if (!/UNIQUE/i.test(String((e as Error).message))) throw e;
    }
    row = await openApplication(db, userId);
    if (!row) throw new OrgError(500, 'internal', 'Could not start the application.');
  }

  if (!EDITABLE.includes(row.review_status)) throw new OrgError(409, 'not_editable', 'This application can no longer be changed.');
  const columns = Object.keys(fields);
  if (columns.length) {
    await db.prepare(
      `UPDATE applications SET ${columns.map(c => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND user_id = ?`,
    ).bind(...columns.map(c => fields[c]), now, row.id, userId).run();
    if (row.review_status === 'pending_review') {
      await event(db, row.id, { actorUserId: userId, actorKind: 'applicant', action: 'corrected', message: 'Details corrected while under review.' }).run();
    }
  }
  return getMyApplication(db, userId);
}

export async function submitMyApplication(db: D1Database, userId: string, userEmail: string) {
  const row = await openApplication(db, userId);
  if (!row) throw new OrgError(404, 'no_application', 'Fill in your business details first.');
  // Submitting twice is harmless: it stays under review, nothing is duplicated.
  if (row.review_status === 'pending_review') return getMyApplication(db, userId);

  const missing = REQUIRED.filter(c => !String(row[c] ?? '').trim());
  if (missing.length) {
    throw new OrgError(400, 'incomplete', `Please fill in: ${missing.map(c => c.replace(/_/g, ' ')).join(', ')}.`);
  }
  const plan = await db.prepare(
    `SELECT 1 FROM plans p JOIN plan_versions v ON v.plan_id = p.id AND v.status = 'published'
     WHERE p.key = ? AND p.status = 'published' AND p.is_public = 1`,
  ).bind(row.requested_plan_key).first();
  if (!plan) throw new OrgError(400, 'invalid_plan', 'Choose one of the plans on offer.');

  const round = await db.prepare(
    "SELECT COUNT(*) AS n FROM application_events WHERE application_id = ? AND action IN ('submitted','resubmitted')",
  ).bind(row.id).first<{ n: number }>();
  const resubmission = row.review_status === 'needs_information';
  const { providerEmail } = await getNotificationSettings(db);
  const now = Date.now();

  const statements = [
    db.prepare(
      `UPDATE applications SET review_status = 'pending_review', submitted_at = ?, updated_at = ?
       WHERE id = ? AND review_status IN ('draft','needs_information')`,
    ).bind(now, now, row.id),
    event(db, row.id, { actorUserId: userId, actorKind: 'applicant', action: resubmission ? 'resubmitted' : 'submitted' }),
  ];
  if (providerEmail) {
    statements.push(outboxStmt(db, {
      dedupeKey: `application:${row.id}:submitted:${(round?.n ?? 0) + 1}`,
      kind: 'application_submitted',
      recipient: providerEmail,
      subject: `${resubmission ? 'Updated' : 'New'} application: ${row.business_name}`,
      body: `${row.business_name} (${row.business_type}) applied for the ${row.requested_plan_key} plan. Review it in the control panel. Applicant: ${userEmail}.`,
    }));
  }
  await db.batch(statements);
  return getMyApplication(db, userId);
}

export async function withdrawMyApplication(db: D1Database, userId: string) {
  const row = await openApplication(db, userId);
  if (!row) throw new OrgError(404, 'no_application', 'There is no open application.');
  await db.batch([
    db.prepare("UPDATE applications SET review_status = 'withdrawn', updated_at = ? WHERE id = ?").bind(Date.now(), row.id),
    event(db, row.id, { actorUserId: userId, actorKind: 'applicant', action: 'withdrawn' }),
  ]);
  return getMyApplication(db, userId);
}

// ── Provider ──────────────────────────────────────────────────────────────

export async function listApplications(db: D1Database, params: URLSearchParams) {
  const status = params.get('status');
  const valid = ['draft', 'pending_review', 'needs_information', 'approved', 'rejected', 'withdrawn'];
  const where = status && valid.includes(status) ? 'WHERE a.review_status = ?' : "WHERE a.review_status <> 'draft'";
  const stmt = db.prepare(
    `SELECT a.id, a.review_status, a.provisioning_status, a.business_name, a.business_type, a.requested_plan_key,
            a.expected_employees, a.submitted_at, a.decided_at, a.org_id, a.updated_at, u.email, u.emailVerified AS email_verified
     FROM applications a JOIN "user" u ON u.id = a.user_id
     ${where} ORDER BY COALESCE(a.submitted_at, a.updated_at) DESC LIMIT 200`,
  );
  const { results } = await (status && valid.includes(status) ? stmt.bind(status) : stmt).all();
  const counts = await db.prepare('SELECT review_status, COUNT(*) AS n FROM applications GROUP BY review_status').all();
  return {
    applications: results,
    counts: Object.fromEntries((counts.results as { review_status: string; n: number }[]).map(r => [r.review_status, r.n])),
  };
}

export async function getApplication(db: D1Database, id: string) {
  const row = await db.prepare('SELECT * FROM applications WHERE id = ?').bind(id).first<Row>();
  if (!row) throw new OrgError(404, 'not_found', 'Application not found.');
  const user = await db.prepare('SELECT id, name, email, emailVerified, createdAt FROM "user" WHERE id = ?').bind(row.user_id).first();
  const { results: events } = await db.prepare(
    'SELECT at, actor_kind, action, message, visible_to_applicant FROM application_events WHERE application_id = ? ORDER BY at',
  ).bind(id).all();
  return {
    application: { ...toClient(row), status: await displayStatus(db, row), approvedPlanVersionId: row.approved_plan_version_id ?? null, provisioningError: row.provisioning_error ?? null, billingExceptionReason: row.billing_exception_reason ?? null },
    applicant: user,
    events,
  };
}

async function requireApp(db: D1Database, id: string): Promise<Row> {
  const row = await db.prepare('SELECT * FROM applications WHERE id = ?').bind(id).first<Row>();
  if (!row) throw new OrgError(404, 'not_found', 'Application not found.');
  return row;
}

async function applicantEmail(db: D1Database, userId: string): Promise<string | null> {
  return (await db.prepare('SELECT email FROM "user" WHERE id = ?').bind(userId).first<{ email: string }>())?.email ?? null;
}

const message = (v: unknown, field: string): string => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < 3 || s.length > 1000) throw new OrgError(400, 'invalid', `${field} must be 3–1000 characters.`);
  return s;
};

export async function requestInformation(db: D1Database, id: string, body: Record<string, unknown>, actor: Actor) {
  const text = message(body.message, 'The question');
  const row = await requireApp(db, id);
  if (row.review_status !== 'pending_review') throw new OrgError(409, 'not_pending', 'Only an application under review can be sent back for information.');
  const email = await applicantEmail(db, row.user_id);
  const round = await db.prepare(
    "SELECT COUNT(*) AS n FROM application_events WHERE application_id = ? AND action = 'information_requested'",
  ).bind(id).first<{ n: number }>();
  const statements = [
    db.prepare("UPDATE applications SET review_status = 'needs_information', provider_message = ?, updated_at = ? WHERE id = ? AND review_status = 'pending_review'")
      .bind(text, Date.now(), id),
    event(db, id, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'information_requested', message: text }),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'application.request_info', targetType: 'application', targetId: id, details: { message: text }, ip: actor.ip }),
  ];
  if (email) statements.push(outboxStmt(db, { dedupeKey: `application:${id}:info:${(round?.n ?? 0) + 1}`, kind: 'application_needs_information', recipient: email, subject: 'We need a little more information', body: text }));
  await db.batch(statements);
  return getApplication(db, id);
}

export async function rejectApplication(db: D1Database, id: string, body: Record<string, unknown>, actor: Actor) {
  const reason = message(body.reason, 'The reason');
  const row = await requireApp(db, id);
  if (!['pending_review', 'needs_information'].includes(row.review_status)) {
    throw new OrgError(409, 'not_pending', 'Only an open application can be rejected.');
  }
  const email = await applicantEmail(db, row.user_id);
  const statements = [
    db.prepare("UPDATE applications SET review_status = 'rejected', provider_message = ?, decided_at = ?, decided_by = ?, updated_at = ? WHERE id = ?")
      .bind(reason, Date.now(), actor.userId, Date.now(), id),
    event(db, id, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'rejected', message: reason }),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'application.reject', targetType: 'application', targetId: id, details: { reason }, ip: actor.ip }),
  ];
  if (email) statements.push(outboxStmt(db, { dedupeKey: `application:${id}:rejected`, kind: 'application_rejected', recipient: email, subject: 'About your application', body: reason }));
  await db.batch(statements);
  return getApplication(db, id);
}

export async function changeRequestedPlan(db: D1Database, id: string, body: Record<string, unknown>, actor: Actor) {
  const planKey = typeof body.planKey === 'string' ? body.planKey.trim() : '';
  const reason = message(body.reason, 'The reason');
  const row = await requireApp(db, id);
  if (!OPEN.includes(row.review_status)) throw new OrgError(409, 'not_pending', 'The plan can only be changed before a decision.');
  const plan = await db.prepare(
    "SELECT 1 FROM plans p JOIN plan_versions v ON v.plan_id = p.id AND v.status = 'published' WHERE p.key = ?",
  ).bind(planKey).first();
  if (!plan) throw new OrgError(400, 'invalid_plan', 'That plan has no published version.');
  await db.batch([
    db.prepare('UPDATE applications SET requested_plan_key = ?, updated_at = ? WHERE id = ?').bind(planKey, Date.now(), id),
    event(db, id, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'plan_changed', message: `Plan changed from ${row.requested_plan_key} to ${planKey}: ${reason}` }),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'application.change_plan', targetType: 'application', targetId: id, details: { from: row.requested_plan_key, to: planKey, reason }, ip: actor.ip }),
  ]);
  return getApplication(db, id);
}

/**
 * Approves and provisions. Safe to call again: after a failure it resumes
 * from where it stopped; after success it changes nothing.
 */
export async function approveApplication(env: Env, db: D1Database, id: string, body: Record<string, unknown>, actor: Actor) {
  let row = await requireApp(db, id);
  if (row.review_status === 'approved' && row.provisioning_status === 'provisioned') return getApplication(db, id);
  if (!['pending_review', 'needs_information', 'approved'].includes(row.review_status)) {
    throw new OrgError(409, 'not_pending', `An application that is ${row.review_status} cannot be approved.`);
  }

  const waive = body.waivePayment === true;
  const exception = waive ? message(body.reason, 'The billing exception reason') : null;

  // Which plan version: the one chosen now, else the latest published
  // version of the plan the applicant asked for.
  let versionId = typeof body.planVersionId === 'string' ? body.planVersionId : (row.approved_plan_version_id as string | null);
  if (!versionId) {
    const latest = await db.prepare(
      `SELECT v.id FROM plan_versions v JOIN plans p ON p.id = v.plan_id
       WHERE p.key = ? AND v.status = 'published' ORDER BY v.version DESC LIMIT 1`,
    ).bind(row.requested_plan_key).first<{ id: string }>();
    versionId = latest?.id ?? null;
  }
  if (!versionId) throw new OrgError(400, 'invalid_plan', 'Choose a published plan version to approve with.');

  // Claim it. Only one approval can move it out of review.
  if (row.review_status !== 'approved') {
    const now = Date.now();
    const [claim] = await db.batch([
      db.prepare(
        `UPDATE applications SET review_status = 'approved', provisioning_status = 'provisioning',
           approved_plan_version_id = ?, billing_exception_reason = ?, decided_at = ?, decided_by = ?, updated_at = ?
         WHERE id = ? AND review_status IN ('pending_review','needs_information')`,
      ).bind(versionId, exception, now, actor.userId, now, id),
    ]);
    if ((claim?.meta?.changes ?? 0) === 1) {
      await db.batch([
        event(db, id, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'approved', message: exception ? `Approved with a billing exception: ${exception}` : 'Approved.' }),
        auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'application.approve', targetType: 'application', targetId: id, details: { planVersionId: versionId, billingException: exception }, ip: actor.ip }),
      ]);
    }
    row = await requireApp(db, id);
  }

  // Provision. The organization id is the application id, so a retry finds
  // the same organization instead of making another.
  const orgId = id;
  const baseSlug = slugify(String(row.business_name || 'organization'));
  const taken = await db.prepare('SELECT id FROM organizations WHERE slug = ? AND id <> ?').bind(baseSlug, orgId).first();
  const slug = taken ? `${baseSlug}-${id.slice(0, 6)}` : baseSlug;
  const now = Date.now();
  try {
    await db.batch([
      db.prepare("UPDATE applications SET provisioning_status = 'provisioning', provisioning_error = NULL WHERE id = ?").bind(id),
      db.prepare(
        `INSERT OR IGNORE INTO organizations (id, slug, name, business_type, status, country, timezone, is_demo, created_at, created_by, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, 0, ?, ?, ?)`,
      ).bind(orgId, slug, row.business_name, row.business_type || 'other', row.country || null, row.timezone || null, now, actor.userId, now),
      db.prepare(
        `INSERT OR IGNORE INTO memberships (id, org_id, user_id, role, status, created_at, created_by, updated_at)
         VALUES (?, ?, ?, 'owner', 'active', ?, ?, ?)`,
      ).bind(crypto.randomUUID(), orgId, row.user_id, now, actor.userId, now),
    ]);

    // The subscription follows the plan: free is active, a trial starts now,
    // paid waits for payment unless an exception was recorded.
    const existing = await db.prepare('SELECT 1 FROM subscriptions WHERE org_id = ?').bind(orgId).first();
    if (!existing) {
      await setSubscription(db, orgId, { planVersionId: versionId, waivePayment: waive, reason: exception ?? 'Assigned on approval' }, actor);
    }

    // Create the organization's own database now, so the first sign-in finds
    // it ready. Opening it applies the current schema.
    if (!env.ORG_STORE) throw new Error('Organization storage (ORG_STORE) is not configured.');
    const store = env.ORG_STORE.get(env.ORG_STORE.idFromName(orgId)) as DurableObjectStub<OrgStore>;
    await store.info();
  } catch (e) {
    const error = String((e as Error)?.message ?? e).slice(0, 300);
    await db.batch([
      db.prepare("UPDATE applications SET provisioning_status = 'failed', provisioning_error = ?, updated_at = ? WHERE id = ?").bind(error, Date.now(), id),
      event(db, id, { actorUserId: null, actorKind: 'system', action: 'provisioning_failed', message: error, visible: false }),
    ]);
    return getApplication(db, id);
  }

  const email = await applicantEmail(db, row.user_id);
  const statements = [
    db.prepare("UPDATE applications SET provisioning_status = 'provisioned', org_id = ?, provisioning_error = NULL, updated_at = ? WHERE id = ?").bind(orgId, Date.now(), id),
    event(db, id, { actorUserId: null, actorKind: 'system', action: 'workspace_ready', message: 'Your workspace is ready.' }),
  ];
  if (email) statements.push(outboxStmt(db, { dedupeKey: `application:${id}:ready`, kind: 'workspace_ready', recipient: email, subject: 'Your workspace is ready', body: `${row.business_name} is set up. Sign in to start.` }));
  await db.batch(statements);
  return getApplication(db, id);
}
