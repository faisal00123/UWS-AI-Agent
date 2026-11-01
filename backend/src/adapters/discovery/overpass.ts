/**
 * OpenStreetMap / Overpass lead-discovery adapter (Phase 12).
 *
 * The owner selected OpenStreetMap as the discovery vendor: public OSM data
 * served by the free Overpass API — NO API key, NO billing account, NO terms
 * of a paid vendor. Coverage in Pakistan is decent for named businesses with
 * a public phone (clinics, restaurants, schools, offices, shops); it is
 * thinner than Google Places, and the dashboard says so honestly.
 *
 * How a search works:
 *   - one Overpass QL request per city, unioning tag filters for every
 *     requested category (politeness: a run of 8 cities is 8 requests, not
 *     56 — the Overpass API is a shared public resource);
 *   - the query is scoped to Pakistan's OSM area (relation 1417706 → area
 *     360001417706), narrowed to the city's administrative area when a city
 *     is given;
 *   - each element with a name becomes a DiscoveryHit; phone/website come
 *     from OSM contact tags; `sourceUrl` is the public OSM permalink so every
 *     discovered lead is auditable back to its source.
 *
 * Safety / honesty rules:
 *   - injectable fetch: tests never touch the network;
 *   - fixed https endpoint (default overpass-api.de, overridable for a
 *     self-hosted instance via DISCOVERY_OVERPASS_URL);
 *   - hard timeout + bounded response read;
 *   - category/city strings are escaped for Overpass QL so a hostile setting
 *     value can never inject query clauses (defense in depth — settings are
 *     owner-set, but the boundary is enforced anyway);
 *   - no credentials exist in this adapter at all, and error details are
 *     short and redaction-safe;
 *   - `ping()` uses the FREE `/api/status` endpoint (rate-limit info), never
 *     a search request.
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

/** OSM relation 1417706 = Pakistan; Overpass area id = relation + 3600000000. */
export const PAKISTAN_AREA_ID = 360001417706;

export const DEFAULT_OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

const TIMEOUT_MS = 30_000;
const PING_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // a bounded prefix; OSM responses are small
const QUERY_TIMEOUT_S = 25;

/** One tag filter: [key, value] exact, or [key, '*'] any-value, or [key, '~', regex, flags]. */
type TagFilter = [string, string] | [string, '~', string, string];

const CATEGORY_FILTERS: Record<string, TagFilter[]> = {
  clinic: [
    ['amenity', 'clinic'],
    ['healthcare', 'clinic'],
  ],
  restaurant: [
    ['amenity', 'restaurant'],
    ['amenity', 'cafe'],
    ['amenity', 'fast_food'],
  ],
  school: [['amenity', 'school']],
  real_estate: [['office', 'estate_agent']],
  retail: [['shop', '*']],
  ecommerce: [['shop', '*']],
  professional_services: [['office', '*']],
};

/** Escape a value for an Overpass QL string literal (exact match). */
function escapeQl(value: string): string {
  return value
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .trim();
}

/** Escape a category term for use as a case-insensitive name regex. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\u0000-\u001f]/g, ' ').trim();
}

function filterToQl(f: TagFilter): string {
  if (f.length === 4 && f[1] === '~') return `["${escapeQl(f[0])}"~"${escapeQl(f[2])}",${f[3] === 'i' ? 'i' : ''}]`;
  if (f[1] === '*') return `["${escapeQl(f[0])}"]`;
  return `["${escapeQl(f[0])}"="${escapeQl(f[1])}"]`;
}

/**
 * Build the Overpass QL for one city. Exported for direct unit assertion —
 * the query is the security- and politeness-sensitive core of this adapter.
 */
