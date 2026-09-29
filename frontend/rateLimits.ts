// Which app routes cost real money or real work (Razorpay calls, email,
// storage writes, bulk imports) and so get their own limits, on top of the
// per-device flood limit every route has. docs/PAYMENT_SECURITY.md, issue 2.
//
// Limits use Cloudflare's Workers Rate Limiting binding: shared by every
// isolate in a Cloudflare location, eventually consistent, and per location,
// not global. They stop floods and runaway scripts; they are not an exact
// quota. There are no server-side exports or searches to limit (CSV and PDF
// exports, and searches, run in the browser).

export type CostlyGroup = 'payment_link' | 'payment_check' | 'billing' | 'upload' | 'import' | 'invite' | 'room';

interface CostlyRoute { method: string; match: (path: string) => boolean; group: CostlyGroup }

const exact = (p: string) => (path: string) => path === p;

const COSTLY: CostlyRoute[] = [
  { method: 'POST', match: exact('/payments/link'), group: 'payment_link' },
  { method: 'POST', match: exact('/payments/links/refresh'), group: 'payment_check' },
  { method: 'POST', match: p => /^\/payments\/links\/plink_\w{6,40}\/recheck$/.test(p), group: 'payment_check' },
  { method: 'GET', match: p => /^\/payments\/links\/plink_\w{6,40}\/details$/.test(p), group: 'payment_check' },
  { method: 'PATCH', match: p => /^\/payments\/links\/plink_\w{6,40}$/.test(p), group: 'payment_check' },
  { method: 'DELETE', match: p => /^\/payments\/links\/plink_\w{6,40}$/.test(p), group: 'payment_check' },
  { method: 'POST', match: p => p === '/billing/checkout' || p === '/billing/confirm' || /^\/billing\/payments\/[\w-]{1,64}\/recheck$/.test(p), group: 'billing' },
  { method: 'POST', match: p => p === '/upload' || p === '/files-thumbs', group: 'upload' },
  { method: 'POST', match: exact('/contacts/import'), group: 'import' },
  { method: 'POST', match: p => p === '/team/invitations' || p === '/auth/users', group: 'invite' },
  { method: 'POST', match: exact('/viewing-rooms'), group: 'room' },
];

/** The costly group a request belongs to, or null for ordinary routes. */
export function costlyGroup(method: string, path: string): CostlyGroup | null {
  return COSTLY.find(r => r.method === method && r.match(path))?.group ?? null;
}

/** Rate-limit keys for one request: per person, and per workspace ('original' for the app before organizations). */
export function limitKeys(group: CostlyGroup, userId: string, orgId: string | undefined): { user: string; org: string } {
  return { user: `${group}:u:${userId.slice(0, 64)}`, org: `${group}:o:${(orgId ?? 'original').slice(0, 64)}` };
}
