/**
 * Duplicate detection & safe merging.
 *
 * Confidence tiers (Section 1.10):
 *   1.00  identical normalised phone      -> automatic merge
 *   0.98  identical record-unique source URL (same source record, e.g. the
 *         same OSM element page)           -> automatic merge
 *   0.96  identical website host          -> automatic merge
 *   0.92  identical normalised name+city  -> automatic merge
 *   0.75-0.91  fuzzy name match (same city, or phone last-4 overlap)
 *                                      -> flagged for MANUAL REVIEW only
 *   < 0.75 -> treated as distinct
 *
 * The source-URL tier only fires for URLs whose last path segment is a pure
 * number (…/node/101, …/listing/55): such a URL identifies ONE record in
 * its source, so two live rows carrying it are the same source record —
 * typically a re-import of an updated extract where the name changed or the
 * city is missing and the lower tiers cannot match. Shared listing/category
 * pages (no numeric record id) are never treated as identity matches.
 *
 * Automatic merges never delete anything: the incoming row is retained with
 * `merged_into_id` set, its sources stay attached, and every kept/conflicting
 * value is written to merge_history + audit_events.
 */
import type { DB } from '../../db/index.ts';
import { nowIso } from '../../core/time.ts';
import { newId } from '../../core/ids.ts';
import { recordAudit } from '../audit/service.ts';
import { normalizeName, normalizeCity, nameSimilarity } from './normalize.ts';

export interface LeadCandidate {
  displayName: string;
  category: string | null;
  city: string | null;
  websiteUrl: string | null;
  websiteHost: string | null;
  phoneE164: string | null;
  phoneRaw: string | null;
  email: string | null;
  whatsappE164: string | null;
  contactPersonName: string | null;
  sourceUrl: string | null;
  requirements: string | null;
  /** Optional evidence-derived fields (Phase 2): carried to the INSERT, not
   *  used for duplicate MATCHING — address/coords never invent a match. */
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface DuplicateMatch {
  businessId: string;
  displayName: string;
  score: number;
  strategy: 'exact_phone' | 'source_record' | 'exact_website' | 'name_city' | 'fuzzy_name';
  matchedFields: { field: string; incoming: string; existing: string }[];
  autoMerge: boolean;
}

interface ExistingRow {
  id: string;
  display_name: string;
  normalized_name: string;
  city: string | null;
  website_host: string | null;
  phone_e164: string | null;
  email: string | null;
}

const AUTO_MERGE_THRESHOLD = 0.92;
const REVIEW_THRESHOLD = 0.75;

/**
 * A source URL identifies exactly ONE record when its last path segment is a
 * pure number (`…/node/101`, `…/way/222`, `…/listing/55`): that is the shape
 * both the offline extractor (OSM element permalinks) and record-based
 * directories use. Shared listing/category pages (`/category/clinics`,
 * `/page/2`-style paths without an id, bare hosts) are NOT record-unique and
 * must never drive an automatic merge — several different businesses can
 * legitimately share them.
 */
function isRecordUniqueSourceUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const segments = url.pathname.split('/').filter((s) => s !== '');
    const last = segments[segments.length - 1];
    return last !== undefined && /^\d+$/.test(last);
  } catch {
    return false; // not even a URL -> never an identity match
  }
}

