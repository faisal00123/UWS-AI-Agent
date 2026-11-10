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
 *     a search request;
 *   - endpoint policy: the configured primary (DISCOVERY_OVERPASS_URL or the
 *     public default) plus optional fallbacks (DISCOVERY_OVERPASS_FALLBACK_URLS).
 *     Only a TRANSPORT-level failure (no HTTP response) falls back — an HTTP
 *     response of any status is authoritative. Failures carry a sanitized
 *     transport category (timeout/dns/tls/refused/reset/unknown) while the
 *     original error stays attached as `cause`;
 *   - `ping()` always probes the configured primary only, so discovery is
 *     never reported healthy unless the actual configured provider answers.
 */
import type { FetchLike } from '../http.ts';
import { classifyTransportError, type TransportCategory } from './transport.ts';
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
  /**
   * Optional fallback interpreter endpoints, tried in order ONLY after a
   * transport-level failure (no HTTP response) of the primary. An HTTP
   * response of any status is authoritative and never falls back. Each
   * candidate must be a credential-free https URL; invalid candidates are
   * dropped and never contacted. Global-coverage instances only — every
   * query this adapter sends is Pakistan-scoped.
   */
  fallbackEndpoints?: string[];
  /**
   * How long (ms) a host that failed at transport level is skipped by
   * searches (0 disables). Health pings deliberately ignore the cooldown so
   * the dashboard always reflects the configured provider's real state.
   * Default: 60_000.
   */
  cooldownMs?: number;
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

/**
 * Validate one endpoint candidate: a credential-free https URL (plain http
 * only on loopback, for local test instances). Returns the normalized URL
 * (trailing slashes removed) on success, or the reason it was rejected.
 */
function validateEndpoint(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed === '') return { ok: false, reason: 'empty URL' };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'credentials embedded in the URL are not allowed' };
  }
  const loopback =
    parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    return { ok: false, reason: 'must be an https URL (plain http only on loopback)' };
  }
  return { ok: true, url: trimmed };
}

