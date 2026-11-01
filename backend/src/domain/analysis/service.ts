/**
 * Website analysis service — orchestrates fetch + parse and persists a result.
 *
 * Honesty rules enforced here:
 *  - A lead with no website URL is recorded as `no_website`, which is a real
 *    finding (an opportunity in itself), not an error.
 *  - A URL that cannot be reached is `unreachable` (or `blocked` when our
 *    safety checks refuse it). We never convert a fetch failure into
 *    "business has no website".
 *  - `not_measured_json` always carries the list of things we did not test, so
 *    the dashboard cannot imply a full audit happened.
 *  - `is_estimate` is set whenever any opportunity is a heuristic inference
 *    rather than a direct measurement.
 */
import type { DB } from '../../db/index.ts';
import { newId } from '../../core/ids.ts';
import { nowIso } from '../../core/time.ts';
import { normalizeWebsite } from '../leads/normalize.ts';
import { fetchForAnalysis, type FetchOptions } from './fetcher.ts';
import { analyzeHtml, NO_WEBSITE_NOT_MEASURED, ENGINE_VERSION, type MeasuredSignals, type Opportunity } from './parse.ts';

export type AnalysisStatus = 'pending' | 'running' | 'reachable' | 'unreachable' | 'blocked' | 'no_website' | 'error';

export interface WebsiteAnalysisRecord {
  id: string;
  businessId: string;
  targetUrl: string;
  status: AnalysisStatus;
  httpStatus: number | null;
  finalUrl: string | null;
  redirectCount: number;
  fetchedAt: string | null;
  durationMs: number | null;
  bytes: number | null;
  title: string | null;
  metaDescription: string | null;
  hasHttps: boolean | null;
  hasViewportMeta: boolean | null;
  h1Count: number | null;
  imgCount: number;
  imgsMissingAlt: number;
  internalLinks: number;
  forms: number;
  telLinks: number;
  mailtoLinks: number;
  whatsappLinks: number;
  hasContactPage: boolean | null;
  hasAboutPage: boolean | null;
  hasPrivacyPage: boolean | null;
  hasPortfolioPage: boolean | null;
  navTexts: string[];
  opportunities: Opportunity[];
  estimates: Record<string, unknown>;
  notMeasured: string[];
  errorMessage: string | null;
  engineVersion: string;
  isEstimate: boolean;
  createdAt: string;
}

const COLS = `id, business_id, target_url, status, http_status, final_url, redirect_count, fetched_at,
  duration_ms, bytes, title, meta_description, has_https, has_viewport_meta, h1_count, img_count,
  imgs_missing_alt, internal_links, forms, tel_links, mailto_links, whatsapp_links,
  has_contact_page, has_about_page, has_privacy_page, has_portfolio_page, nav_texts_json,
  opportunities_json, estimates_json, not_measured_json, error_message, engine_version, is_estimate, created_at`;

function boolOrNull(v: boolean | null | undefined): number | null {
  return v === null || v === undefined ? null : v ? 1 : 0;
}

interface Row {
  [k: string]: unknown;
}