export function buildOverpassQuery(categories: string[], city: string | undefined, limit: number): string {
  const areaLine = `area(${PAKISTAN_AREA_ID})->.pk;`;
  const cityLine = city
    ? `area["name"="${escapeQl(city)}"](area.pk)->.city;`
    : '';
  const scope = city ? 'area.city' : 'area.pk';

  const seen = new Set<string>();
  const clauses: string[] = [];
  for (const raw of categories) {
    const term = raw.trim();
    if (!term) continue;
    const known = CATEGORY_FILTERS[term.toLowerCase()];
    const filters: TagFilter[] = known ?? [['name', '~', escapeRegex(term), 'i']];
    for (const f of filters) {
      const key = JSON.stringify(f);
      if (seen.has(key)) continue;
      seen.add(key);
      // node + way: businesses are mapped as points or as building outlines.
      clauses.push(`node${filterToQl(f)}(${scope});`);
      clauses.push(`way${filterToQl(f)}(${scope});`);
    }
  }

  const capped = Math.min(Math.max(limit, 1), 100);
  return [
    `[out:json][timeout:${QUERY_TIMEOUT_S}];`,
    areaLine,
    cityLine,
    '(',
    ...clauses,
    ');',
    // `center` gives way elements a coordinate; the trailing number caps the
    // result set server-side so a broad query cannot return the whole city.
    `out center ${capped};`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

interface OverpassElement {
  type?: string;
  id?: number;
  tags?: Record<string, string>;
}

function elementToHit(el: OverpassElement, city: string | undefined): DiscoveryHit | null {
  const tags = el.tags ?? {};
  const name = (tags['name'] ?? '').trim();
  if (!name || el.id === undefined || !el.type) return null;
  const phone =
    tags['contact:phone'] ?? tags['phone'] ?? tags['contact:mobile'] ?? tags['mobile'] ?? undefined;
  const website = tags['website'] ?? tags['contact:website'] ?? undefined;
  return {
    name,
    city: city ?? tags['addr:city'] ?? undefined,
    phone: phone?.trim() || undefined,
    website: website?.trim() || undefined,
    sourceUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    source: 'openstreetmap',
  };
}

export interface OverpassAdapterOptions {
  fetchImpl?: FetchLike;
  /** Override the interpreter endpoint (self-hosted Overpass instance). */
  endpoint?: string;
  /** User-Agent sent with every request (Overpass etiquette asks to identify). */
  userAgent?: string;
}

/**
 * The Overpass adapter ALWAYS provides `ping()` (a free status probe), so the
 * factory's return type narrows the optional `ping` on the port to required.
 */
export interface OverpassDiscoveryPort extends DiscoveryPort {
  ping(): Promise<PingResult>;
}

export function createOverpassDiscoveryAdapter(opts: OverpassAdapterOptions = {}): OverpassDiscoveryPort {
  const endpoint = (opts.endpoint ?? DEFAULT_OVERPASS_ENDPOINT).replace(/\/+$/, '');
  const statusEndpoint = endpoint.endsWith('/interpreter')
    ? `${endpoint.slice(0, -'/interpreter'.length)}/status`
    : null;
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, init) => fetch(u, init));
  const userAgent = opts.userAgent ?? 'UWS-AI-Sales-Agent/0.1 (lead-discovery; OpenStreetMap/Overpass)';

  async function request(path: string, body: string | null, timeoutMs: number): Promise<Response> {
    try {
      return await fetchImpl(path, {
        method: body === null ? 'GET' : 'POST',
        ...(body !== null
          ? { headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': userAgent } }
          : { headers: { accept: 'text/plain', 'user-agent': userAgent } }),
        ...(body !== null ? { body } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new AdapterError('network', 'Could not reach the Overpass API', { retryable: true, cause: err });
    }
  }

  function mapHttpError(status: number): AdapterError {
    if (status === 429 || status === 504) {
      return new AdapterError('rate_limited', `Overpass API is busy (HTTP ${status}) — try again shortly`, {
        providerStatus: status,
        retryable: true,
      });
    }
    return new AdapterError('provider_error', `Overpass API responded HTTP ${status}`, {
      providerStatus: status,
      retryable: status >= 500,
    });
  }

  return {
    key: 'overpass_discovery',
    label: 'Lead discovery (OpenStreetMap)',

    status(): AdapterStatus {
      return {
        key: 'discovery',
        label: 'Lead discovery',
        implementation: 'overpass',
        state: 'configured',
        features: [
          'public OpenStreetMap lead search (free, no API key)',
          'Pakistan coverage via the Overpass API',
        ],
        lastError: null,
      };
    },

    async search(q: DiscoveryQuery): Promise<DiscoveryHit[]> {
      if (q.country !== undefined && q.country !== 'PK') {
        throw new AdapterError('invalid_destination', 'OpenStreetMap discovery currently covers Pakistan (country=PK) only');
      }
      const terms = q.query
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      if (terms.length === 0) {
        throw new AdapterError('invalid_destination', 'A discovery search needs at least one category');
      }
      const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
      const query = buildOverpassQuery(terms, q.city?.trim() || undefined, limit);

      const res = await request(endpoint, `data=${encodeURIComponent(query)}`, TIMEOUT_MS);
      if (!res.ok) throw mapHttpError(res.status);

      const text = (await res.text()).slice(0, MAX_RESPONSE_BYTES);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new AdapterError('provider_error', 'Overpass API returned an unexpected response format');
      }
      const elements = (parsed as { elements?: unknown }).elements;
      if (!Array.isArray(elements)) {
        throw new AdapterError('provider_error', 'Overpass API response has no elements list');
      }

      const out: DiscoveryHit[] = [];
      const seenSources = new Set<string>();
      const seenIdentity = new Set<string>();
      for (const raw of elements) {
        const hit = elementToHit(raw as OverpassElement, q.city?.trim() || undefined);
        if (!hit) continue;
        if (seenSources.has(hit.sourceUrl)) continue;
        // Same business tagged with two of our category filters arrives twice.
        const identity = `${hit.name.toLowerCase()}|${hit.phone ?? hit.website ?? ''}`;
        if (seenIdentity.has(identity)) continue;
        seenSources.add(hit.sourceUrl);
        seenIdentity.add(identity);
        out.push(hit);
        if (out.length >= limit) break;
      }
      return out;
    },

    async ping(): Promise<PingResult> {
      if (statusEndpoint) {
        // FREE status endpoint: rate-limit info, no query is executed.
        const res = await request(statusEndpoint, null, PING_TIMEOUT_MS);
        if (!res.ok) throw mapHttpError(res.status);
        const body = (await res.text()).slice(0, 2000);
        const limitLine = /rate limit:\s*(.+)/i.exec(body)?.[1]?.trim();
        return {
          ok: true,
          detail: `Overpass API reachable (free status probe; no search performed)${limitLine ? ` — rate limit: ${limitLine.slice(0, 60)}` : ''}`,
        };
      }
      // Custom endpoint that is not a standard interpreter URL: fall back to a
      // count-only query (returns a single number; still free of charge).
      const countQuery = `[out:json][timeout:${QUERY_TIMEOUT_S}];node(around:1,0,0)["name"];out count;`;
      const res = await request(endpoint, `data=${encodeURIComponent(countQuery)}`, PING_TIMEOUT_MS);
      if (!res.ok) throw mapHttpError(res.status);
      return { ok: true, detail: 'Overpass endpoint reachable (free count probe; no search performed)' };
    },
  };
}
