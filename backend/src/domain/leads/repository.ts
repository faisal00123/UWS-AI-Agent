/**
 * Lead repository: list/search/filter/paginate, detail aggregation, safe
 * edits (audited), stage changes (evidence enforced) and creation.
 *
 * Every mutation writes an audit event; conflicting values are never silently
 * overwritten - the previous value is recorded.
 */
import type { DB } from '../../db/index.ts';
import { AppError, notFound } from '../../core/errors.ts';
import { newId } from '../../core/ids.ts';
import { nowIso } from '../../core/time.ts';
import { recordAudit } from '../audit/service.ts';
import {
  findDuplicate,
  flagForReview,
  markMerged,
  reconcileSurvivor,
  recordMerge,
  type LeadCandidate,
} from './dedupe.ts';
import { normalizeCity, normalizeEmail, normalizeName, normalizePhone, normalizeWebsite } from './normalize.ts';

export type LeadStage =
  | 'new_lead'
  | 'website_analyzed'
  | 'eligible_to_contact'
  | 'call_attempted'
  | 'contacted'
  | 'interested'
  | 'qualified'
  | 'meeting_callback'
  | 'proposal_sent'
  | 'negotiation'
  | 'won'
  | 'lost';

export const LEAD_STAGES: LeadStage[] = [
  'new_lead',
  'website_analyzed',
  'eligible_to_contact',
  'call_attempted',
  'contacted',
  'interested',
  'qualified',
  'meeting_callback',
  'proposal_sent',
  'negotiation',
  'won',
  'lost',
];

/** Stages that cannot be reached without a supporting interaction record. */
export const STAGES_REQUIRING_EVIDENCE: LeadStage[] = ['contacted', 'interested', 'qualified'];

export interface LeadListQuery {
  q?: string;
  stage?: string | string[];
  city?: string;
  category?: string;
  eligibility?: string;
  minScore?: number;
  maxScore?: number;
  needsReview?: boolean;
  duplicatesOnly?: boolean;
  sort?: 'score' | 'discovered_at' | 'name' | 'stage';
  order?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
  /** Include rows merged into another lead (default false). */
  includeMerged?: boolean;
}

export interface LeadListItem {
  id: string;
  displayName: string;
  category: string | null;
  city: string | null;
  websiteUrl: string | null;
  phoneE164: string | null;
  email: string | null;
  stage: LeadStage;
  score: number | null;
  scoreBand: string | null;
  eligibilityState: string;
  interestLevel: string;
  qualificationStatus: string;
  duplicateStatus: string;
  sourceType: string;
  discoveredAt: string;
  updatedAt: string;
}

export interface LeadListResult {
  items: LeadListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export function listLeads(db: DB, query: LeadListQuery = {}): LeadListResult {
  const where: string[] = [];
  const params: unknown[] = [];

  if (!query.includeMerged) where.push('merged_into_id IS NULL');
  if (query.q) {
    where.push('(display_name LIKE ? OR city LIKE ? OR website_host LIKE ? OR phone_e164 LIKE ?)');
    const like = `%${query.q.replace(/[%_]/g, '')}%`;
    params.push(like, like, like, like);
  }
  if (query.stage) {
    const stages = Array.isArray(query.stage) ? query.stage : [query.stage];
    const clean = stages.filter((s) => LEAD_STAGES.includes(s as LeadStage));
    if (clean.length > 0) {
      where.push(`stage IN (${clean.map(() => '?').join(',')})`);
      params.push(...clean);
    }
  }
  if (query.city) {
    where.push('lower(coalesce(city,\'\')) = ?');
    params.push(query.city.toLowerCase());
  }
  if (query.category) {
    where.push('lower(coalesce(category,\'\')) = ?');
    params.push(query.category.toLowerCase());
  }
  if (query.eligibility) {
    where.push('eligibility_state = ?');
    params.push(query.eligibility);
  }
  if (typeof query.minScore === 'number') {
    where.push('score >= ?');
    params.push(query.minScore);
  }
  if (typeof query.maxScore === 'number') {
    where.push('score <= ?');
    params.push(query.maxScore);
  }
  if (query.needsReview) where.push("duplicate_status = 'pending_review'");
  if (query.duplicatesOnly) where.push("duplicate_status IN ('pending_review','duplicate')");

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    db.prepare(`SELECT COUNT(*) c FROM businesses ${clause}`).get(...(params as never[])) as {
      c: number;
    }
  ).c;

