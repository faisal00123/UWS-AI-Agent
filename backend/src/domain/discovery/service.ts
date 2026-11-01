/**
 * Lead discovery run service (Phase 12).
 *
 * Consumes the discovery port (OpenStreetMap/Overpass in production, mock in
 * rehearsal) to search public directory data for businesses matching the
 * owner's `discovery_policy` (categories × cities, bounded by maxPerRun) and
 * turns hits into leads through the SAME createLead path as manual entry —
 * so normalisation, duplicate detection, auto-merge and provenance behave
 * identically no matter where a lead came from.
 *
 * Deliberate behaviours:
 *   - one adapter request per city (the adapter unions all category filters
 *     into a single Overpass query — politeness toward a shared public API);
 *   - results are deduplicated within the run (by OSM permalink and by
 *     name+phone) AND against the existing lead base (createLead's duplicate
 *     detection: exact duplicates auto-merge, fuzzy ones land as
 *     pending_review — never silently dropped, never silently trusted);
 *   - every non-merged lead gets an `import`-kind timeline interaction naming
 *     OpenStreetMap + the source permalink, so provenance is auditable;
 *   - autoAnalyze/autoScore from the policy are honoured, bounded to
 *     ANALYZE_CAP_PER_RUN public page fetches — a single bad site never fails
 *     the run (failures are counted and reported);
 *   - a city whose request fails is reported as an error for that city while
 *     other cities continue; if EVERY city fails the run throws honestly
 *     (provider_unavailable) instead of returning a fake-empty result.
 *
 * Safety:
 *   - the discovery integration toggle must be ON (blocked_by_safeguard);
 *   - an unconfigured provider throws provider_unavailable — never fabricated
 *     leads (discovery never invents businesses that OSM did not return);
 *   - this is research on PUBLIC data: it contacts no customer, so it is
 *     allowed in simulation mode, like CSV import. It performs outbound
 *     REACH only to the discovery API and (optionally) a lead's own public
 *     website during autoAnalyze.
 */
import type { DB } from '../../db/index.ts';
import type { Config } from '../../core/config.ts';
import { AppError } from '../../core/errors.ts';
import { nowIso } from '../../core/time.ts';
import { recordAudit } from '../audit/service.ts';
import { isIntegrationEnabled } from '../integrations/service.ts';
import { getSetting } from '../settings/service.ts';
import { createLead } from '../leads/repository.ts';
import { recordInteraction } from '../pipeline/interactions.ts';
import { analyzeWebsite } from '../analysis/service.ts';
import type { FetchOptions as AnalyzeFetchOptions } from '../analysis/fetcher.ts';
import { recordScore } from '../scoring/service.ts';
import type { AdapterRegistry } from '../../adapters/registry.ts';
import type { Actor } from '../state/service.ts';

export interface DiscoveryPolicy {
  categories: string[];
  cities: string[];
  maxPerRun: number;
  autoAnalyze: boolean;
  autoScore: boolean;
}

export function loadDiscoveryPolicy(db: DB, cfg: Config): DiscoveryPolicy {
  return getSetting<DiscoveryPolicy>(db, 'discovery_policy', cfg);
}

export interface DiscoveryRunInput {
  /** Override the policy categories/cities for this run (owner-subset). */
  categories?: string[];
  cities?: string[];
  /** Test seam for the optional auto-analyze step (defaults to real fetch). */
  analyzeFetchOptions?: AnalyzeFetchOptions;
}

export interface DiscoveryCityResult {
  city: string;
  hits: number;
  error: string | null;
}

export interface DiscoveryRunResult {
  provider: string;
  simulated: boolean;
  categories: string[];
  cities: string[];
  maxPerRun: number;
  hits: number;
  created: number;
  pendingReview: number;
  merged: number;
  skipped: number;
  analyzed: number;
  scored: number;
  analyzeFailures: number;
  cityResults: DiscoveryCityResult[];
  startedAt: string;
  finishedAt: string;
}

/** Bound on public-page fetches per run (autoAnalyze) — politeness + time. */
export const ANALYZE_CAP_PER_RUN = 10;

