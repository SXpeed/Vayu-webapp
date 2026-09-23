// One organization's app database: a Durable Object with its own SQLite
// database holding the original app's tables (schema.sql). The Worker reaches
// it through the D1-shaped adapter in orgStorage.ts.

import { DurableObject } from 'cloudflare:workers';
import APP_SCHEMA from './schema.sql';
import type { Mode, QueryResult, Statement } from './orgStorage';
import type { Env } from './workerEnv';

type Bindable = string | number | null | ArrayBuffer;

/** D1 accepts booleans and treats undefined as an error; SQLite storage wants plain values. */
function bindable(value: unknown): Bindable {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  if (typeof value === 'number' || typeof value === 'string') return value;
  return String(value);
}

/** One organization's app database. Holds the same tables as the original app (schema.sql). */
export class OrgAppDb extends DurableObject<Env> {
  private ready = false;

  private prepareSchema(): void {
    if (this.ready) return;
    // Every statement in schema.sql is "IF NOT EXISTS": safe on every start.
    this.ctx.storage.sql.exec(APP_SCHEMA);
    this.ready = true;
  }

  private runOne(statement: Statement, mode: Mode): QueryResult {
    const sql = this.ctx.storage.sql;
    const cursor = sql.exec(statement.sql, ...statement.params.map(bindable));
    let results: unknown[];
    if (mode === 'raw') results = [...cursor.raw()];
    else results = cursor.toArray();
    const written = cursor.rowsWritten;
    // changes() and last_insert_rowid() describe the last write, so only ask
    // after one: a read reports no changes, as D1 does.
    const last = written > 0 ? sql.exec<{ c: number; id: number }>('SELECT changes() AS c, last_insert_rowid() AS id').one() : { c: 0, id: 0 };
    return {
      results,
      columns: cursor.columnNames,
      meta: {
        changes: last.c, last_row_id: last.id, rows_read: cursor.rowsRead, rows_written: written,
        duration: 0, changed_db: written > 0, size_after: sql.databaseSize,
      },
    };
  }

  query(statement: Statement, mode: Mode): QueryResult {
    this.prepareSchema();
    return this.runOne(statement, mode);
  }

  /** All or nothing, like D1's batch. */
  batch(statements: Statement[]): QueryResult[] {
    this.prepareSchema();
    return this.ctx.storage.transactionSync(() => statements.map(s => this.runOne(s, 'all')));
  }

  /** Size and schema check, for the control centre and tests. */
  info(): { sizeBytes: number; tables: number } {
    this.prepareSchema();
    const row = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").one();
    return { sizeBytes: this.ctx.storage.sql.databaseSize, tables: row.n };
  }
}
