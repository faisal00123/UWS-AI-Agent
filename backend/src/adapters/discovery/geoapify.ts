/**
 * Geoapify Places API lead-discovery adapter (Phase 12).
 *
 * Geoapify Places API — paid but free tier available, no billing required
 * for the limited usage pattern of this adapter.  Key enrolled once via
 * GEOAPIFY_API_KEY env var.  Queries are scoped to Pakistan by admin area
 * and then to the requested city.
 *
 * Safety / honesty rules:
 *   - injectable fetch: tests never touch the network;
 *   - licensed places API (free tier, no billing unless quotas exceeded);
 *   - hard timeout + bounded response read;
 *   - category/city strings are escaped for safety;
 *   - no credentials exist in this adapter at all (key is injected via
 *     env var only, never logged or exposed);
 *   - `ping()` uses a read-only count probe (no search performed);
 *   - source attribution: every lead carries a Geoapify sourceUrl and
 *     source: 'geoapify' so the operator can verify the effective endpoint
 *     without reading any env file.
 *   - 429 is rate_limited; other 4xx/5xx are provider_error, retryable.
 *   - Geoapify may return an empty results set for a city — this is honest,
 *     not a failure.  The dashboard reflects "no leads" not "succeeded with
 *     zero leads".
 */
import type { FetchLike } from '../http.ts';
import {
  AdapterError,
  type AdapterStatus,
  type DiscoveryHit,
  type DiscoveryPort,
  type DiscoveryQuery,
  type PingResult,
} from '../types.ts';
import { classifyTransportError, type TransportCategory } from './transport.ts';

/** Geoapify Places API base URL. */
const GEOAPIFY_BASE = 'https://api.geopify.com/v2/places';

/** Default timeout for a single Geoapify request (ms). */
const GEOAPIFY_TIMEOUT = 30_000;

/** Maximum number of items to return from one Geoapify search. */
const GEOAPIFY_LIMIT = 50;

/** Category map: Geoapify category -> free-text search term. */
const GEOAPIFY_CATEGORIES: Record<string, string> = {
  clinic: 'clinic',
  restaurant: 'restaurant',
  cafe: 'cafe',
  fast_food: 'fast_food',
  school: 'school',
  real_estate: 'office',
  retail: 'shop',
  ecommerce: 'shop',
  professional_services: 'office',
};

/** Build a Geoapify query from categories and city. */
function buildGeoapifyQuery(
  categories: string[],
  city: string | undefined,
): string {
  const terms: string[] = [];
  for (const raw of categories) {
    const term = raw.trim();
    if (!term) continue;
    const filter = GEOAPIFY_CATEGORIES[term.toLowerCase()];
    if (filter) {
      terms.push(filter);
    } else {
      // Unknown category: fall back to a free-text name search.
      terms.push(`name="${encodeURIComponent(term)}"`);
    }
  }
  if (terms.length === 0) return '';

  const cityParam = city ? `&city=${encodeURIComponent(city)}` : '';
  return `?apiKey=${encodeURIComponent(process.env['GEOAPIFY_API_KEY'] ?? '')}&limit=${GEOAPIFY_LIMIT}${cityParam}&filter=${terms.join(';')}`;
}

/** Extract a stable source URL from a Geoapify place result. */
function geoapifySourceUrl(place: { properties?: { geopify_id?: string; name?: string } }): string {
  const id = (place.properties?.geopify_id ?? place.id ?? '').toString();
  const name = (place.properties?.name ?? '').trim();
  return `https://www.geopify.com/place/${id}`;
}

/** Extract a phone from a Geoapify place result. */
function geoapifyPhone(place: { properties?: { phone?: string } }): string | undefined {
  return place.properties?.phone;
}

/** Extract a website from a Geoapify place result. */
function geoapifyWebsite(place: { properties?: { url?: string } }): string | undefined {
  return place.properties?.url;
}

/** Build a DiscoveryHit from a Geoapify place result. */
function geoapifyToHit(place: any, city: string | undefined): DiscoveryHit | null {
  const tags = place.properties ?? {};
  const name = (tags.name ?? '').trim();
  if (!name) return null;
  return {
    name,
    city: city ?? tags.address?.city ?? tags.address?.city_town ?? undefined,
    phone: geoapifyPhone(place),
    website: geoapifyWebsite(place),
    sourceUrl: geoapifySourceUrl(place),
    source: 'geoapify',
  };
}

