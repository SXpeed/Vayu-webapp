// Saved contacts: their phone/email keys, tags, and the link from each
// inquiry to its contact. The HTTP handlers live in worker.ts with the other
// contact routes; this is the storage underneath them.
//
// contact_keys holds one row per phone or email (contactKeys.ts) with a
// PRIMARY KEY on the key, so one number can never belong to two contacts, even
// when two inquiries from the same person arrive at the same moment: the
// second insert fails or is ignored inside its batch, and the batch is one
// transaction.

import { contactKeys, DEFAULT_COUNTRY, emailKey, phoneKey } from './contactKeys';
import { changeLogStmt, ensureChangeLogTable, notifyHub } from './deltaSync';
import { contactLists, runSetupOnce, text } from './rows';
import type { Env } from './workerEnv';

/** IN lists stay under D1's 100 bound parameters. */
const MAX_IDS = 90;

const NEW_COLUMNS: Record<string, Record<string, string>> = {
  contacts: {
    phones: "TEXT NOT NULL DEFAULT '[]'",
    emails: "TEXT NOT NULL DEFAULT '[]'",
    tags: "TEXT NOT NULL DEFAULT '[]'",
    updated_at: 'INTEGER NOT NULL DEFAULT 0',
    last_interaction_at: 'INTEGER NOT NULL DEFAULT 0',
  },
  // NULL: not looked at yet (linkPendingInquiries picks it up); '': no contact.
  inquiries: { contact_id: 'TEXT', contact_matches: "TEXT NOT NULL DEFAULT '[]'" },
};

/**
 * Contacts table and its new columns, keys and tags, once per database. Keys
 * for contacts saved before keys existed are filled in here; duplicates among
 * those keep the first contact's claim (INSERT OR IGNORE).
 */
const countries = new Map<string, string>();

/**
 * The organisation's country (given when it applied), for numbers typed
 * without a country code. Remembered per isolate: a changed country takes
 * effect as isolates recycle.
 */
export async function orgCountry(env: Env): Promise<string> {
  if (!env.ORG_ID || !env.PLATFORM_DB) return DEFAULT_COUNTRY;
  let country = countries.get(env.ORG_ID);
  if (country === undefined) {
    const row = await env.PLATFORM_DB.prepare('SELECT country FROM organizations WHERE id = ?').bind(env.ORG_ID).first<{ country: string | null }>();
    country = row?.country || DEFAULT_COUNTRY;
    countries.set(env.ORG_ID, country);
  }
  return country;
}