/** Find the best duplicate candidate for an incoming lead (live rows only). */
export async function findDuplicate(db: DB, candidate: LeadCandidate): Promise<DuplicateMatch | null> {
  const matches: DuplicateMatch[] = [];

  const liveFilter = 'merged_into_id IS NULL';
  const byId = (row: ExistingRow): ExistingRow => row;

  if (candidate.phoneE164) {
    const row = (await db
      .prepare(`SELECT id, display_name, normalized_name, city, website_host, phone_e164, email FROM businesses WHERE phone_e164 = ? AND ${liveFilter}`)
      .get(candidate.phoneE164)) as ExistingRow | undefined;
    if (row) {
      matches.push({
        businessId: byId(row).id,
        displayName: row.display_name,
        score: 1,
        strategy: 'exact_phone',
        matchedFields: [{ field: 'phone', incoming: candidate.phoneE164, existing: row.phone_e164 ?? '' }],
        autoMerge: true,
      });
    }
  }

  if (matches.length === 0 && candidate.sourceUrl && isRecordUniqueSourceUrl(candidate.sourceUrl)) {
    // Same source RECORD (e.g. the same OSM element page re-imported from an
    // updated extract): the URL identifies one record, so a live row already
    // carrying it is that record — even when the name changed or the city is
    // missing and the lower tiers cannot match.
    const row = (await db
      .prepare(`SELECT id, display_name, normalized_name, city, website_host, phone_e164, email FROM businesses WHERE source_url = ? AND ${liveFilter}`)
      .get(candidate.sourceUrl)) as ExistingRow | undefined;
    if (row) {
      matches.push({
        businessId: row.id,
        displayName: row.display_name,
        score: 0.98,
        strategy: 'source_record',
        matchedFields: [{ field: 'source', incoming: candidate.sourceUrl, existing: candidate.sourceUrl }],
        autoMerge: true,
      });
    }
  }

  if (matches.length === 0 && candidate.websiteHost) {
    const row = (await db
      .prepare(`SELECT id, display_name, normalized_name, city, website_host, phone_e164, email FROM businesses WHERE website_host = ? AND ${liveFilter}`)
      .get(candidate.websiteHost)) as ExistingRow | undefined;
    if (row) {
      matches.push({
        businessId: row.id,
        displayName: row.display_name,
        score: 0.96,
        strategy: 'exact_website',
        matchedFields: [{ field: 'website', incoming: candidate.websiteHost, existing: row.website_host ?? '' }],
        autoMerge: true,
      });
    }
  }

  if (matches.length === 0) {
    const normName = normalizeName(candidate.displayName);
    const normCity = normalizeCity(candidate.city ?? '');
    if (normName && normCity) {
      const row = (await db
        .prepare(
          `SELECT id, display_name, normalized_name, city, website_host, phone_e164, email
             FROM businesses
            WHERE normalized_name = ? AND lower(coalesce(city,'')) = ? AND ${liveFilter}`,
        )
        .get(normName, normCity)) as ExistingRow | undefined;
      if (row) {
        matches.push({
          businessId: row.id,
          displayName: row.display_name,
          score: 0.92,
          strategy: 'name_city',
          matchedFields: [
            { field: 'name', incoming: normName, existing: row.normalized_name },
            { field: 'city', incoming: normCity, existing: normalizeCity(row.city ?? '') },
          ],
          autoMerge: true,
        });
      }
    }
  }

  // Fuzzy pass - ONLY flags for manual review, never merges.
  if (matches.length === 0) {
    const normName = normalizeName(candidate.displayName);
    const normCity = normalizeCity(candidate.city ?? '');
    const rows = (await db
      .prepare(
        `SELECT id, display_name, normalized_name, city, website_host, phone_e164, email
           FROM businesses
          WHERE merged_into_id IS NULL
            AND (? = '' OR lower(coalesce(city,'')) = ?)
          ORDER BY discovered_at ASC
          LIMIT 300`,
      )
      .all(normCity, normCity)) as unknown as ExistingRow[];

    let best: DuplicateMatch | null = null;
    for (const row of rows) {
      const sim = nameSimilarity(normName, row.normalized_name);
      if (sim >= REVIEW_THRESHOLD) {
        const candidateMatch: DuplicateMatch = {
          businessId: row.id,
          displayName: row.display_name,
          score: Number(sim.toFixed(3)),
          strategy: 'fuzzy_name',
          matchedFields: [{ field: 'name', incoming: normName, existing: row.normalized_name }],
          autoMerge: false,
        };
        if (!best || candidateMatch.score > best.score) best = candidateMatch;
      }
    }
    if (best) matches.push(best);
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => b.score - a.score);
  return matches[0]!;
}

export interface MergeOptions {
  survivorId: string;
  mergedId: string;
  strategy: DuplicateMatch['strategy'];
  matchScore: number;
  actor: { userId: string | null; label: 'owner' | 'staff' | 'system' | 'scheduler' };
  reason?: string;
}

export interface MergeOutcome {
  kept: Record<string, unknown>;
  overridden: Record<string, { survivor: unknown; incoming: unknown }>;
}

/** Columns reconciled during a merge. Survivor values win on conflict. */
const MERGE_FIELDS = [
  'display_name',
  'category',
  'city',
  'address',
  'latitude',
  'longitude',
  'website_url',
  'website_host',
  'phone_e164',
  'email',
  'whatsapp_e164',
  'contact_person_name',
  'contact_person_role',
  'source_url',
  'requirements',
] as const;

function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/**
 * Fills gaps on the survivor from the incoming row and records every conflict
 * instead of overwriting. The incoming row itself is never modified.
 */