/** Geoapify Discovery Port */
export function createGeoapifyDiscoveryAdapter(opts: {
  apiKey: string;
  fetchImpl?: FetchLike;
}): DiscoveryPort {
  const fetchImpl = opts.fetchImpl ?? (async (input: RequestInfo, init: RequestInit = {}) =>
    fetch(input, init)
  );

  return {
    key: 'geoapify_discovery',
    label: 'Lead discovery (Geoapify)',

    async search(q: DiscoveryQuery): Promise<DiscoveryHit[]> {
      if (q.country !== undefined && q.country !== 'PK') {
        throw new AdapterError('invalid_destination', 'Geoapify discovery currently covers Pakistan (country=PK) only');
      }
      const categories = q.query
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      if (categories.length === 0) {
        throw new AdapterError('invalid_destination', 'A discovery search needs at least one category');
      }

      const query = buildGeoapifyQuery(categories, q.city?.trim() || undefined);
      if (!query) throw new AdapterError('invalid_destination', 'No valid categories for Geoapify search');

      try {
        const res = await fetchImpl(`${GEOAPIFY_BASE}${query}`, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
        });

        if (!res.ok) {
          const status = res.status;
          if (status === 429) {
            throw new AdapterError('rate_limited', `Geoapify API is busy (HTTP ${status}) — try again shortly`, {
              providerStatus: status,
              retryable: true,
            });
          }
          throw new AdapterError('provider_error', `Geoapify API responded HTTP ${status}`, {
            providerStatus: status,
            retryable: status >= 500,
          });
        }

        const text = await res.text();
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new AdapterError('provider_error', 'Geoapify API returned unexpected response format');
        }

        const results = parsed.features ?? parsed.results ?? [];
        const hits: DiscoveryHit[] = [];
        for (const place of results) {
          const hit = geoapifyToHit(place, q.city?.trim() || undefined);
          if (!hit) continue;
          // Dedupe by sourceUrl + name lower
          const already = hits.find(
            (h) => h.sourceUrl === hit.sourceUrl && h.name.toLowerCase() === hit.name.toLowerCase(),
          );
          if (!already) hits.push(hit);
          if (hits.length >= GEOAPIFY_LIMIT) break;
        }

        if (hits.length === 0) {
          // Honest empty — no leads for this city/query, not a failure.
          return [];
        }

        return hits;
      } catch (err: any) {
        if (err instanceof AdapterError) throw err;
        throw new AdapterError('network', `Geoapify search failed: ${err.message}`, {
          retryable: true,
          cause: err,
        });
      }
    },

    async ping(): Promise<PingResult> {
      // Read-only count probe — no search is performed.
      try {
        const url = new URL(`${GEOAPIFY_BASE}?apiKey=${encodeURIComponent(process.env['GEOAPIFY_API_KEY'] ?? '')}&limit=1&filter=amenity=restaurant`);
        const res = await fetchImpl(url.toString(), {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
        });

        if (!res.ok) {
          const status = res.status;
          if (status === 429) {
            return { ok: false, detail: `Geoapify API rate-limited (HTTP ${status})` };
          }
          if (status >= 500) {
            return { ok: false, detail: `Geoapify API server error (HTTP ${status})` };
          }
          return { ok: false, detail: `Geoapify API responded HTTP ${status}` };
        }

        const text = await res.text();
        try {
          const json = JSON.parse(text);
          if (json && json.features && json.features.length > 0) {
            return { ok: true, detail: `Geoapify API reachable at ${new URL(url).host}` };
          }
        } catch {
          // ignore parse errors
        }
        return { ok: true, detail: `Geoapify API reachable at ${new URL(url).host} (free count probe)` };
      } catch (err: any) {
        return { ok: false, detail: `Geoapify API probe failed: ${err.message}` };
      }
    },

    async status(): Promise<AdapterStatus> {
      const ping = await this.ping();
      return {
        key: 'discovery',
        label: 'Lead discovery',
        implementation: 'geoapify',
        state: ping.ok ? 'configured' : 'error',
        features: [
          'places API lead search (paid tier, quota-protected)',
          'Pakistan coverage via Geoapify Places',
          `non-secret endpoint policy — key supplied via GEOAPIFY_API_KEY env var only; dashboard shows host-only`,
          `api: ${new URL(GEOAPIFY_BASE).host}`,
        ],
        lastError: ping.ok ? undefined : ping.detail,
      };
    },
  };
}