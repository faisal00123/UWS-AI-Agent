/**
 * Explainable lead scoring (Section 1.5).
 *
 * Every score is a weighted sum of factors, each of which is stored with its
 * own code, label, weight, points, raw value, evidence state and evidence
 * text. The UI renders the factors, so a user always sees *why* a lead got the
 * number it did.
 *
 * Honesty rules:
 *  - A factor with no evidence contributes 0 points and is stored with
 *    state 'unknown'. We never guess a value to fill a gap.
 *  - 'measured' = derived from our own analysis/fetch. 'stated' = the prospect
 *    said it. 'estimated' = a heuristic inference. All three are distinguishable
 *    in the stored record.
 *  - A score never overrides consent, eligibility, opt-outs or limits. It only
 *    orders eligible leads.
 */
import type { DB } from '../../db/index.ts';
import { newId } from '../../core/ids.ts';
import { nowIso } from '../../core/time.ts';
import { getSetting } from '../settings/service.ts';
import type { Config } from '../../core/config.ts';

export const SCORE_MODEL_VERSION = 'uws-score-1.0.0';

export type FactorState = 'measured' | 'stated' | 'estimated' | 'unknown';

export interface ScoreFactor {
  code: string;
  label: string;
  weight: number;
  /** Points contributed after weighting, 0..weight*100 scaled to the total. */
  points: number;
  rawValue: string;
  state: FactorState;
  evidence: string | null;
}

export interface ScoreResult {
  score: number;
  band: 'low' | 'medium' | 'high' | 'very_high';
  factors: ScoreFactor[];
  summary: string;
  computedAt: string;
  modelVersion: string;
}

export interface ScoringWeights {
  websiteGap: number;
  serviceFit: number;
  budget: number;
  timeline: number;
  contactability: number;
  engagement: number;
}

interface EvidenceInput {
  businessId: string;
}

interface LeadRow {
  eligibility_state: string;
  budget_minor: number | null;
  budget_state: string;
  timeline: string;
  interest_level: string;
  phone_e164: string | null;
  email: string | null;
  whatsapp_e164: string | null;
  website_url: string | null;
  website_host: string | null;
}

interface AnalysisRow {
  status: string;
  opportunities_json: string;
}

const TIMELINE_POINTS: Record<string, number> = {
  immediate: 1,
  within_1_month: 0.9,
  within_3_months: 0.65,
  within_6_months: 0.4,
  later: 0.2,
  unknown: 0,
};

const BUDGET_POINTS: Record<string, number> = {
  verified: 1,
  stated: 0.85,
  estimated: 0.5,
  unknown: 0,
};

const INTEREST_POINTS: Record<string, number> = {
  interested: 1,
  neutral: 0.4,
  unknown: 0.2,
  not_interested: 0,
  opted_out: 0,
};

/** Banding thresholds (inclusive lower bound). */
export function bandFor(score: number): ScoreResult['band'] {
  if (score >= 80) return 'very_high';
  if (score >= 60) return 'high';
  if (score >= 35) return 'medium';
  return 'low';
}

/**
 * Compute a fresh score. Pure with respect to the DB: reads the lead, its
 * latest website analysis and any recorded interactions, then scores.
 */
