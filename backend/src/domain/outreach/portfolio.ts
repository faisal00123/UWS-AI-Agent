/**
 * Portfolio items (Section 1.7 / Phase 6).
 *
 * The portfolio is the only material the agent may share with a prospect, and
 * the schema enforces a two-key rule before anything is shareable:
 *
 *   verified  = the owner confirmed the case study / link is real
 *   approved  = the owner wants it used in outreach
 *
 * Only rows with BOTH flags may ever be quoted or sent. A draft, unverified or
 * un-approved item is refused with a clear error naming each offender — the
 * system never silently drops an item the operator explicitly selected.
 */
import type { DB } from '../../db/index.ts';
import { newId } from '../../core/ids.ts';
import { nowIso } from '../../core/time.ts';
import { AppError, notFound } from '../../core/errors.ts';

export interface PortfolioItem {
  id: string;
  title: string;
  description: string;
  serviceKey: string | null;
  url: string | null;
  imageUrl: string | null;
  verified: boolean;
  verificationNote: string | null;
  isApproved: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  title: string;
  description: string;
  service_key: string | null;
  url: string | null;
  image_url: string | null;
  verified: number;
  verification_note: string | null;
  is_approved: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

function toItem(r: Row): PortfolioItem {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    serviceKey: r.service_key,
    url: r.url,
    imageUrl: r.image_url,
    verified: r.verified === 1,
    verificationNote: r.verification_note,
    isApproved: r.is_approved === 1,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Items that MAY be quoted to a prospect (both owner keys present). */
export function isShareable(item: PortfolioItem): boolean {
  return item.verified && item.isApproved;
}

export interface PortfolioQuery {
  /** Only return items that are both verified and approved. */
  shareableOnly?: boolean;
  limit?: number;
}

export function listPortfolio(db: DB, q: PortfolioQuery = {}): PortfolioItem[] {
  const where = q.shareableOnly ? 'WHERE verified = 1 AND is_approved = 1' : '';
  const rows = db
    .prepare(`SELECT * FROM portfolio_items ${where} ORDER BY sort_order ASC, created_at ASC LIMIT ?`)
    .all(q.limit ?? 200) as unknown as Row[];
  return rows.map(toItem);
}

export function getPortfolioItem(db: DB, id: string): PortfolioItem | null {
  const r = db.prepare('SELECT * FROM portfolio_items WHERE id = ?').get(id) as Row | undefined;
  return r ? toItem(r) : null;
}

export interface CreatePortfolioInput {
  title: string;
  description?: string | null;
  serviceKey?: string | null;
  url?: string | null;
  imageUrl?: string | null;
  sortOrder?: number;
  createdBy?: string | null;
}

/** Create a draft item. New items start unverified and un-approved. */
export function createPortfolioItem(db: DB, input: CreatePortfolioInput): PortfolioItem {
  if (input.serviceKey) {
    const svc = db.prepare('SELECT key FROM services WHERE key = ?').get(input.serviceKey);
    if (!svc) throw new AppError('validation_failed', `Unknown service key "${input.serviceKey}"`);
  }
  const id = newId('pfi');
  const at = nowIso();
  db.prepare(
    `INSERT INTO portfolio_items (id, title, description, service_key, url, image_url, verified, verification_note,
       is_approved, sort_order, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, NULL, 0, ?, ?, ?, ?)`,
  ).run(
    id,
    input.title.trim(),
    input.description?.trim() ?? '',
    input.serviceKey ?? null,
    input.url ?? null,
    input.imageUrl ?? null,
    input.sortOrder ?? 0,
    input.createdBy ?? null,
    at,
    at,
  );
  return getPortfolioItem(db, id) as PortfolioItem;
}

/** Owner-only: mark an item verified (or un-verify it) with a note. */
export function verifyPortfolioItem(db: DB, id: string, verified: boolean, note: string | null): PortfolioItem {
  const item = getPortfolioItem(db, id);
  if (!item) throw notFound('Portfolio item');
  const trimmed = note?.trim() ?? '';
  if (verified && trimmed.length < 3) {
    throw new AppError('validation_failed', 'Verifying an item requires a note describing how it was verified');
  }
  db.prepare(
    `UPDATE portfolio_items SET verified = ?, verification_note = ?, updated_at = ? WHERE id = ?`,
  ).run(verified ? 1 : 0, verified ? trimmed : null, nowIso(), id);
  // Un-verifying an approved item must also revoke approval: the two-key rule
  // would otherwise leave a stale "approved" flag on unverified material.
  if (!verified && item.isApproved) {
    db.prepare(`UPDATE portfolio_items SET is_approved = 0, updated_at = ? WHERE id = ?`).run(nowIso(), id);
  }
  return getPortfolioItem(db, id) as PortfolioItem;
}

/** Owner-only: approve (or withdraw) an item for use in outreach. */
export function approvePortfolioItem(db: DB, id: string, approved: boolean): PortfolioItem {
  const item = getPortfolioItem(db, id);
  if (!item) throw notFound('Portfolio item');
  if (approved && !item.verified) {
    throw new AppError(
      'validation_failed',
      'Only verified items may be approved for outreach. Verify the case study first.',
      { id, verified: item.verified },
    );
  }
  db.prepare(`UPDATE portfolio_items SET is_approved = ?, updated_at = ? WHERE id = ?`).run(
    approved ? 1 : 0,
    nowIso(),
    id,
  );
  return getPortfolioItem(db, id) as PortfolioItem;
}

/**
 * Resolve the items to share. Passing ids selects exactly those items — but
 * each must satisfy the two-key rule or the whole request is refused, naming
 * every offender, so an operator cannot accidentally push a draft. With no ids
 * the current shareable set is used (capped so a message cannot balloon).
 */
export function resolveShareableItems(db: DB, itemIds: string[] | null | undefined, max = 5): PortfolioItem[] {
  if (itemIds && itemIds.length > 0) {
    const items: PortfolioItem[] = [];
    const missing: string[] = [];
    const rejected: { id: string; title: string; verified: boolean; approved: boolean }[] = [];
    for (const id of [...new Set(itemIds)]) {
      const item = getPortfolioItem(db, id);
      if (!item) {
        missing.push(id);
        continue;
      }
      if (!isShareable(item)) {
        rejected.push({ id: item.id, title: item.title, verified: item.verified, approved: item.isApproved });
        continue;
      }
      items.push(item);
    }
    if (missing.length > 0 || rejected.length > 0) {
      throw new AppError(
        'validation_failed',
        'Some selected portfolio items are not shareable. Only owner-verified AND owner-approved items may be sent.',
        { missing, rejected },
      );
    }
    if (items.length > max) {
      throw new AppError('validation_failed', `At most ${max} portfolio items may be shared in one message`, {
        selected: items.length,
        max,
      });
    }
    return items;
  }
  const shareable = listPortfolio(db, { shareableOnly: true, limit: max });
  if (shareable.length === 0) {
    throw new AppError(
      'validation_failed',
      'No shareable portfolio items exist yet. An item must be owner-verified AND owner-approved before it can be sent.',
    );
  }
  return shareable;
}

/** Ids of every shareable item, used by tests and the dashboard. */
export function shareableIds(db: DB): string[] {
  const rows = db
    .prepare('SELECT id FROM portfolio_items WHERE verified = 1 AND is_approved = 1 ORDER BY sort_order ASC')
    .all() as unknown as { id: string }[];
  return rows.map((r) => r.id);
}
