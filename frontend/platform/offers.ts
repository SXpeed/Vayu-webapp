// Limited-time offers: a percentage off a plan's price for a while, set in
// the control centre (Plans → a plan → Limited-time offer).
//
// An offer lowers what is charged in the app's checkout (billing.ts) and is
// shown on the pricing page and in the app's plan chooser. It never changes a
// plan version, so organizations' contracts stay as they are. By default it is
// for organizations choosing the plan; renewals of the same plan get it only
// when the offer says so.

import { auditStmt } from './audit';
import { OrgError, type Actor } from './orgs';

export interface Offer {
  percentOff: number;
  label: string;
  startsAt: number;
  endsAt: number;
  includeRenewals: boolean;
}

interface OfferRow {
  plan_id: string;
  percent_off: number;
  label: string;
  starts_at: number;
  ends_at: number;
  include_renewals: number;
}

const MAX_OFFER_MS = 366 * 86_400_000;

const toOffer = (r: OfferRow): Offer => ({
  percentOff: r.percent_off, label: r.label, startsAt: r.starts_at, endsAt: r.ends_at, includeRenewals: r.include_renewals === 1,
});

/** A plan's offer, running or not (the control centre shows both). */
export async function getOffer(db: D1Database, planId: string): Promise<Offer | null> {
  const r = await db.prepare('SELECT * FROM plan_offers WHERE plan_id = ?').bind(planId).first<OfferRow>();
  return r ? toOffer(r) : null;
}

/** Offers running right now, by plan id. */
export async function runningOffers(db: D1Database, now = Date.now()): Promise<Map<string, Offer>> {
  const { results } = await db.prepare('SELECT * FROM plan_offers WHERE starts_at <= ? AND ends_at > ?').bind(now, now).all<OfferRow>();
  return new Map(results.map(r => [r.plan_id, toOffer(r)]));
}

/** The price after an offer, rounded to whole rupees so prices stay tidy. */
export function discounted(amount: number, percentOff: number): number {
  return Math.max(100, Math.round((amount * (100 - percentOff)) / 100 / 100) * 100);
}

export async function setOffer(db: D1Database, planId: string, body: Record<string, unknown>, actor: Actor): Promise<Offer> {
  const plan = await db.prepare('SELECT id FROM plans WHERE id = ?').bind(planId).first();
  if (!plan) throw new OrgError(404, 'plan_not_found', 'Plan not found.');
  const percentOff = Number(body.percentOff);
  if (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 90) {
    throw new OrgError(400, 'invalid', 'The discount must be a whole percentage from 1 to 90.');
  }
  const label = typeof body.label === 'string' ? body.label.trim().slice(0, 60) : '';
  const now = Date.now();
  const startsAt = body.startsAt === undefined || body.startsAt === null ? now : Number(body.startsAt);
  const endsAt = Number(body.endsAt);
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) throw new OrgError(400, 'invalid', 'Choose when the offer starts and ends.');
  if (endsAt <= Math.max(startsAt, now)) throw new OrgError(400, 'invalid', 'The offer must end in the future, after it starts.');
  if (endsAt - startsAt > MAX_OFFER_MS) throw new OrgError(400, 'invalid', 'An offer can run for at most a year.');
  const offer: Offer = { percentOff, label, startsAt: Math.floor(startsAt), endsAt: Math.floor(endsAt), includeRenewals: body.includeRenewals === true };
  await db.batch([
    db.prepare(
      `INSERT INTO plan_offers (plan_id, percent_off, label, starts_at, ends_at, include_renewals, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(plan_id) DO UPDATE SET percent_off = excluded.percent_off, label = excluded.label, starts_at = excluded.starts_at,
         ends_at = excluded.ends_at, include_renewals = excluded.include_renewals, created_at = excluded.created_at, created_by = excluded.created_by`,
    ).bind(planId, offer.percentOff, offer.label, offer.startsAt, offer.endsAt, offer.includeRenewals ? 1 : 0, now, actor.userId),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'plan.offer.set', targetType: 'plan', targetId: planId, details: offer, ip: actor.ip }),
  ]);
  return offer;
}

export async function removeOffer(db: D1Database, planId: string, actor: Actor): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM plan_offers WHERE plan_id = ?').bind(planId),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'plan.offer.remove', targetType: 'plan', targetId: planId, ip: actor.ip }),
  ]);
}