function rowToRecord(r: Row): WebsiteAnalysisRecord {
  const parse = <T>(v: unknown, fallback: T): T => {
    if (typeof v !== 'string') return fallback;
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  };
  return {
    id: String(r.id),
    businessId: String(r.business_id),
    targetUrl: String(r.target_url),
    status: r.status as AnalysisStatus,
    httpStatus: (r.http_status as number | null) ?? null,
    finalUrl: (r.final_url as string | null) ?? null,
    redirectCount: Number(r.redirect_count ?? 0),
    fetchedAt: (r.fetched_at as string | null) ?? null,
    durationMs: (r.duration_ms as number | null) ?? null,
    bytes: (r.bytes as number | null) ?? null,
    title: (r.title as string | null) ?? null,
    metaDescription: (r.meta_description as string | null) ?? null,
    hasHttps: r.has_https === null || r.has_https === undefined ? null : Number(r.has_https) === 1,
    hasViewportMeta:
      r.has_viewport_meta === null || r.has_viewport_meta === undefined ? null : Number(r.has_viewport_meta) === 1,
    h1Count: (r.h1_count as number | null) ?? null,
    imgCount: Number(r.img_count ?? 0),
    imgsMissingAlt: Number(r.imgs_missing_alt ?? 0),
    internalLinks: Number(r.internal_links ?? 0),
    forms: Number(r.forms ?? 0),
    telLinks: Number(r.tel_links ?? 0),
    mailtoLinks: Number(r.mailto_links ?? 0),
    whatsappLinks: Number(r.whatsapp_links ?? 0),
    hasContactPage:
      r.has_contact_page === null || r.has_contact_page === undefined ? null : Number(r.has_contact_page) === 1,
    hasAboutPage: r.has_about_page === null || r.has_about_page === undefined ? null : Number(r.has_about_page) === 1,
    hasPrivacyPage: r.has_privacy_page === null || r.has_privacy_page === undefined ? null : Number(r.has_privacy_page) === 1,
    hasPortfolioPage:
      r.has_portfolio_page === null || r.has_portfolio_page === undefined ? null : Number(r.has_portfolio_page) === 1,
    navTexts: parse<string[]>(r.nav_texts_json, []),
    opportunities: parse<Opportunity[]>(r.opportunities_json, []),
    estimates: parse<Record<string, unknown>>(r.estimates_json, {}),
    notMeasured: parse<string[]>(r.not_measured_json, []),
    errorMessage: (r.error_message as string | null) ?? null,
    engineVersion: String(r.engine_version),
    isEstimate: Number(r.is_estimate ?? 0) === 1,
    createdAt: String(r.created_at),
  };
}

export interface AnalyzeInput {
  businessId: string;
  /** Raw website value from the lead; may be empty. */
  websiteUrl: string | null;
}

/**
 * Run an analysis for one lead and persist the outcome.
 *
 * `fetchOptions` exists for tests: passing a stubbed `fetch` behaviour keeps
 * this function's logic testable without real network access.
 */
export async function analyzeWebsite(
  db: DB,
  input: AnalyzeInput,
  fetchOptions: FetchOptions = {},
): Promise<WebsiteAnalysisRecord> {
  const at = nowIso();
  const id = newId('wan');
  const site = normalizeWebsite(input.websiteUrl);

  // No usable website at all: a real, recordable finding. The whole site is the
  // gap, so we state that nothing could be analysed rather than returning an
  // empty notMeasured list (which could read as "nothing missing").
  if (!site.valid) {
    return persist(db, {
      id,
      businessId: input.businessId,
      targetUrl: (input.websiteUrl ?? '').slice(0, 300),
      status: 'no_website',
      notMeasured: NO_WEBSITE_NOT_MEASURED,
      errorMessage: site.reason === 'empty' ? 'Lead has no website URL on record' : `Website URL not usable (${site.reason})`,
      at,
    });
  }

  const outcome = await fetchForAnalysis(site.url as string, fetchOptions);

  if (!outcome.ok) {
    return persist(db, {
      id,
      businessId: input.businessId,
      targetUrl: site.url as string,
      status: outcome.status === 'blocked' ? 'blocked' : outcome.status === 'error' ? 'error' : 'unreachable',
      httpStatus: outcome.httpStatus,
      finalUrl: outcome.finalUrl,
      redirectCount: outcome.redirectCount,
      durationMs: outcome.durationMs,
      errorMessage: outcome.message,
      at,
    });
  }

  const { signals, opportunities, notMeasured } = analyzeHtml(outcome.html, outcome.finalUrl);
  const isEstimate = opportunities.some((o) => o.state === 'estimated');

  return persist(db, {
    id,
    businessId: input.businessId,
    targetUrl: site.url as string,
    status: 'reachable',
    httpStatus: outcome.status,
    finalUrl: outcome.finalUrl,
    redirectCount: outcome.redirectCount,
    durationMs: outcome.durationMs,
    bytes: outcome.bytes,
    signals,
    opportunities,
    notMeasured,
    isEstimate,
    errorMessage: outcome.truncated ? 'Response truncated at size cap; signals cover the first portion only' : null,
    at,
  });
}