/**
 * Hostname of an endpoint — public and non-secret by construction (URLs with
 * embedded credentials never pass validation). Shown in health details so the
 * effective production endpoint can be verified without reading configuration.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown-host';
  }
}

export function createOverpassDiscoveryAdapter(opts: OverpassAdapterOptions = {}): OverpassDiscoveryPort {
  const primaryCheck = validateEndpoint(opts.endpoint ?? DEFAULT_OVERPASS_ENDPOINT);
  const configError = primaryCheck.ok ? null : primaryCheck.reason;

  // Primary first, then configured fallbacks — deduped, each independently
  // validated. An invalid PRIMARY is surfaced honestly as configError (no
  // network at all: a broken configuration must not be silently swapped); an
  // invalid FALLBACK is dropped and never contacted.
  const endpoints: string[] = [];
  const seen = new Set<string>();
  for (const raw of [opts.endpoint ?? DEFAULT_OVERPASS_ENDPOINT, ...(opts.fallbackEndpoints ?? [])]) {
    const check = validateEndpoint(raw);
    if (check.ok && !seen.has(check.url)) {
      seen.add(check.url);
      endpoints.push(check.url);
    }
  }
  const primary = configError === null ? (endpoints[0] ?? '') : '';
  const statusEndpoint =
    primary !== '' && primary.endsWith('/interpreter')
      ? `${primary.slice(0, -'/interpreter'.length)}/status`
      : null;

  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, init) => fetch(u, init));
  const userAgent = opts.userAgent ?? 'UWS-AI-Sales-Agent/0.1 (lead-discovery; OpenStreetMap/Overpass)';

  // Transport-failure cooldown, keyed by HOST (a dead host is dead on every
  // path of that host). Bounded fan-out: a search never re-requests a host
  // that just failed at transport level, and when every candidate is cooling
  // down it fails fast with the last known category instead of waiting out
  // every timeout again. pings ignore the cooldown (health must be honest).
  const cooldownMs = opts.cooldownMs ?? 60_000;
  interface CooldownEntry {
    until: number;
    cat: TransportCategory;
    err: unknown;
  }
  const cooldowns = new Map<string, CooldownEntry>();
  const isCooling = (host: string): boolean => {
    const entry = cooldowns.get(host);
    return cooldownMs > 0 && entry !== undefined && entry.until > Date.now();
  };
  const markDown = (url: string, cat: TransportCategory, err: unknown): void => {
    cooldowns.set(hostOf(url), { until: Date.now() + cooldownMs, cat, err });
  };
  const markUp = (url: string): void => {
    cooldowns.delete(hostOf(url));
  };

  /**
   * Single-endpoint request used by ping(): always the configured primary,
   * cooldown ignored. A transport failure becomes a `network` AdapterError
   * carrying the sanitized category, the effective host, and the original
   * error as `cause`.
   */
  async function request(path: string, body: string | null, timeoutMs: number): Promise<Response> {
    try {
      const res = await fetchImpl(path, {
        method: body === null ? 'GET' : 'POST',
        ...(body !== null
          ? { headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': userAgent } }
          : { headers: { accept: 'text/plain', 'user-agent': userAgent } }),
        ...(body !== null ? { body } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      markUp(path);
      return res;
    } catch (err) {
      const cat = classifyTransportError(err);
      markDown(path, cat, err);
      throw new AdapterError('network', `Could not reach the Overpass API at ${hostOf(path)} (transport: ${cat})`, {
        retryable: true,
        cause: err,
      });
    }
  }

  /**
   * Search request: primary first, then non-cooling fallbacks — the first
   * HTTP response wins and is returned for normal status mapping. Only
   * transport failures fall through to the next endpoint; an HTTP response
   * of any status (429/503/...) is authoritative and never falls back.
   */
  async function requestSearch(body: string, timeoutMs: number): Promise<Response> {
    let tried = 0;
    let lastCat: TransportCategory = 'unknown';
    let lastHost = '';
    let lastErr: unknown;
    for (const url of endpoints) {
      const host = hostOf(url);
      if (isCooling(host)) continue;
      tried += 1;
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': userAgent },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        markUp(url);
        return res;
      } catch (err) {
        lastErr = err;
        lastCat = classifyTransportError(err);
        lastHost = host;
        markDown(url, lastCat, err);
      }
    }
    if (tried === 0) {
      // Every candidate host is inside its cooldown window: fail fast with
      // the last known category rather than stalling on every timeout again.
      const entry = primary !== '' ? cooldowns.get(hostOf(primary)) : undefined;
      throw new AdapterError(
        'network',
        `Could not reach the Overpass API (transport: ${entry?.cat ?? 'unknown'}; endpoint cooling down after a recent transport failure)`,
        { retryable: true, cause: entry?.err },
      );
    }
    throw new AdapterError(
      'network',
      `Could not reach the Overpass API (transport: ${lastCat}) at ${lastHost}${endpoints.length > 1 ? `; ${tried} endpoint(s) tried` : ''}`,
      { retryable: true, cause: lastErr },
    );
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
        // An invalid configured endpoint is a real configuration error, not a
        // silently-swappable one: it is reported as `error` with the reason.
        state: configError === null ? 'configured' : 'error',
        features: [
          'public OpenStreetMap lead search (free, no API key)',
          'Pakistan coverage via the Overpass API',
        ],
        lastError: configError,
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
      if (configError !== null) {
        // Broken endpoint configuration: fail honestly before any network I/O.
        throw new AdapterError('unconfigured', `Discovery endpoint misconfigured: ${configError}`);
      }
      const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
      const query = buildOverpassQuery(terms, q.city?.trim() || undefined, limit);

      const res = await requestSearch(`data=${encodeURIComponent(query)}`, TIMEOUT_MS);
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
      if (configError !== null) {
        // Misconfigured endpoint: honest failure with NO network I/O at all.
        return { ok: false, detail: `Discovery endpoint misconfigured: ${configError}` };
      }
      if (statusEndpoint) {
        // FREE status endpoint: rate-limit info, no query is executed.
        const res = await request(statusEndpoint, null, PING_TIMEOUT_MS);
        if (!res.ok) throw mapHttpError(res.status);
        const body = (await res.text()).slice(0, 2000);
        const limitLine = /rate limit:\s*(.+)/i.exec(body)?.[1]?.trim();
        return {
          ok: true,
          detail: `Overpass API reachable at ${hostOf(statusEndpoint)} (free status probe; no search performed)${limitLine ? ` — rate limit: ${limitLine.slice(0, 60)}` : ''}`,
        };
      }
      // Custom endpoint that is not a standard interpreter URL: fall back to a
      // count-only query (returns a single number; still free of charge).
      const countQuery = `[out:json][timeout:${QUERY_TIMEOUT_S}];node(around:1,0,0)["name"];out count;`;
      const res = await request(primary, `data=${encodeURIComponent(countQuery)}`, PING_TIMEOUT_MS);
      if (!res.ok) throw mapHttpError(res.status);
      return { ok: true, detail: `Overpass endpoint reachable at ${hostOf(primary)} (free count probe; no search performed)` };
    },
  };
}
