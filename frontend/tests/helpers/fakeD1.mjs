// A small in-memory stand-in for a D1 database, on Node's built-in SQLite,
// with the platform migrations applied. Enough of the D1 API for unit tests
// of platform modules (prepare/bind/first/all/run, batch). Not a substitute
// for the wrangler-based integration tests: it only checks our SQL and logic.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const migrations = fileURLToPath(new URL('../../platform/migrations', import.meta.url));

/** `before`: apply only the migrations whose file name sorts before it (e.g. '0010'), to test older databases. */
export function fakeD1({ migrate = true, before = null } = {}) {
    const sqlite = new DatabaseSync(':memory:');
    if (migrate) {
        for (const file of readdirSync(migrations).filter(f => f.endsWith('.sql') && (!before || f < before)).sort()) {
            sqlite.exec(readFileSync(join(migrations, file), 'utf8'));
        }
    }
    const statement = (sql, params = []) => ({
        sql,
        params,
        bind: (...values) => statement(sql, values.map(v => (v === undefined ? null : v))),
        async first(column) {
            const row = sqlite.prepare(sql).get(...params);
            if (!row) return null;
            return column ? row[column] : { ...row };
        },
        async all() {
            return { results: sqlite.prepare(sql).all(...params).map(r => ({ ...r })), success: true, meta: {} };
        },
        async run() {
            const info = sqlite.prepare(sql).run(...params);
            return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
        },
    });
    return {
        sqlite,
        prepare: (sql) => statement(sql),
        async batch(stmts) {
            sqlite.exec('BEGIN');
            try {
                const out = [];
                for (const s of stmts) out.push(await s.run());
                sqlite.exec('COMMIT');
                return out;
            } catch (e) {
                sqlite.exec('ROLLBACK');
                throw e;
            }
        },
        async exec(sql) { sqlite.exec(sql); return { count: 1 }; },
    };
}