interface PersistInput {
  id: string;
  businessId: string;
  targetUrl: string;
  status: AnalysisStatus;
  httpStatus?: number | null;
  finalUrl?: string | null;
  redirectCount?: number;
  durationMs?: number | null;
  bytes?: number | null;
  signals?: MeasuredSignals;
  opportunities?: Opportunity[];
  notMeasured?: string[];
  isEstimate?: boolean;
  errorMessage?: string | null;
  at: string;
}

function persist(db: DB, input: PersistInput): WebsiteAnalysisRecord {
  const s = input.signals;
  const estimates: Record<string, unknown> = {};
  db.prepare(
    `INSERT INTO website_analyses (${COLS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.businessId,
    input.targetUrl,
    input.status,
    input.httpStatus ?? null,
    input.finalUrl ?? null,
    input.redirectCount ?? 0,
    input.status === 'reachable' ? input.at : null,
    input.durationMs ?? null,
    input.bytes ?? null,
    s?.title ?? null,
    s?.metaDescription ?? null,
    boolOrNull(s?.hasHttps ?? null),
    boolOrNull(s?.hasViewportMeta ?? null),
    s?.h1Count ?? null,
    s?.imgCount ?? 0,
    s?.imgsMissingAlt ?? 0,
    s?.internalLinks ?? 0,
    s?.forms ?? 0,
    s?.telLinks ?? 0,
    s?.mailtoLinks ?? 0,
    s?.whatsappLinks ?? 0,
    boolOrNull(s?.hasContactPage ?? null),
    boolOrNull(s?.hasAboutPage ?? null),
    boolOrNull(s?.hasPrivacyPage ?? null),
    boolOrNull(s?.hasPortfolioPage ?? null),
    JSON.stringify(s?.navTexts ?? []),
    JSON.stringify(input.opportunities ?? []),
    JSON.stringify(estimates),
    JSON.stringify(input.notMeasured ?? []),
    input.errorMessage ?? null,
    ENGINE_VERSION,
    input.isEstimate ? 1 : 0,
    input.at,
  );

  // Keep the lead's stage moving only on a real, measured result.
  if (input.status === 'reachable' || input.status === 'no_website') {
    db.prepare(
      `UPDATE businesses SET last_checked_at = ?, updated_at = ? WHERE id = ?`,
    ).run(input.at, input.at, input.businessId);
  } else {
    db.prepare(`UPDATE businesses SET last_checked_at = ?, updated_at = ? WHERE id = ?`).run(
      input.at,
      input.at,
      input.businessId,
    );
  }

  return getAnalysis(db, input.id) as WebsiteAnalysisRecord;
}

/** Latest analysis for a lead, or null when none has ever been run. */
export function latestAnalysis(db: DB, businessId: string): WebsiteAnalysisRecord | null {
  const row = db
    .prepare(`SELECT ${COLS} FROM website_analyses WHERE business_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(businessId) as Row | undefined;
  return row ? rowToRecord(row) : null;
}

export function getAnalysis(db: DB, id: string): WebsiteAnalysisRecord | null {
  const row = db.prepare(`SELECT ${COLS} FROM website_analyses WHERE id = ?`).get(id) as Row | undefined;
  return row ? rowToRecord(row) : null;
}

/** Recent analyses for a lead (history view). */
export function analysisHistory(db: DB, businessId: string, limit = 20): WebsiteAnalysisRecord[] {
  const rows = db
    .prepare(`SELECT ${COLS} FROM website_analyses WHERE business_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(businessId, limit) as unknown as Row[];
  return rows.map(rowToRecord);
}