function uniqueTrimmed(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const v = raw.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

export async function runDiscovery(
  db: DB,
  cfg: Config,
  registry: AdapterRegistry,
  input: DiscoveryRunInput,
  actor: Actor,
): Promise<DiscoveryRunResult> {
  // The integration toggle is authoritative: a disabled integration cannot be
  // exercised by a direct API call either.
  if (!isIntegrationEnabled(db, cfg, 'discovery')) {
    throw new AppError(
      'blocked_by_safeguard',
      'Lead discovery is disabled. Enable it on the System page (Integrations) first.',
      { integration: 'discovery' },
    );
  }

  const status = registry.discovery.status();
  if (status.state === 'unconfigured' || status.implementation === null) {
    throw new AppError(
      'provider_unavailable',
      'No lead discovery provider is configured. Set DISCOVERY_PROVIDER=overpass (free OpenStreetMap data, no API key) and restart, or import a CSV/Excel file instead.',
      { integration: 'discovery' },
    );
  }

  const policy = loadDiscoveryPolicy(db, cfg);
  const categories = uniqueTrimmed(input.categories ?? policy.categories).slice(0, 40);
  const cities = uniqueTrimmed(input.cities ?? policy.cities).slice(0, 40);
  if (categories.length === 0) {
    throw new AppError('validation_failed', 'At least one discovery category is required');
  }
  if (cities.length === 0) {
    throw new AppError('validation_failed', 'At least one discovery city is required');
  }

  const startedAt = nowIso();
  const perCityLimit = Math.min(100, policy.maxPerRun);
  const seenSourceUrls = new Set<string>();
  const seenIdentity = new Set<string>();
  const cityResults: DiscoveryCityResult[] = [];

  let hits = 0;
  let created = 0;
  let pendingReview = 0;
  let merged = 0;
  let skipped = 0;
  let analyzed = 0;
  let scored = 0;
  let analyzeFailures = 0;
  let budgetLeft = policy.maxPerRun;

  for (const city of cities) {
    try {
      const cityHits = await registry.discovery.search({
        query: categories.join(', '),
        city,
        country: 'PK',
        limit: perCityLimit,
      });
      hits += cityHits.length;

      for (const hit of cityHits) {
        if (budgetLeft <= 0) {
          skipped += 1;
          continue;
        }
        const identity = `${hit.name.toLowerCase()}|${hit.phone ?? hit.website ?? ''}`;
        if (seenSourceUrls.has(hit.sourceUrl) || seenIdentity.has(identity)) {
          skipped += 1; // same OSM element or same business seen earlier in this run
          continue;
        }
        seenSourceUrls.add(hit.sourceUrl);
        seenIdentity.add(identity);

        const lead = createLead(
          db,
          {
            displayName: hit.name,
            city: hit.city ?? city,
            phone: hit.phone ?? null,
            websiteUrl: hit.website ?? null,
            sourceUrl: hit.sourceUrl,
          },
          // 'directory' is the schema's source_type for public-directory data
          // (OpenStreetMap is exactly that); the provider itself is named in
          // the provenance interaction + audit trail below.
          { userId: actor.userId, label: actor.label, sourceType: 'directory' },
        );

        if (lead.mergedIntoId) merged += 1;
        else if (lead.duplicate) pendingReview += 1;
        else created += 1;
        budgetLeft -= 1;

        if (!lead.mergedIntoId) {
          recordInteraction(db, {
            businessId: lead.id,
            kind: 'import',
            direction: 'internal',
            summary: `Discovered via OpenStreetMap (Overpass) in ${city}`,
            outcome: lead.duplicate ? 'discovered_needs_review' : 'discovered',
            evidence: {
              provider: status.implementation,
              source: 'openstreetmap',
              sourceUrl: hit.sourceUrl,
              categories,
            },
          });

          // autoAnalyze / autoScore from the discovery policy, bounded so one
          // run cannot turn into a web crawler. No website => analysis records
          // an honest `no_website` finding without any network at all.
          if ((policy.autoAnalyze || policy.autoScore) && analyzed < ANALYZE_CAP_PER_RUN) {
            if (policy.autoAnalyze) {
              try {
                await analyzeWebsite(
                  db,
                  { businessId: lead.id, websiteUrl: hit.website ?? null },
                  input.analyzeFetchOptions ?? {},
                );
                analyzed += 1;
              } catch {
                analyzeFailures += 1; // one bad site must not fail the run
              }
            }
            if (policy.autoScore) {
              try {
                recordScore(db, cfg, { businessId: lead.id });
                scored += 1;
              } catch {
                analyzeFailures += 1;
              }
            }
          }
        }
      }

      cityResults.push({ city, hits: cityHits.length, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 200) : 'discovery search failed';
      cityResults.push({ city, hits: 0, error: message });
    }
  }

  const failedCities = cityResults.filter((c) => c.error !== null);
  if (failedCities.length === cityResults.length && cityResults.length > 0) {
    throw new AppError(
      'provider_unavailable',
      `Lead discovery failed for every city. Last error: ${failedCities[failedCities.length - 1]!.error}`,
      { cities: failedCities },
    );
  }

  const finishedAt = nowIso();
  recordAudit(db, {
    actorUserId: actor.userId,
    actorLabel: actor.label,
    action: 'discovery.run',
    entityType: 'discovery',
    entityId: status.implementation,
    summary:
      `Discovery run via ${status.implementation}: ${hits} hit(s) — ${created} new, ` +
      `${pendingReview} need review, ${merged} merged, ${skipped} skipped` +
      (failedCities.length > 0 ? `, ${failedCities.length} city error(s)` : ''),
    details: { categories, cities: cityResults, maxPerRun: policy.maxPerRun },
  });

  return {
    provider: status.implementation,
    simulated: status.simulated === true,
    categories,
    cities,
    maxPerRun: policy.maxPerRun,
    hits,
    created,
    pendingReview,
    merged,
    skipped,
    analyzed,
    scored,
    analyzeFailures,
    cityResults,
    startedAt,
    finishedAt,
  };
}
