/**
 * Notification fan-out & delivery (Phase 8).
 *
 * Honesty rules baked in here:
 *  - every destination channel gets its OWN row, and dedupe is per channel,
 *    so the same event can never raise two notifications on one channel but
 *    still reaches dashboard + email when both are configured
 *  - delivery is explicit: a pending row is either SENT, FAILED (with the
 *    provider's reason, redacted/length-capped) or SKIPPED with a reason that
 *    says WHY it was not sent. Nothing is ever silently dropped.
 *  - WhatsApp delivery is always skipped with the honest reason: Meta
 *    template policy forbids free-form notification text to a number that has
 *    not messaged us first, and no notification template is approved. The
 *    destination setting still records the number for the dashboard.
 *  - in-app rows keep their delivery status; "read" is tracked by read_at so
 *    a read email never loses the fact that it was sent.
 */
import type { DB } from '../../db/index.ts';
import type { Config } from '../../core/config.ts';
import { newId } from '../../core/ids.ts';
import { nowIso } from '../../core/time.ts';
import { notFound } from '../../core/errors.ts';
import { getSetting } from '../settings/service.ts';
import type { EmailPort } from '../../adapters/types.ts';

export type NotificationChannel = 'in_app' | 'email' | 'whatsapp';
export type NotificationSeverity = 'info' | 'warning' | 'critical';
export type NotificationStatus = 'pending' | 'sent' | 'delivered' | 'failed' | 'skipped' | 'read';

export interface NotificationDestinations {
  dashboard: boolean;
  email: string;
  whatsapp: string;
}

export interface NotifyInput {
  kind: string;
  severity?: NotificationSeverity;
  title: string;
  body: string;
  /**
   * Event identity for idempotent fan-out (e.g. `report_ready:2026-01-05`).
   * The stored key is `${dedupeKey}:${channel}` so each channel dedupes
   * independently. Null = never deduplicated (avoid for recurring events).
   */
  dedupeKey?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  /** Override the configured destinations (used by targeted tests/delivery). */
  channels?: NotificationChannel[];
}

export interface NotifyResult {
  created: string[];
  skipped: string[];
}

/** Channels configured by the owner. Dashboard is the guaranteed fallback: a
 *  notification is never silently dropped when email/WhatsApp are unset. */
export function resolveDestinations(db: DB, cfg: Config): NotificationChannel[] {
  const d = getSetting<NotificationDestinations>(db, 'notification_destinations', cfg);
  const channels: NotificationChannel[] = [];
  if (d.dashboard) channels.push('in_app');
  if (d.email) channels.push('email');
  if (d.whatsapp) channels.push('whatsapp');
  if (channels.length === 0) channels.push('in_app');
  return channels;
}

/** Create one notification row per destination channel (idempotent per key). */
export function notify(db: DB, cfg: Config, input: NotifyInput): NotifyResult {
  const channels = input.channels ?? resolveDestinations(db, cfg);
  const created: string[] = [];
  const skipped: string[] = [];
  const at = nowIso();
  for (const channel of channels) {
    const dedupe = input.dedupeKey ? `${input.dedupeKey}:${channel}` : null;
    if (dedupe) {
      const existing = db.prepare('SELECT id FROM notifications WHERE dedupe_key = ?').get(dedupe);
      if (existing) {
        skipped.push(channel);
        continue;
      }
    }
    try {
      const id = newId('ntf');
      db.prepare(
        `INSERT INTO notifications (id, kind, severity, title, body, channel, status, status_source,
           entity_type, entity_id, dedupe_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 'none', ?, ?, ?, ?)`,
      ).run(
        id,
        input.kind,
        input.severity ?? 'info',
        input.title,
        input.body,
        channel,
        input.entityType ?? null,
        input.entityId ?? null,
        dedupe,
        at,
      );
      created.push(id);
    } catch {
      // Unique-index race with a concurrent writer: the other writer won.
      skipped.push(channel);
    }
  }
  return { created, skipped };
}

// ------------------------------------------------------------- delivery ----

export interface DeliveryResult {
  sent: number;
  failed: number;
  skipped: number;
}

const MAX_ERROR_DETAIL = 400;

function truncateError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > MAX_ERROR_DETAIL ? `${message.slice(0, MAX_ERROR_DETAIL)}…` : message;
}

/**
 * Attempt delivery of every pending email/whatsapp notification.
 *
 * `in_app` rows are never touched here — they are already visible on the
 * dashboard and are closed out by marking them read. Callers run this from a
 * background job; individual failures never throw (one bad address must not
 * stop the queue).
 */