  // Each entry is a TEMPLATE with exactly one %ORDER% placeholder: the sort
  // direction is substituted ONCE, into the primary key only, while
  // tie-breakers keep their fixed direction. Never append `order` to an
  // expression that already contains directions - that produced
  // "… discovered_at ASC DESC" and SQLite threw a syntax error (500 on the
  // dashboard Leads list, fixed in Phase 11).
  const DEFAULT_SORT = 'score IS NULL ASC, score %ORDER%, discovered_at ASC';
  const sortMap: Record<string, string> = {
    score: DEFAULT_SORT,
    discovered_at: 'discovered_at %ORDER%',
    name: 'display_name COLLATE NOCASE %ORDER%',
    stage: 'stage %ORDER%, score DESC',
  };
  const sortKey = query.sort ?? 'score';
  const order = query.order === 'asc' ? 'ASC' : 'DESC';
  // Default ordering: highest score first, ties broken by OLDEST eligible lead.
  const orderBy = (sortMap[sortKey] ?? DEFAULT_SORT).replace(/%ORDER%/g, order);

  const pageSize = Math.min(Math.max(query.pageSize ?? 25, 1), 200);
  const page = Math.max(query.page ?? 1, 1);
  const offset = (page - 1) * pageSize;

  const rows = db
    .prepare(
      `SELECT id, display_name, category, city, website_url, phone_e164, email, stage, score,
              score_band, eligibility_state, interest_level, qualification_status,
              duplicate_status, source_type, discovered_at, updated_at
         FROM businesses
         ${clause}
         ORDER BY ${orderBy}
         LIMIT ? OFFSET ?`,
    )
    .all(...([...params, pageSize, offset] as never[])) as unknown as Record<string, unknown>[];