export function ensureContactSchema(env: Env): Promise<void> {
  const db = env.VAYU_DB;
  return runSetupOnce(db, 'contactSchema', async () => {
    const country = await orgCountry(env);
    await db.prepare(`CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual',
      created_at INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_by_name TEXT)`).run();
    for (const [table, columns] of Object.entries(NEW_COLUMNS)) {
      const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>(); // NOSONAR: schema steps run one at a time
      const existing = new Set(results.map(c => c.name));
      for (const [column, definition] of Object.entries(columns)) {
        if (existing.has(column)) continue;
        try {
          await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run(); // NOSONAR: schema steps run one at a time
        } catch (e) {
          if (!/duplicate column/i.test((e as Error).message)) throw e; // another isolate added it
        }
      }
    }
    await db.batch([
      db.prepare('CREATE TABLE IF NOT EXISTS contact_keys (key TEXT PRIMARY KEY, contact_id TEXT NOT NULL)'),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_contact_keys_contact ON contact_keys(contact_id)'),
      db.prepare(`CREATE TABLE IF NOT EXISTS contact_tags (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_inquiries_contact ON inquiries(contact_id)'),
    ]);
    const { results } = await db.prepare('SELECT * FROM contacts').all<Record<string, unknown>>();
    const stmts = results.flatMap(row => {
      const { phones, emails } = contactLists(row);
      return [
        db.prepare("UPDATE contacts SET phones = ?, emails = ? WHERE id = ? AND phones = '[]' AND emails = '[]'")
          .bind(JSON.stringify(phones), JSON.stringify(emails), row.id),
        ...contactKeys(phones, emails, country).map(key =>
          db.prepare('INSERT OR IGNORE INTO contact_keys (key, contact_id) VALUES (?, ?)').bind(key, row.id)),
      ];
    });
    for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200)); // NOSONAR: one write batch at a time keeps the load bounded
  });
}

/** Which contact holds each of these keys. */
export async function keyOwners(db: D1Database, keys: string[]): Promise<Map<string, string>> {
  const chunks = Array.from({ length: Math.ceil(keys.length / MAX_IDS) }, (_, i) => keys.slice(i * MAX_IDS, (i + 1) * MAX_IDS));
  const pages = await Promise.all(chunks.map(chunk =>
    db.prepare(`SELECT key, contact_id FROM contact_keys WHERE key IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk).all<{ key: string; contact_id: string }>()));
  return new Map(pages.flatMap(p => p.results.map(r => [r.key, r.contact_id] as const)));
}

/**
 * A contact's keys replaced with these. Plain INSERTs: a key that belongs to
 * another contact fails the whole batch (the caller answers 409).
 */
export function replaceKeyStmts(db: D1Database, contactId: string, keys: string[]): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM contact_keys WHERE contact_id = ?').bind(contactId),
    ...keys.map(key => db.prepare('INSERT INTO contact_keys (key, contact_id) VALUES (?, ?)').bind(key, contactId)),
  ];
}

export const isUniqueViolation = (e: unknown): boolean => /UNIQUE constraint failed/i.test((e as Error)?.message ?? '');

/**
 * Finds or creates the contact for an inquiry and links the two.
 *  - No phone or email: no contact (never a made-up one).
 *  - Its phone and email belong to two different contacts: not linked;
 *    both are listed on the inquiry (contact_matches) for someone to choose.
 *  - One contact: linked; a phone or email it lacked is added, nothing it
 *    has is changed (a blank name is filled in).
 *  - None: a new contact with what the inquiry gave.
 * Running it twice changes nothing more.
 */
export async function linkInquiryContact(env: Env, inquiryId: string): Promise<void> {
  const db = env.VAYU_DB;
  await ensureContactSchema(env);
  await ensureChangeLogTable(db);
  const country = await orgCountry(env);
  const inq = await db.prepare('SELECT * FROM inquiries WHERE id = ?').bind(inquiryId).first<Record<string, unknown>>();
  if (!inq) return;
  const phone = text(inq.customer_phone).trim();
  const email = text(inq.customer_email).trim();
  const name = text(inq.customer_name).trim();
  const at = Number(inq.date) || Date.now();
  const keys = contactKeys([phone], [email], country);
  const setInquiry = (contactId: string, matches: string[] = []) => [
    db.prepare('UPDATE inquiries SET contact_id = ?, contact_matches = ? WHERE id = ?').bind(contactId, JSON.stringify(matches), inquiryId),
    changeLogStmt(db, env, 'inquiry', inquiryId, 'put', { actorId: 'contacts' }),
  ];
  if (keys.length === 0) {
    await db.batch(setInquiry(''));
    return;
  }

  const owners = [...new Set((await keyOwners(db, keys)).values())];
  if (owners.length > 1) {
    await db.batch(setInquiry('', owners));
    await notifyHub(env, [{ entity: 'inquiry', id: inquiryId, op: 'put' }]);
    return;
  }

  const contactId = owners[0] ?? await createInquiryContact(db, inq, keys, { phone, email, name, at, country });

  const row = await db.prepare('SELECT * FROM contacts WHERE id = ?').bind(contactId).first<Record<string, unknown>>();
  if (!row) return; // deleted meanwhile: the next pass links it again
  const lists = contactLists(row);
  const ownKey = phoneKey(phone, country);
  const phones = withNew(lists.phones, phone, ownKey, p => phoneKey(p, country));
  const emails = withNew(lists.emails, email, emailKey(email), emailKey);
  await db.batch([
    db.prepare(`UPDATE contacts SET phones = ?, emails = ?, phone = ?, email = ?,
      name = CASE WHEN name = '' THEN ? ELSE name END,
      last_interaction_at = MAX(last_interaction_at, ?) WHERE id = ?`)
      .bind(JSON.stringify(phones), JSON.stringify(emails), phones[0] ?? '', emails[0] ?? '', name, at, contactId),
    ...keys.map(key => db.prepare('INSERT OR IGNORE INTO contact_keys (key, contact_id) VALUES (?, ?)').bind(key, contactId)),
    changeLogStmt(db, env, 'contact', contactId, 'put', { actorId: 'contacts' }),
    ...setInquiry(contactId),
  ]);
  await notifyHub(env, [{ entity: 'contact', id: contactId, op: 'put' }, { entity: 'inquiry', id: inquiryId, op: 'put' }]);
}