export async function reconcileSurvivor(db: DB, survivorId: string, mergedId: string): Promise<MergeOutcome> {
  const survivor = (await db.prepare('SELECT * FROM businesses WHERE id = ?').get(survivorId)) as
    | Record<string, unknown>
    | undefined;
  const incoming = (await db.prepare('SELECT * FROM businesses WHERE id = ?').get(mergedId)) as
    | Record<string, unknown>
    | undefined;
  if (!survivor || !incoming) {
    throw new Error(`reconcileSurvivor: missing row (survivor=${survivorId}, merged=${mergedId})`);
  }

  const kept: Record<string, unknown> = {};
  const overridden: Record<string, { survivor: unknown; incoming: unknown }> = {};
  const updates: { sql: string; params: unknown[] }[] = [];

  for (const field of MERGE_FIELDS) {
    const sVal = survivor[field];
    const iVal = incoming[field];
    if (isEmptyValue(sVal) && !isEmptyValue(iVal)) {
      kept[field] = iVal;
      updates.push({ sql: `UPDATE businesses SET ${field} = ? WHERE id = ?`, params: [iVal, survivorId] });
    } else if (!isEmptyValue(sVal) && !isEmptyValue(iVal) && String(sVal) !== String(iVal)) {
      // Conflict: survivor value is retained; the incoming value is preserved
      // in merge_history (and remains readable on the merged row itself).
      kept[field] = sVal;
      overridden[field] = { survivor: sVal, incoming: iVal };
    } else {
      kept[field] = isEmptyValue(sVal) ? sVal : sVal;
    }
  }

  for (const u of updates) await db.prepare(u.sql).run(...(u.params as never[]));
  await db.prepare('UPDATE businesses SET updated_at = ? WHERE id = ?').run(nowIso(), survivorId);
  return { kept, overridden };
}