  return {
    items: rows.map(
      (r): LeadListItem => ({
        id: String(r.id),
        displayName: String(r.display_name),
        category: (r.category as string | null) ?? null,
        city: (r.city as string | null) ?? null,
        websiteUrl: (r.website_url as string | null) ?? null,
        phoneE164: (r.phone_e164 as string | null) ?? null,
        email: (r.email as string | null) ?? null,
        stage: r.stage as LeadStage,
        score: (r.score as number | null) ?? null,
        scoreBand: (r.score_band as string | null) ?? null,
        eligibilityState: String(r.eligibility_state),
        interestLevel: String(r.interest_level),
        qualificationStatus: String(r.qualification_status),
        duplicateStatus: String(r.duplicate_status),
        sourceType: String(r.source_type),
        discoveredAt: String(r.discovered_at),
        updatedAt: String(r.updated_at),
      }),
    ),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export interface LeadDetail {
  business: Record<string, unknown>;
  sources: unknown[];
  contactPoints: unknown[];
  fieldVerifications: unknown[];
  analyses: unknown[];
  scores: { score: Record<string, unknown>; factors: unknown[] }[];
  eligibility: unknown[];
  stageHistory: unknown[];
  interactions: unknown[];
  followups: unknown[];
  calls: unknown[];
  messages: unknown[];
  duplicates: unknown[];
  merges: unknown[];
  suppression: unknown[];
  deals: unknown[];
  meetings: unknown[];
  proposals: unknown[];
}

export function getLeadDetail(db: DB, id: string): LeadDetail {
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!business) throw notFound('Lead');

  const q = (sql: string, ...args: unknown[]): unknown[] =>
    db.prepare(sql).all(...(args as never[])) as unknown[];

  return {
    business,
    sources: q('SELECT * FROM lead_sources WHERE business_id = ? ORDER BY imported_at DESC', id),
    contactPoints: q('SELECT * FROM contact_points WHERE business_id = ? ORDER BY kind', id),
    fieldVerifications: q('SELECT * FROM field_verifications WHERE business_id = ? ORDER BY field, checked_at DESC', id),
    analyses: q('SELECT * FROM website_analyses WHERE business_id = ? ORDER BY created_at DESC LIMIT 10', id),
    scores: (
      q('SELECT * FROM lead_scores WHERE business_id = ? ORDER BY computed_at DESC LIMIT 5', id) as Record<
        string,
        unknown
      >[]
    ).map((score) => ({
      score,
      factors: q('SELECT * FROM score_factors WHERE score_id = ?', String(score.id)),
    })),
    eligibility: q('SELECT * FROM eligibility_checks WHERE business_id = ? ORDER BY checked_at DESC LIMIT 10', id),
    stageHistory: q('SELECT * FROM lead_stage_history WHERE business_id = ? ORDER BY changed_at DESC LIMIT 50', id),
    interactions: q('SELECT * FROM interactions WHERE business_id = ? ORDER BY occurred_at DESC LIMIT 50', id),
    followups: q('SELECT * FROM followup_tasks WHERE business_id = ? ORDER BY scheduled_for ASC LIMIT 50', id),
    calls: q('SELECT * FROM calls WHERE business_id = ? ORDER BY created_at DESC LIMIT 50', id),
    messages: q('SELECT * FROM messages WHERE business_id = ? ORDER BY created_at DESC LIMIT 50', id),
    duplicates: q(
      `SELECT * FROM duplicate_candidates WHERE business_id_a = ? OR business_id_b = ? ORDER BY created_at DESC`,
      id,
      id,
    ),
    merges: q('SELECT * FROM merge_history WHERE survivor_id = ? OR merged_id = ? ORDER BY performed_at DESC', id, id),
    suppression: q('SELECT * FROM suppression_list WHERE business_id = ?', id),
    deals: q('SELECT * FROM deals WHERE business_id = ? ORDER BY created_at DESC', id),
    meetings: q('SELECT * FROM meetings WHERE business_id = ? ORDER BY starts_at DESC', id),
    proposals: q('SELECT * FROM proposals WHERE business_id = ? ORDER BY created_at DESC', id),
  };
}

export interface CreateLeadInput {
  displayName: string;
  category?: string | null;
  city?: string | null;
  websiteUrl?: string | null;
  phone?: string | null;
  email?: string | null;
  whatsapp?: string | null;
  contactPersonName?: string | null;
  sourceUrl?: string | null;
  requirements?: string | null;
}

export interface CreateLeadResult {
  id: string;
  mergedIntoId: string | null;
  duplicate: { id: string; score: number; strategy: string; autoMerge: boolean } | null;
  problems: { field: string; message: string }[];
}

export function createLead(
  db: DB,
  input: CreateLeadInput,
  actor: { userId: string | null; label: 'owner' | 'staff' | 'system' | 'scheduler'; sourceType?: string },
): CreateLeadResult {
  const problems: { field: string; message: string }[] = [];
  const name = (input.displayName ?? '').trim();
  if (name.length < 2) problems.push({ field: 'displayName', message: 'Business name is required (min 2 characters)' });

  const phone = normalizePhone(input.phone ?? '');
  if ((input.phone ?? '') !== '' && !phone.valid) {
    problems.push({ field: 'phone', message: `Phone number is not usable (${phone.reason})` });
  }
  const site = normalizeWebsite(input.websiteUrl ?? '');
  if ((input.websiteUrl ?? '') !== '' && !site.valid) {
    problems.push({ field: 'websiteUrl', message: `Website URL is not usable (${site.reason})` });
  }
  const mail = normalizeEmail(input.email ?? '');
  if ((input.email ?? '') !== '' && !mail.valid) {
    problems.push({ field: 'email', message: `Email is not valid (${mail.reason})` });
  }
  const whatsapp = normalizePhone(input.whatsapp ?? '');
  if ((input.whatsapp ?? '') !== '' && !whatsapp.valid) {
    problems.push({ field: 'whatsapp', message: `WhatsApp number is not usable (${whatsapp.reason})` });
  }

  if (problems.some((p) => p.field === 'displayName')) {
    throw new AppError('validation_failed', 'Business name is required', { problems });
  }

  const candidate: LeadCandidate = {
    displayName: name,
    category: input.category?.trim() || null,
    city: input.city?.trim() || null,
    websiteUrl: site.valid ? site.url : null,
    websiteHost: site.valid ? site.host : null,
    phoneE164: phone.valid ? phone.e164 : null,
    phoneRaw: input.phone?.trim() || null,
    email: mail.valid ? mail.email : null,
    whatsappE164: whatsapp.valid ? whatsapp.e164 : null,
    contactPersonName: input.contactPersonName?.trim() || null,
    sourceUrl: input.sourceUrl?.trim() || null,
    requirements: input.requirements?.trim() || null,
  };

  const duplicate = findDuplicate(db, candidate);
  const at = nowIso();
  const id = newId('biz');
  const mergedIntoId = duplicate?.autoMerge ? duplicate.businessId : null;
  const hasWarnings = problems.length > 0;

  db.prepare(
    `INSERT INTO businesses (
       id, display_name, normalized_name, category, city, country,
       website_url, website_host, phone_e164, phone_raw, email, whatsapp_e164,
       contact_person_name, source_type, source_url, discovered_at, last_checked_at,
       stage, stage_changed_at, stage_change_reason, eligibility_state,
       duplicate_status, merged_into_id, created_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'PK', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               'new_lead', ?, ?, 'unknown', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    normalizeName(name) || name.toLowerCase(),
    candidate.category,
    candidate.city,
    candidate.websiteUrl,
    candidate.websiteHost,
    candidate.phoneE164,
    candidate.phoneRaw,
    candidate.email,
    candidate.whatsappE164,
    candidate.contactPersonName,
    actor.sourceType ?? 'manual',
    candidate.sourceUrl,
    at,
    at,
    at,
    mergedIntoId ? 'merged_as_duplicate' : duplicate ? 'imported_needs_review' : 'created_manually',
    duplicate ? (duplicate.autoMerge ? 'duplicate' : 'pending_review') : 'unique',
    mergedIntoId,
    actor.userId,
    at,
    at,
  );

  db.prepare(
    `INSERT INTO lead_sources (id, business_id, source_type, source_url, source_ref, raw_payload_json, imported_by, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId('src'),
    id,
    actor.sourceType ?? 'manual',
    candidate.sourceUrl,
    'manual_entry',
    JSON.stringify(input),
    actor.userId,
    at,
  );

  if (duplicate?.autoMerge) {
    const outcome = reconcileSurvivor(db, duplicate.businessId, id);
    recordMerge(
      db,
      {
        survivorId: duplicate.businessId,
        mergedId: id,
        strategy: duplicate.strategy,
        matchScore: duplicate.score,
        actor: { userId: actor.userId, label: actor.label },
        reason: 'auto-merged on manual entry',
      },
      outcome,
    );
  } else if (duplicate) {
    flagForReview(db, id, duplicate, { userId: actor.userId, label: actor.label });
  }

  recordAudit(db, {
    actorUserId: actor.userId,
    actorLabel: actor.label,
    action: 'lead.create',
    entityType: 'business',
    entityId: id,
    summary: `Lead "${name}" created${mergedIntoId ? ` (merged into ${mergedIntoId})` : ''}`,
    details: { problems, duplicate: duplicate ? { score: duplicate.score, strategy: duplicate.strategy } : null },
  });

  return {
    id,
    mergedIntoId,
    duplicate: duplicate
      ? { id: duplicate.businessId, score: duplicate.score, strategy: duplicate.strategy, autoMerge: duplicate.autoMerge }
      : null,
    problems,
  };
}

export interface UpdateLeadInput {
  field: string;
  value: string | number | null;
}

const EDITABLE_FIELDS: Record<string, string> = {
  displayName: 'display_name',
  category: 'category',
  city: 'city',
  websiteUrl: 'website_url',
  phone: 'phone_e164',
  email: 'email',
  whatsapp: 'whatsapp_e164',
  contactPersonName: 'contact_person_name',
  contactPersonRole: 'contact_person_role',
  requirements: 'requirements',
  serviceInterest: 'service_interest',
  preferredLanguage: 'preferred_language',
  timeline: 'timeline',
};

export function updateLead(
  db: DB,
  id: string,
  updates: UpdateLeadInput[],
  actor: { userId: string | null; label: 'owner' | 'staff' | 'system' | 'scheduler' },
): Record<string, unknown> {
  const existing = db.prepare('SELECT * FROM businesses WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!existing) throw notFound('Lead');

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const problems: { field: string; message: string }[] = [];

  for (const update of updates) {
    const column = EDITABLE_FIELDS[update.field];
    if (!column) {
      problems.push({ field: update.field, message: 'Field is not editable' });
      continue;
    }
    let value: string | number | null = update.value;
    if (typeof value === 'string') {
      // Normalise the fields that are used as dedupe / contact keys.
      if (update.field === 'phone' || update.field === 'whatsapp') {
        const p = normalizePhone(value);
        if (value.trim() !== '' && !p.valid) {
          problems.push({ field: update.field, message: `${update.field === 'phone' ? 'Phone' : 'WhatsApp'} number is not usable (${p.reason})` });
          continue;
        }
        if (update.field === 'phone') {
          // keep raw alongside normalised value
          db.prepare('UPDATE businesses SET phone_raw = ? WHERE id = ?').run(value, id);
        }
        value = p.valid ? p.e164 : null;
      } else if (update.field === 'websiteUrl') {
        const w = normalizeWebsite(value);
        if (value.trim() !== '' && !w.valid) {
          problems.push({ field: update.field, message: `Website URL is not usable (${w.reason})` });
          continue;
        }
        db.prepare('UPDATE businesses SET website_host = ? WHERE id = ?').run(w.valid ? w.host : null, id);
        value = w.valid ? w.url : null;
      } else if (update.field === 'email') {
        const e = normalizeEmail(value);
        if (value.trim() !== '' && !e.valid) {
          problems.push({ field: update.field, message: `Email is not valid (${e.reason})` });
          continue;
        }
        value = e.email;
      } else if (update.field === 'city') {
        value = value.trim() || null;
      } else if (update.field === 'displayName') {
        if (value.trim().length < 2) {
          problems.push({ field: update.field, message: 'Business name is too short' });
          continue;
        }
        db.prepare('UPDATE businesses SET normalized_name = ? WHERE id = ?').run(normalizeName(value), id);
        value = value.trim();
      } else {
        value = value.trim() || null;
      }
    }

    const current = existing[column];
    if (String(current ?? '') === String(value ?? '')) continue;
    changes[update.field] = { from: current ?? null, to: value };
    db.prepare(`UPDATE businesses SET ${column} = ?, updated_at = ? WHERE id = ?`).run(
      value as never,
      nowIso(),
      id,
    );
  }

  if (problems.length > 0 && Object.keys(changes).length === 0) {
    // Surface the specific reasons so callers see "not usable" / "not editable"
    // rather than a generic rejection.
    throw new AppError('validation_failed', `Update rejected: ${problems.map((p) => p.message).join('; ')}`, {
      problems,
    });
  }

  if (Object.keys(changes).length > 0) {
    recordAudit(db, {
      actorUserId: actor.userId,
      actorLabel: actor.label,
      action: 'lead.update',
      entityType: 'business',
      entityId: id,
      summary: `Lead fields updated: ${Object.keys(changes).join(', ')}`,
      details: { changes, rejected: problems },
    });
  }

  const fresh = db.prepare('SELECT * FROM businesses WHERE id = ?').get(id) as Record<string, unknown>;
  return { business: fresh, changes, rejected: problems };
}

/**
 * Stage transitions with evidence rules:
 *   - contacted / interested / qualified require an interaction id
 *   - won / lost require a reason AND owner confirmation semantics
 */
export function changeStage(
  db: DB,
  id: string,
  toStage: LeadStage,
  opts: { reason: string; evidenceInteractionId?: string | null; actor: { userId: string | null; label: 'owner' | 'staff' | 'system' | 'scheduler' } },
): { from: string; to: LeadStage } {
  if (!LEAD_STAGES.includes(toStage)) {
    throw new AppError('validation_failed', `Unknown stage "${toStage}"`, { allowed: LEAD_STAGES });
  }
  const existing = db.prepare('SELECT stage FROM businesses WHERE id = ?').get(id) as
    | { stage: string }
    | undefined;
  if (!existing) throw notFound('Lead');
  const from = existing.stage;
  if (from === toStage) return { from, to: toStage };

  if (STAGES_REQUIRING_EVIDENCE.includes(toStage) && !opts.evidenceInteractionId) {
    throw new AppError(
      'validation_failed',
      `Moving to "${toStage}" requires a supporting interaction (evidence).`,
      { stage: toStage, requiredEvidence: true },
    );
  }
  if (opts.evidenceInteractionId) {
    const exists = db
      .prepare('SELECT id FROM interactions WHERE id = ? AND business_id = ?')
      .get(opts.evidenceInteractionId, id);
    if (!exists) {
      throw new AppError('validation_failed', 'Evidence interaction does not belong to this lead');
    }
  }
  if ((toStage === 'won' || toStage === 'lost') && opts.reason.trim().length < 3) {
    throw new AppError('validation_failed', 'Won/Lost requires a reason (owner confirmation or verified record)');
  }

  const at = nowIso();
  db.prepare(
    `INSERT INTO lead_stage_history (business_id, from_stage, to_stage, reason, evidence_interaction_id, changed_by, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, from, toStage, opts.reason.trim(), opts.evidenceInteractionId ?? null, opts.actor.userId, at);
  db.prepare(
    `UPDATE businesses SET stage = ?, stage_changed_at = ?, stage_change_reason = ?, updated_at = ? WHERE id = ?`,
  ).run(toStage, at, opts.reason.trim(), at, id);

  recordAudit(db, {
    actorUserId: opts.actor.userId,
    actorLabel: opts.actor.label,
    action: 'lead.stage_change',
    entityType: 'business',
    entityId: id,
    summary: `Stage ${from} -> ${toStage}: ${opts.reason.trim()}`,
    details: { from, to: toStage, evidenceInteractionId: opts.evidenceInteractionId ?? null },
  });
  return { from, to: toStage };
}