/** The list with this value added, unless it's not valid (no key) or already there. */
function withNew(list: string[], value: string, key: string | null, keyOf: (v: string) => string | null): string[] {
  return key && !list.some(v => keyOf(v) === key) ? [...list, value] : list;
}

/** A new contact from an inquiry; gives back the id that holds its first key (a racing request may have won). */
async function createInquiryContact(
  db: D1Database, inq: Record<string, unknown>, keys: string[],
  { phone, email, name, at, country }: { phone: string; email: string; name: string; at: number; country: string },
): Promise<string> {
  // One id per number, so two inquiries racing in create the same row.
  const wanted = `ct_${keys[0].replaceAll(/[^a-z0-9]/gi, '_')}`;
  const taken = await db.prepare('SELECT 1 FROM contacts WHERE id = ?').bind(wanted).first();
  const contactId = taken ? `ct_${crypto.randomUUID()}` : wanted;
  const hasPhone = !!phoneKey(phone, country);
  const hasEmail = !!emailKey(email);
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO contacts (id, name, phone, email, phones, emails, notes, source,
      created_at, created_by, created_by_name, updated_at, last_interaction_at)
      VALUES (?, ?, ?, ?, ?, ?, '', 'inquiry', ?, ?, ?, ?, ?)`).bind(
      contactId, name, hasPhone ? phone : '', hasEmail ? email : '',
      JSON.stringify(hasPhone ? [phone] : []), JSON.stringify(hasEmail ? [email] : []),
      Date.now(), text(inq.created_by), text(inq.created_by_name), Date.now(), at),
    ...keys.map(key => db.prepare('INSERT OR IGNORE INTO contact_keys (key, contact_id) VALUES (?, ?)').bind(key, contactId)),
  ]);
  return (await keyOwners(db, [keys[0]])).get(keys[0]) ?? contactId;
}

const lastPass = new Map<string, number>();

/**
 * Links inquiries not linked yet: ones from before contacts were saved, and
 * any whose link failed. A batch at a time, at most once a minute per
 * organisation per isolate.
 */
export async function linkPendingInquiries(env: Env): Promise<void> {
  const scope = env.ORG_ID ?? 'default';
  if (Date.now() - (lastPass.get(scope) ?? 0) < 60_000) return;
  lastPass.set(scope, Date.now());
  await ensureContactSchema(env);
  const { results } = await env.VAYU_DB.prepare('SELECT id FROM inquiries WHERE contact_id IS NULL ORDER BY date LIMIT 100').all<{ id: string }>();
  for (const { id } of results) {
    // One at a time, so two inquiries from one person can't both create a contact.
    await linkInquiryContact(env, id).catch(e => console.error('Linking an inquiry to its contact failed:', e)); // NOSONAR
  }
}
