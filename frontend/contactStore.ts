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
import { contactLists, runSetupOnce } from './rows';
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
      const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      const existing = new Set(results.map(c => c.name));
      for (const [column, definition] of Object.entries(columns)) {
        if (existing.has(column)) continue;
        try {
          await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
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
    for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));
  });
}

/** Which contact holds each of these keys. */
export async function keyOwners(db: D1Database, keys: string[]): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  for (let i = 0; i < keys.length; i += MAX_IDS) {
    const chunk = keys.slice(i, i + MAX_IDS);
    const { results } = await db.prepare(`SELECT key, contact_id FROM contact_keys WHERE key IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk).all<{ key: string; contact_id: string }>();
    for (const r of results) owners.set(r.key, r.contact_id);
  }
  return owners;
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
  const phone = String(inq.customer_phone ?? '').trim();
  const email = String(inq.customer_email ?? '').trim();
  const name = String(inq.customer_name ?? '').trim();
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

  let contactId = owners[0];
  if (contactId === undefined) {
    // One id per number, so two inquiries racing in create the same row.
    const wanted = `ct_${keys[0].replaceAll(/[^a-z0-9]/gi, '_')}`;
    const taken = await db.prepare('SELECT 1 FROM contacts WHERE id = ?').bind(wanted).first();
    contactId = taken ? `ct_${crypto.randomUUID()}` : wanted;
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO contacts (id, name, phone, email, phones, emails, notes, source,
        created_at, created_by, created_by_name, updated_at, last_interaction_at)
        VALUES (?, ?, ?, ?, ?, ?, '', 'inquiry', ?, ?, ?, ?, ?)`).bind(
        contactId, name, phoneKey(phone, country) ? phone : '', emailKey(email) ? email : '',
        JSON.stringify(phoneKey(phone, country) ? [phone] : []), JSON.stringify(emailKey(email) ? [email] : []),
        Date.now(), String(inq.created_by ?? ''), String(inq.created_by_name ?? ''), Date.now(), at),
      ...keys.map(key => db.prepare('INSERT OR IGNORE INTO contact_keys (key, contact_id) VALUES (?, ?)').bind(key, contactId)),
    ]);
    // Whoever holds the first key now is the contact (a racing request may have won).
    contactId = (await keyOwners(db, [keys[0]])).get(keys[0]) ?? contactId;
  }

  const row = await db.prepare('SELECT * FROM contacts WHERE id = ?').bind(contactId).first<Record<string, unknown>>();
  if (!row) return; // deleted meanwhile: the next pass links it again
  const lists = contactLists(row);
  const ownKey = phoneKey(phone, country);
  const phones = ownKey && !lists.phones.some(p => phoneKey(p, country) === ownKey) ? [...lists.phones, phone] : lists.phones;
  const emails = emailKey(email) && !lists.emails.some(e => emailKey(e) === emailKey(email)) ? [...lists.emails, email] : lists.emails;
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
    await linkInquiryContact(env, id).catch(e => console.error('Linking an inquiry to its contact failed:', e));
  }
}
