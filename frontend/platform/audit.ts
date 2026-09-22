// Platform audit trail writer. The table is append-only (see migration 0001).

export function auditStmt(db: D1Database, entry: {
  actorUserId: string | null; actorKind: 'provider_admin' | 'user' | 'system';
  action: string; targetType?: string; targetId?: string; orgId?: string;
  details?: unknown; ip?: string | null;
}): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO platform_audit (id, at, actor_user_id, actor_kind, action, target_type, target_id, org_id, details, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), Date.now(), entry.actorUserId, entry.actorKind, entry.action,
    entry.targetType ?? null, entry.targetId ?? null, entry.orgId ?? null,
    entry.details === undefined ? null : JSON.stringify(entry.details), entry.ip ?? null,
  );
}
