/**
 * Append-only audit trail.
 *
 * Written for every sensitive action: authentication events, settings and
 * budget changes, approvals, live activation, emergency stop/resume, merges,
 * conversions, financial changes, exports/deletions.
 *
 * Async note: database access is async (SQLite + PostgreSQL share the
 * interface), so every function here returns a Promise and callers await.
 */
import type { DB } from '../../db/index.ts';
import { nowIso } from '../../core/time.ts';
import { newId } from '../../core/ids.ts';
import { redactString } from '../../core/logger.ts';

export type AuditActorLabel = 'owner' | 'staff' | 'system' | 'scheduler' | 'anonymous';

export interface AuditInput {
  actorUserId?: string | null;
  actorLabel: AuditActorLabel;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  summary: string;
  details?: Record<string, unknown> | null;
  ipHash?: string | null;
}

const INSERT = `
  INSERT INTO audit_events (occurred_at, actor_user_id, actor_label, action, entity_type, entity_id, summary, details_json, ip_hash)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export async function recordAudit(db: DB, input: AuditInput): Promise<number> {
  const details = input.details ? JSON.stringify(input.details) : null;
  // PostgreSQL has no lastInsertRowid: ask the server for the generated id.
  const sql = db.dialect === 'postgres' ? `${INSERT.trim()} RETURNING id` : INSERT;
  const res = await db
    .prepare(sql)
    .run(
      nowIso(),
      input.actorUserId ?? null,
      input.actorLabel,
      input.action,
      input.entityType ?? null,
      input.entityId ?? null,
      // summaries are redacted so PII never lands in the audit trail in clear text
      redactString(input.summary),
      details === null ? null : redactString(details),
      input.ipHash ?? null,
    );
  return Number(res.lastInsertRowid);
}

export interface AuditRow {
  id: number;
  occurred_at: string;
  actor_user_id: string | null;
  actor_label: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  summary: string;
  details_json: string | null;
  ip_hash: string | null;
}

export interface AuditQuery {
  action?: string;
  entityType?: string;
  entityId?: string;
  limit?: number;
  offset?: number;
}

export async function listAudit(
  db: DB,
  q: AuditQuery = {},
): Promise<{ rows: AuditRow[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.action) {
    where.push('action = ?');
    params.push(q.action);
  }
  if (q.entityType) {
    where.push('entity_type = ?');
    params.push(q.entityType);
  }
  if (q.entityId) {
    where.push('entity_id = ?');
    params.push(q.entityId);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    (await db.prepare(`SELECT COUNT(*) AS c FROM audit_events ${clause}`).get(...(params as never[]))) as {
      c: number;
    }
  ).c;
  const rows = (await db
    .prepare(
      `SELECT * FROM audit_events ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
    .all(...([...params, q.limit ?? 50, q.offset ?? 0] as never[]))) as unknown as AuditRow[];
  return { rows, total };
}

/** Convenience for entity-scoped history views. */
export async function entityHistory(
  db: DB,
  entityType: string,
  entityId: string,
  limit = 50,
): Promise<AuditRow[]> {
  const list = await listAudit(db, { entityType, entityId, limit });
  return list.rows;
}

export function newAuditId(): string {
  return newId('aud');
}