export function computeScore(db: DB, cfg: Config, input: EvidenceInput): ScoreResult {
  const weights = getSetting<ScoringWeights>(db, 'scoring_weights', cfg);
  const lead = db
    .prepare(
      `SELECT eligibility_state, budget_minor, budget_state, timeline, interest_level,
              phone_e164, email, whatsapp_e164, website_url, website_host
         FROM businesses WHERE id = ?`,
    )
    .get(input.businessId) as LeadRow | undefined;
  if (!lead) throw new Error(`computeScore: lead ${input.businessId} not found`);

  const analysis = db
    .prepare(`SELECT status, opportunities_json FROM website_analyses WHERE business_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(input.businessId) as AnalysisRow | undefined;

  const interactions = db
    .prepare(`SELECT COUNT(*) c FROM interactions WHERE business_id = ?`)
    .get(input.businessId) as { c: number };

  const opportunities: { code: string }[] = analysis ? safeParse(analysis.opportunities_json, []) : [];

  const factors: ScoreFactor[] = [];

  // --- website gap: how much room is there to sell improvement work? --------
  const hasWebsiteOnRecord = Boolean(lead.website_url ?? lead.website_host);
  factors.push(websiteGapFactor(analysis, opportunities, weights.websiteGap, hasWebsiteOnRecord));

  // --- service fit: does the lead's profile match what UWS sells? ----------
  factors.push(serviceFitFactor(lead, opportunities, weights.serviceFit));

  // --- budget: only ever "stated"/"verified" by a human, never invented ------
  factors.push(budgetFactor(lead, weights.budget));

  // --- timeline -------------------------------------------------------------
  factors.push(timelineFactor(lead, weights.timeline));

  // --- contactability: can we actually reach them? ---------------------------
  factors.push(contactabilityFactor(lead, weights.contactability));

  // --- engagement: has the prospect actually interacted? ---------------------
  factors.push(engagementFactor(lead, interactions.c, weights.engagement));

  const total = factors.reduce((sum, f) => sum + f.points, 0);
  const score = Math.max(0, Math.min(100, Math.round(total)));
  const band = bandFor(score);

  return {
    score,
    band,
    factors,
    summary: summarise(score, band, factors),
    computedAt: nowIso(),
    modelVersion: SCORE_MODEL_VERSION,
  };
}

function safeParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/**
 * Convert a 0..1 strength into points against a factor weight, scaled so the
 * whole score lands in 0..100.
 */
function points(strength: number, weight: number): number {
  return Math.round(Math.max(0, Math.min(1, strength)) * weight * 100);
}

function websiteGapFactor(
  analysis: AnalysisRow | undefined,
  opportunities: { code: string }[],
  weight: number,
  hasWebsiteOnRecord: boolean,
): ScoreFactor {
  // "This lead has no website" is a measured fact from the lead record itself;
  // it does not require an analysis run to establish.
  if (!hasWebsiteOnRecord) {
    return {
      code: 'website_gap',
      label: 'Website improvement opportunity',
      weight,
      points: points(0.95, weight),
      rawValue: 'no_website',
      state: 'measured',
      evidence: 'The lead has no website at all - a full site build is a direct fit.',
    };
  }
  if (!analysis) {
    return {
      code: 'website_gap',
      label: 'Website improvement opportunity',
      weight,
      points: 0,
      rawValue: 'unknown',
      state: 'unknown',
      evidence: 'A website is on record but no analysis has been run yet.',
    };
  }
  if (analysis.status === 'no_website') {
    return {
      code: 'website_gap',
      label: 'Website improvement opportunity',
      weight,
      points: points(0.95, weight),
      rawValue: 'no_website',
      state: 'measured',
      evidence: 'The lead has no website at all - a full site build is a direct fit.',
    };
  }
  if (analysis.status !== 'reachable') {
    return {
      code: 'website_gap',
      label: 'Website improvement opportunity',
      weight,
      points: 0,
      rawValue: analysis.status,
      state: 'unknown',
      evidence: `Website could not be analysed (status: ${analysis.status}). No conclusion drawn.`,
    };
  }
  const count = opportunities.length;
  const strength = count === 0 ? 0.15 : count >= 6 ? 1 : 0.3 + count * 0.12;
  return {
    code: 'website_gap',
    label: 'Website improvement opportunity',
    weight,
    points: points(strength, weight),
    rawValue: `${count} opportunity(ies)`,
    state: 'measured',
    evidence:
      count === 0
        ? 'Site is reachable with no obvious gaps flagged from static analysis.'
        : `Static analysis flagged ${count} concrete improvement opportunity(ies).`,
  };
}

function serviceFitFactor(
  lead: LeadRow,
  opportunities: { code: string }[],
  weight: number,
): ScoreFactor {
  const codes = new Set(opportunities.map((o) => o.code));
  // UWS services: website dev, social media, graphic design, Meta ads, AI agents.
  // Map detected gaps to the service that would address them.
  const matched: string[] = [];
  if (!lead.website_host || codes.has('no_https') || codes.has('no_viewport_meta') || codes.has('no_lead_form')) {
    matched.push('website_development');
  }
  if (codes.has('no_portfolio_page') || codes.has('no_contact_page')) matched.push('graphic_design');
  if (codes.has('images_missing_alt') || codes.has('thin_navigation')) matched.push('social_media_management');

  if (!lead.website_host) {
    return {
      code: 'service_fit',
      label: 'Fit with UWS services',
      weight,
      points: points(1, weight),
      rawValue: 'no_website',
      state: 'measured',
      evidence: 'No website on record - website development is a direct match.',
    };
  }
  if (matched.length === 0) {
    return {
      code: 'service_fit',
      label: 'Fit with UWS services',
      weight,
      points: points(0.3, weight),
      rawValue: 'weak_signal',
      state: 'estimated',
      evidence: 'Site is present with no strong signal for the core service lines.',
    };
  }
  return {
    code: 'service_fit',
    label: 'Fit with UWS services',
    weight,
    points: points(0.8, weight),
    rawValue: [...new Set(matched)].join(','),
    state: 'estimated',
    evidence: `Detected signals map to: ${[...new Set(matched)].join(', ')}.`,
  };
}

function budgetFactor(lead: LeadRow, weight: number): ScoreFactor {
  if (lead.budget_state === 'unknown' || lead.budget_minor === null) {
    return {
      code: 'budget',
      label: 'Budget signal',
      weight,
      points: 0,
      rawValue: 'unknown',
      state: 'unknown',
      evidence: 'No budget has been stated or verified for this lead.',
    };
  }
  return {
    code: 'budget',
    label: 'Budget signal',
    weight,
    points: points(BUDGET_POINTS[lead.budget_state] ?? 0, weight),
    rawValue: `${lead.budget_minor} minor (${lead.budget_state})`,
    state: lead.budget_state === 'verified' || lead.budget_state === 'stated' ? 'stated' : 'estimated',
    evidence: `Budget recorded as ${lead.budget_state}. Values are only ever human-supplied, never inferred.`,
  };
}

function timelineFactor(lead: LeadRow, weight: number): ScoreFactor {
  const strength = TIMELINE_POINTS[lead.timeline] ?? 0;
  if (strength === 0) {
    return {
      code: 'timeline',
      label: 'Project timeline',
      weight,
      points: 0,
      rawValue: lead.timeline,
      state: 'unknown',
      evidence: 'No timeline recorded for this lead.',
    };
  }
  return {
    code: 'timeline',
    label: 'Project timeline',
    weight,
    points: points(strength, weight),
    rawValue: lead.timeline,
    state: 'stated',
    evidence: `Timeline recorded as "${lead.timeline}".`,
  };
}

function contactabilityFactor(lead: LeadRow, weight: number): ScoreFactor {
  const channels: string[] = [];
  if (lead.phone_e164) channels.push('phone');
  if (lead.whatsapp_e164) channels.push('whatsapp');
  if (lead.email) channels.push('email');
  if (channels.length === 0) {
    return {
      code: 'contactability',
      label: 'Reachability',
      weight,
      points: 0,
      rawValue: 'none',
      state: 'measured',
      evidence: 'No usable phone, WhatsApp or email on record - the lead cannot be contacted.',
    };
  }
  const strength = channels.length >= 2 ? 1 : 0.6;
  return {
    code: 'contactability',
    label: 'Reachability',
    weight,
    points: points(strength, weight),
    rawValue: channels.join(','),
    state: 'measured',
    evidence: `Usable contact channel(s): ${channels.join(', ')}.`,
  };
}

function engagementFactor(lead: LeadRow, interactionCount: number, weight: number): ScoreFactor {
  if (interactionCount === 0) {
    return {
      code: 'engagement',
      label: 'Prospect engagement',
      weight,
      points: points(INTEREST_POINTS[lead.interest_level] ?? 0, weight),
      rawValue: lead.interest_level,
      state: lead.interest_level === 'unknown' ? 'unknown' : 'stated',
      evidence:
        lead.interest_level === 'unknown'
          ? 'No interaction has been recorded with this lead yet.'
          : `Interest level recorded as "${lead.interest_level}".`,
    };
  }
  return {
    code: 'engagement',
    label: 'Prospect engagement',
    weight,
    points: points(INTEREST_POINTS[lead.interest_level] ?? 0.4, weight),
    rawValue: `${lead.interest_level} (${interactionCount} interactions)`,
    state: 'stated',
    evidence: `${interactionCount} interaction(s) recorded; interest level "${lead.interest_level}".`,
  };
}

function summarise(score: number, band: string, factors: ScoreFactor[]): string {
  const drivers = [...factors]
    .filter((f) => f.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, 3)
    .map((f) => f.label.toLowerCase());
  const gaps = factors.filter((f) => f.state === 'unknown').map((f) => f.label.toLowerCase());
  const parts = [`Score ${score}/100 (${band}).`];
  if (drivers.length > 0) parts.push(`Driven mainly by ${drivers.join(', ')}.`);
  if (gaps.length > 0) parts.push(`Unknown/not yet gathered: ${gaps.join(', ')}.`);
  return parts.join(' ');
}

export interface PersistedScore extends ScoreResult {
  id: string;
  businessId: string;
}

/** Compute and persist a score, writing one row per factor. */
export function recordScore(db: DB, cfg: Config, input: EvidenceInput): PersistedScore {
  const result = computeScore(db, cfg, input);
  const id = newId('scr');
  const inputsSnapshot = {
    businessId: input.businessId,
    modelVersion: result.modelVersion,
    weights: getSetting<ScoringWeights>(db, 'scoring_weights', cfg),
  };

  db.prepare(
    `INSERT INTO lead_scores (id, business_id, score, band, model_version, inputs_json, summary, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.businessId, result.score, result.band, result.modelVersion, JSON.stringify(inputsSnapshot), result.summary, result.computedAt);

  const insertFactor = db.prepare(
    `INSERT INTO score_factors (score_id, code, label, weight, points, raw_value, state, evidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const f of result.factors) {
    insertFactor.run(id, f.code, f.label, f.weight, f.points, f.rawValue, f.state, f.evidence);
  }

  // Project the current score onto the lead row for cheap listing/sorting.
  db.prepare(
    `UPDATE businesses SET score = ?, score_band = ?, score_updated_at = ?, updated_at = ? WHERE id = ?`,
  ).run(result.score, result.band, result.computedAt, result.computedAt, input.businessId);

  return { ...result, id, businessId: input.businessId };
}

export interface StoredScore extends ScoreResult {
  id: string;
  businessId: string;
  factors: ScoreFactor[];
}

/** Latest persisted score with its factors, or null. */
export function latestScore(db: DB, businessId: string): StoredScore | null {
  const row = db
    .prepare(`SELECT id, business_id, score, band, model_version, summary, computed_at FROM lead_scores WHERE business_id = ? ORDER BY computed_at DESC, rowid DESC LIMIT 1`)
    .get(businessId) as
    | { id: string; business_id: string; score: number; band: ScoreResult['band']; model_version: string; summary: string; computed_at: string }
    | undefined;
  if (!row) return null;

  const factorRows = db
    .prepare(`SELECT code, label, weight, points, raw_value, state, evidence FROM score_factors WHERE score_id = ? ORDER BY id`)
    .all(row.id) as unknown as {
    code: string;
    label: string;
    weight: number;
    points: number;
    raw_value: string;
    state: FactorState;
    evidence: string | null;
  }[];

  return {
    id: row.id,
    businessId: row.business_id,
    score: row.score,
    band: row.band,
    modelVersion: row.model_version,
    summary: row.summary,
    computedAt: row.computed_at,
    factors: factorRows.map((f) => ({
      code: f.code,
      label: f.label,
      weight: f.weight,
      points: f.points,
      rawValue: f.raw_value,
      state: f.state,
      evidence: f.evidence,
    })),
  };
}
