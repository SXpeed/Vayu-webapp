// An organization's own app storage: its database, its files, its settings.
//
// The app's server code (worker.ts and the modules it uses) was written for
// one business: one D1 database (VAYU_DB), one KV namespace (VAYU_KV) and one
// R2 bucket (VAYU_R2). Rather than rewrite every handler, each organization
// gets objects with exactly those shapes:
//
//   VAYU_DB  → its own SQLite database, in a Durable Object named by the
//              organization id (OrgAppDb, orgAppDb.ts), reached through a D1-shaped
//              adapter. Physically separate: no query can reach another
//              organization's rows.
//   VAYU_KV  → the shared namespace, every key prefixed "org:<id>:".
//   VAYU_R2  → the shared bucket, every key prefixed "orgs/<id>/".
//
// Keys and object names are un-prefixed on the way out, so handlers see the
// same names as before. The organization that owns the original app's data
// (Vayu) uses the original bindings unchanged (frontend/orgApp.ts). The database itself is orgAppDb.ts.

import { DB_KEY } from './workerEnv';

// ── The database ──────────────────────────────────────────────────────────

export type Mode = 'all' | 'first' | 'run' | 'raw';

export interface Statement { sql: string; params: unknown[] }

export interface QueryResult {
  results: unknown[];
  columns: string[];
  meta: { changes: number; last_row_id: number; rows_read: number; rows_written: number; duration: number; changed_db: boolean; size_after: number };
}

/** What the Worker calls on an OrgAppDb (its RPC methods). */
interface OrgAppDbRpc {
  query(statement: Statement, mode: Mode): Promise<QueryResult>;
  batch(statements: Statement[]): Promise<QueryResult[]>;
}

/** A D1-shaped handle on one organization's database. */
export function orgDatabase(ns: DurableObjectNamespace, orgId: string): D1Database {
  const stub = () => ns.get(ns.idFromName(orgId)) as unknown as OrgAppDbRpc;
  const toD1 = (r: QueryResult) => ({ success: true, results: r.results, meta: r.meta });

  class Prepared {
    constructor(readonly sql: string, readonly params: unknown[] = []) {}
    bind(...params: unknown[]) { return new Prepared(this.sql, params); }
    statement(): Statement { return { sql: this.sql, params: this.params }; }
    async first(column?: string) {
      const r = await stub().query(this.statement(), 'first');
      const row = (r.results[0] ?? null) as Record<string, unknown> | null;
      if (!column) return row;
      return row ? (row[column] ?? null) : null;
    }
    async all() { return toD1(await stub().query(this.statement(), 'all')); }
    async run() { return toD1(await stub().query(this.statement(), 'run')); }
    async raw(options?: { columnNames?: boolean }) {
      const r = await stub().query(this.statement(), 'raw');
      return options?.columnNames ? [r.columns, ...r.results] : r.results;
    }
  }

  return {
    [DB_KEY]: `org:${orgId}`,
    prepare: (sql: string) => new Prepared(sql),
    batch: async (statements: Prepared[]) => (await stub().batch(statements.map(s => s.statement()))).map(toD1),
    exec: async (sql: string) => { await stub().query({ sql, params: [] }, 'run'); return { count: 1, duration: 0 }; },
    dump: () => { throw new Error('dump() is not available for organization databases'); },
    withSession: () => { throw new Error('withSession() is not available for organization databases'); },
  } as unknown as D1Database;
}

// ── Settings and files ────────────────────────────────────────────────────

/** The shared KV namespace seen through one organization's prefix. */
export function prefixedKv(kv: KVNamespace, prefix: string): KVNamespace {
  const strip = (name: string) => (name.startsWith(prefix) ? name.slice(prefix.length) : name);
  return {
    get: (key: string, options?: unknown) => kv.get(prefix + key, options as never),
    getWithMetadata: (key: string, options?: unknown) => kv.getWithMetadata(prefix + key, options as never),
    put: (key: string, value: never, options?: KVNamespacePutOptions) => kv.put(prefix + key, value, options),
    delete: (key: string) => kv.delete(prefix + key),
    list: async (options: KVNamespaceListOptions = {}) => {
      const page = await kv.list({ ...options, prefix: prefix + (options.prefix ?? '') });
      return { ...page, keys: page.keys.map(k => ({ ...k, name: strip(k.name) })) };
    },
  } as unknown as KVNamespace;
}

/** The shared R2 bucket seen through one organization's prefix. */
export function prefixedBucket(bucket: R2Bucket, prefix: string): R2Bucket {
  const strip = (key: string) => (key.startsWith(prefix) ? key.slice(prefix.length) : key);
  // A view of the object whose key has no prefix; everything else (body,
  // metadata, methods) is the original's.
  const fix = <T extends { key: string } | null>(obj: T): T => {
    if (!obj) return obj;
    return new Proxy(obj, {
      get(target, prop) {
        if (prop === 'key') return strip(target.key);
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return {
    head: async (key: string) => fix(await bucket.head(prefix + key)),
    get: async (key: string, options?: R2GetOptions) => fix(await bucket.get(prefix + key, options) as R2ObjectBody | null),
    put: async (key: string, value: never, options?: R2PutOptions) => fix(await bucket.put(prefix + key, value, options)),
    delete: (keys: string | string[]) => bucket.delete(Array.isArray(keys) ? keys.map(k => prefix + k) : prefix + keys),
    list: async (options: R2ListOptions = {}) => {
      const page = await bucket.list({ ...options, prefix: prefix + (options.prefix ?? '') });
      return { ...page, objects: page.objects.map(fix), delimitedPrefixes: page.delimitedPrefixes.map(strip) };
    },
  } as unknown as R2Bucket;
}

export const orgKvPrefix = (orgId: string) => `org:${orgId}:`;
export const orgFilePrefix = (orgId: string) => `orgs/${orgId}/`;