/** Record the merge in merge_history + duplicate_candidates + audit. */
export async function recordMerge(db: DB, opts: MergeOptions, outcome: MergeOutcome): Promise<string> {
  const mergeId = newId('mrg');
  const at = nowIso();
  await db.prepare(
    `INSERT INTO merge_history
       (id, survivor_id, merged_id, match_score, strategy, kept_values_json, overridden_values_json,
        sources_merged, performed_by, performed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    mergeId,
    opts.survivorId,
    opts.mergedId,
    opts.matchScore,
    opts.strategy,
    JSON.stringify(outcome.kept),
    JSON.stringify(outcome.overridden),
    opts.actor.userId,
    at,
  );

  // Canonical (a < b) upsert of the duplicate-candidate decision.
  const [a, b] = [opts.survivorId, opts.mergedId].sort() as [string, string];
  const existing = (await db
    .prepare('SELECT id FROM duplicate_candidates WHERE business_id_a = ? AND business_id_b = ?')
    .get(a, b)) as { id: string } | undefined;
  if (existing) {
    await db.prepare(
      `UPDATE duplicate_candidates SET status = 'merged', auto_merged = 1, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?`,
    ).run(opts.actor.userId, at, opts.reason ?? `auto-merged (${opts.strategy})`, existing.id);
  } else {
    await db.prepare(
      `INSERT INTO duplicate_candidates (id, business_id_a, business_id_b, match_score, match_fields, status, auto_merged, decided_by, decided_at, decision_note, created_at)
       VALUES (?, ?, ?, ?, ?, 'merged', 1, ?, ?, ?, ?)`,
    ).run(
      newId('dup'),
      a,
      b,
      opts.matchScore,
      JSON.stringify([{ field: opts.strategy }]),
      opts.actor.userId,
      at,
      opts.reason ?? `auto-merged (${opts.strategy})`,
      at,
    );
  }

  await recordAudit(db, {
    actorUserId: opts.actor.userId,
    actorLabel: opts.actor.label,
    action: 'lead.merge',
    entityType: 'business',
    entityId: opts.survivorId,
    summary: `Merged duplicate lead into "${opts.survivorId}" (${opts.strategy}, confidence ${opts.matchScore})`,
    details: {
      mergedId: opts.mergedId,
      strategy: opts.strategy,
      matchScore: opts.matchScore,
      conflictsPreserved: Object.keys(outcome.overridden).length,
      overridden: outcome.overridden,
    },
  });
  return mergeId;
}

/** Flag an uncertain match for manual review (never merged automatically). */
export async function flagForReview(
  db: DB,
  incomingId: string,
  match: DuplicateMatch,
  actor: { userId: string | null; label: string },
): Promise<void> {
  const at = nowIso();
  const [a, b] = [incomingId, match.businessId].sort() as [string, string];
  const existing = (await db
    .prepare('SELECT id, status FROM duplicate_candidates WHERE business_id_a = ? AND business_id_b = ?')
    .get(a, b)) as { id: string; status: string } | undefined;
  if (!existing) {
    await db.prepare(
      `INSERT INTO duplicate_candidates (id, business_id_a, business_id_b, match_score, match_fields, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(newId('dup'), a, b, match.score, JSON.stringify(match.matchedFields), at);
  }
  await db.prepare(
    `UPDATE businesses SET duplicate_status = 'pending_review', duplicate_of_id = ?, updated_at = ? WHERE id = ? AND merged_into_id IS NULL`,
  ).run(match.businessId, at, incomingId);
  await recordAudit(db, {
    actorUserId: actor.userId,
    actorLabel: actor.label as 'owner' | 'staff' | 'system' | 'scheduler',
    action: 'lead.duplicate_flagged',
    entityType: 'business',
    entityId: incomingId,
    summary: `Possible duplicate of ${match.displayName} flagged for review (${match.strategy}, ${match.score})`,
    details: { match: match.matchedFields, score: match.score },
  });
}

/** Manually resolve a pending duplicate. */
export async function resolveDuplicate(
  db: DB,
  duplicateId: string,
  decision: 'merge' | 'not_duplicate',
  actor: { userId: string | null; label: 'owner' | 'staff' | 'system' | 'scheduler' },
  note?: string,
): Promise<{ survivorId: string; mergedId: string | null }> {
  const row = (await db.prepare('SELECT * FROM duplicate_candidates WHERE id = ?').get(duplicateId)) as
    | {
        id: string;
        business_id_a: string;
        business_id_b: string;
        match_score: number;
        status: string;
      }
    | undefined;
  if (!row) throw new Error(`Duplicate ${duplicateId} not found`);
  if (row.status !== 'pending') throw new Error(`Duplicate ${duplicateId} is already ${row.status}`);

  const at = nowIso();
  if (decision === 'not_duplicate') {
    await db.prepare(
      `UPDATE duplicate_candidates SET status = 'reviewed_not_duplicate', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?`,
    ).run(actor.userId, at, note ?? 'reviewed: distinct businesses', duplicateId);
    for (const id of [row.business_id_a, row.business_id_b]) {
      await db.prepare(
        `UPDATE businesses SET duplicate_status = 'unique', duplicate_of_id = NULL, updated_at = ? WHERE id = ?`,
      ).run(at, id);
    }
    await recordAudit(db, {
      actorUserId: actor.userId,
      actorLabel: actor.label,
      action: 'lead.duplicate_rejected',
      entityType: 'business',
      entityId: row.business_id_a,
      summary: `Duplicate candidate ${duplicateId} rejected as distinct businesses`,
      details: { note: note ?? null },
    });
    return { survivorId: row.business_id_a, mergedId: null };
  }

  // Merge: the older record survives (deterministic), the newer merges into it.
  const older = (await db.prepare('SELECT id, discovered_at FROM businesses WHERE id = ?').get(row.business_id_a)) as { discovered_at: string };
  const newer = (await db.prepare('SELECT id, discovered_at FROM businesses WHERE id = ?').get(row.business_id_b)) as { discovered_at: string };
  const survivorId = older.discovered_at <= newer.discovered_at ? row.business_id_a : row.business_id_b;
  const mergedId = survivorId === row.business_id_a ? row.business_id_b : row.business_id_a;

  await markMerged(db, survivorId, mergedId);
  const outcome = await reconcileSurvivor(db, survivorId, mergedId);
  await recordMerge(
    db,
    { survivorId, mergedId, strategy: 'fuzzy_name', matchScore: row.match_score, actor, reason: note ?? 'manual merge' },
    outcome,
  );
  return { survivorId, mergedId };
}

/** Apply merged_into_id to the incoming row (must happen before value checks). */
export async function markMerged(db: DB, survivorId: string, mergedId: string, reason?: string): Promise<void> {
  const at = nowIso();
  await db.prepare(
    `UPDATE businesses
        SET merged_into_id = ?,
            duplicate_status = 'duplicate',
            stage_change_reason = coalesce(stage_change_reason, ?),
            updated_at = ?
      WHERE id = ?`,
  ).run(survivorId, reason ?? 'merged_as_duplicate', at, mergedId);
}

export const DUPLICATE_THRESHOLDS = { AUTO_MERGE_THRESHOLD, REVIEW_THRESHOLD };