export async function deliverPendingNotifications(
  db: DB,
  cfg: Config,
  opts: { email?: EmailPort | null },
): Promise<DeliveryResult> {
  const rows = db
    .prepare(
      `SELECT * FROM notifications WHERE status = 'pending' AND channel IN ('email','whatsapp')
        ORDER BY created_at, rowid LIMIT 50`,
    )
    .all() as unknown as NotificationRow[];
  const result: DeliveryResult = { sent: 0, failed: 0, skipped: 0 };

  for (const row of rows) {
    if (row.channel === 'whatsapp') {
      db.prepare(`UPDATE notifications SET status = 'skipped', status_source = 'none', error_detail = ? WHERE id = ?`).run(
        'WhatsApp delivery requires a Meta-approved template; no notification template is approved. Free-form text to a number that has not messaged us first is never permitted. In-app/email delivery used instead.',
        row.id,
      );
      result.skipped += 1;
      continue;
    }
    const dest = getSetting<NotificationDestinations>(db, 'notification_destinations', cfg).email;
    if (!dest) {
      db.prepare(`UPDATE notifications SET status = 'skipped', status_source = 'none', error_detail = ? WHERE id = ?`).run(
        'No notification email address is configured (notification_destinations.email).',
        row.id,
      );
      result.skipped += 1;
      continue;
    }
    if (!opts.email) {
      db.prepare(`UPDATE notifications SET status = 'skipped', status_source = 'none', error_detail = ? WHERE id = ?`).run(
        'SMTP is not configured (SMTP_HOST/SMTP_USER/SMTP_PASS); the notification stays visible on the dashboard.',
        row.id,
      );
      result.skipped += 1;
      continue;
    }
    try {
      const res = await opts.email.send({ to: dest, subject: row.title, text: row.body });
      db.prepare(`UPDATE notifications SET status = 'sent', status_source = 'none', provider_ref = ?, error_detail = NULL WHERE id = ?`).run(
        res.messageId,
        row.id,
      );
      result.sent += 1;
    } catch (err) {
      db.prepare(`UPDATE notifications SET status = 'failed', status_source = 'none', error_detail = ? WHERE id = ?`).run(
        truncateError(err),
        row.id,
      );
      result.failed += 1;
    }
  }
  return result;
}

// --------------------------------------------------------------- reads -----

interface NotificationRow {
  id: string;
  kind: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  channel: NotificationChannel;
  status: NotificationStatus;
  status_source: string;
  provider_ref: string | null;
  error_detail: string | null;
  entity_type: string | null;
  entity_id: string | null;
  dedupe_key: string | null;
  read_at: string | null;
  created_at: string;
}

export interface NotificationView {
  id: string;
  kind: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  channel: NotificationChannel;
  status: NotificationStatus;
  errorDetail: string | null;
  entityType: string | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
}

function toView(row: NotificationRow): NotificationView {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    body: row.body,
    channel: row.channel,
    status: row.status,
    errorDetail: row.error_detail,
    entityType: row.entity_type,
    entityId: row.entity_id,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export interface NotificationQuery {
  status?: NotificationStatus;
  channel?: NotificationChannel;
  unreadOnly?: boolean;
  limit?: number;
}

export function listNotifications(db: DB, q: NotificationQuery = {}): NotificationView[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.status) {
    where.push('status = ?');
    params.push(q.status);
  }
  if (q.channel) {
    where.push('channel = ?');
    params.push(q.channel);
  }
  if (q.unreadOnly) where.push('read_at IS NULL');
  const sql = `SELECT * FROM notifications ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC, rowid DESC LIMIT ?`;
  params.push(Math.min(Math.max(q.limit ?? 50, 1), 200));
  return (db.prepare(sql).all(...params) as unknown as NotificationRow[]).map(toView);
}

/** Unread count across every channel (dashboard badge). */
export function unreadCount(db: DB): number {
  const row = db.prepare('SELECT COUNT(*) c FROM notifications WHERE read_at IS NULL').get() as { c: number };
  return row.c;
}

/**
 * Mark one notification read. Delivery state is preserved: an email that was
 * sent keeps status `sent` (read_at carries the read), while in-app rows move
 * `pending` -> `read` to match the status vocabulary.
 */
export function markNotificationRead(db: DB, id: string): NotificationView {
  const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as unknown as
    | NotificationRow
    | undefined;
  if (!row) throw notFound('Notification');
  if (row.read_at) return toView(row);
  const at = nowIso();
  if (row.channel === 'in_app') {
    db.prepare(`UPDATE notifications SET status = 'read', read_at = ? WHERE id = ?`).run(at, id);
  } else {
    db.prepare(`UPDATE notifications SET read_at = ? WHERE id = ?`).run(at, id);
  }
  return toView(
    db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as unknown as NotificationRow,
  );
}

export function markAllNotificationsRead(db: DB): number {
  const res = db
    .prepare(`UPDATE notifications SET read_at = ?, status = CASE WHEN channel = 'in_app' THEN 'read' ELSE status END WHERE read_at IS NULL`)
    .run(nowIso());
  return Number(res.changes);
}
