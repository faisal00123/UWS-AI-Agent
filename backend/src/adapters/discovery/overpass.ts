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
 *   - the query is scoped to Pakistan's OSM area (relation 307573 → area
 *     3600307573), narrowed to the city's administrative area when a city
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
 *     Exactly two kinds of failure move on to the next endpoint: a TRANSPORT
 *     failure (no HTTP response at all) and a GATEWAY/availability failure
 *     (HTTP 502/503/504), where the endpoint's own infrastructure never
 *     produced an answer. Every other HTTP response (2xx, 4xx, 429, 500) IS an
 *     answer from a working endpoint and stays authoritative — it is never
 *     swapped for another host. Failures carry a sanitized category
 *     (`transport: timeout/dns/tls/refused/reset/unknown` or `HTTP 504`)
 *     while the original error stays attached as `cause`;
 *   - a capacity answer (502/503) is first retried on the SAME endpoint with
 *     bounded exponential backoff — that is what the Overpass API itself asks
 *     callers to do — and only then does the walk move on. A transport
 *     failure or a 504 is never retried in place (the wait was already paid),
 *     so a dead endpoint can never turn into a request storm;
 *   - cooldown is keyed PER HOST: one endpoint cooling down never hides a
 *     healthy alternative, and a host that answers again is immediately
 *     marked healthy;
 *   - `ping()` walks the SAME configured pool as search() (ignoring the
 *     cooldown), so discovery is never reported healthy when a configured
 *     endpoint that would have to serve a search is actually broken;
 *   - 504 is a GATEWAY timeout, not rate limiting: it is never classified as
 *     `rate_limited` and never reported as "busy — try again shortly".
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

/**
 * Overpass area id for PAKISTAN = OSM relation id + 3600000000.
 *
 * Relation **307573** is Pakistan (Nominatim: "پاکستان", osm_type=relation,
 * osm_id=307573, admin_level=2, ISO3166-1=PK), so the area id is
 * 3600000000 + 307573 = 3600307573.
 *
 * The previously used relation, 1417706, is NOT Pakistan: it is a small
 * `natural=wood` multipolygon (source NRCan-CanVec, 51 members). Scoping
 * every query to that area made Overpass answer honestly with HTTP 200 and
 * `elements: []` for every city — discovery "succeeded" and returned zero
 * leads, which is worse than a loud failure. Verified live against the
 * public Overpass API after the correction:
 *   area(3600307573) tags -> ISO3166-1: PK, admin_level: 2
 *   node["amenity"="restaurant"](area.pk) out count -> 5135 (was 0)
 */
export const PAKISTAN_AREA_ID = 3600307573;

export const DEFAULT_OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

/**
 * Public Overpass mirrors used as fallbacks when the owner has NOT set
 * DISCOVERY_OVERPASS_FALLBACK_URLS (setting it replaces this list entirely).
 *
 * Every entry was validated before being added here with a live, READ-ONLY
 * GET of its free `/api/status` endpoint — that probe executes no query and
 * writes nothing. Results at the time of writing: maps.mail.ru answered 3/3,
 * overpass.kumi.systems 1/3 (intermittent, so it is ordered last). The
 * current primary (overpass-api.de) answered 0/3, which is exactly why a
 * fallback pool is not optional.
 *
 * These are ordinary credential-free https URLs (validateEndpoint() rejects
 * any URL carrying embedded credentials) and they are only contacted AFTER
 * the configured primary fails at transport or gateway level. Override with
 * DISCOVERY_OVERPASS_URL / DISCOVERY_OVERPASS_FALLBACK_URLS.
 */
export const DEFAULT_FALLBACK_ENDPOINTS: readonly string[] = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/**
 * Hard bound on endpoints contacted for one search or one ping: the primary
 * plus at most two fallbacks. This is what keeps the fan-out from becoming a
 * request storm no matter how many candidates are configured.
 */
export const MAX_ENDPOINTS = 3;

/**
 * Client deadline for ONE search request.
 *
 * Deliberately longer than the query's own server-side budget
 * (QUERY_TIMEOUT_S = 25s): an Overpass instance answers AFTER the query has
 * queued as well as executed, and a loaded public instance routinely spends
 * more than 30s between accepting a request and returning it (measured
 * live: the free `/api/status` probe alone exceeded 36s). A deadline below
 * that makes a healthy-but-busy endpoint look like a dead one, so every city
 * collapses into `transport: timeout` and the run reports "failed for every
 * city" even though the endpoint is simply slow.
 *
 * Only the client's PATIENCE is raised here. The safety controls are
 * untouched: the server-side query budget, the 2 MiB response cap, the
 * 1..100 result clamps and the one-request-per-city politeness rule all
 * still stand.
 */
const TIMEOUT_MS = 45_000;
const PING_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // a bounded prefix; OSM responses are small
const QUERY_TIMEOUT_S = 25;

/**
 * Bounded retry with EXPONENTIAL backoff for a CAPACITY answer.
 *
 * The public Overpass API answers a full worker pool with HTTP 502 and
 * tells the caller, in its own response body, exactly what to do:
 *   "Retry your request using exponential backoff: wait a short interval,
 *    then retry. If the request fails again, double the wait time and retry
 *    again."
 * A 502/503 is also the CHEAP kind of failure — the response comes back in
 * milliseconds — so re-asking the same host after500ms, then 1000ms, is
 * both what the provider asks for and far cheaper than opening a second
 * host. Only once MAX_ENDPOINT_ATTEMPTS is exhausted does the endpoint fail
 * over to the next configured host.
 *
 * Deliberately NOT retried in place:
 *   - a TRANSPORT failure (no HTTP response at all): the client has already
 *     waited out the whole TIMEOUT_MS for that host, so re-asking it would
 *     double the wait on a dead endpoint — precisely the request storm this
 *     bound exists to prevent. It fails over instead;
 *   - HTTP 504: the upstream has already burned its own deadline; the useful
 *     move is another endpoint, not the same wait twice. 504 still FAILS OVER
 *     (GATEWAY_FAILURE_STATUSES), it is only the in-place retry that is
 *     reserved for the fast, explicitly-retryable capacity statuses.
 *
 * Hard ceiling per search = endpoints (max 3) x MAX_ENDPOINT_ATTEMPTS
 * (max 3) = 9 HTTP requests and at most 3 x 1.5s of sleep. Never unbounded.
 */
const MAX_ENDPOINT_ATTEMPTS = 3;
const RETRY_BACKOFF_BASE_MS = 500;

/** Fast, transient capacity answers that the provider explicitly asks us to retry. */
const CAPACITY_RETRY_STATUSES: ReadonlySet<number> = new Set([502, 503]);

/**
 * HTTP statuses that mean the endpoint's INFRASTRUCTURE failed to produce an
 * answer — proxy gateway timeout, bad gateway, service unavailable — as
 * opposed to the application actually answering. These are NOT authoritative:
 * they are handled exactly like a transport failure (host marked down, put
 * into cooldown, the rest of the configured pool still tried).
 *
 * Deliberately narrow. 429 (a real answer that says "slow down"), every other
 * 4xx and 500 come from a working endpoint and stay authoritative, so a polite
 * public mirror is never dodged and a genuinely bad request is never repeated
 * against a second host. The set is what makes a persistent gateway outage
 * fail over instead of being reported as "busy — try again shortly".
 */
const GATEWAY_FAILURE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

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
  // Normalize FIRST: a whitespace-only city must behave like "no city"
  // (nationwide scope), not like a city whose name is empty — an empty exact
  // match would silently select nothing, and an empty regex `^` would match
  // every area in Pakistan.
  const cityName = city?.trim() || undefined;
  // City selection must not depend on the LOCAL-SCRIPT name alone.
  //
  // In OSM, Pakistan's city areas are predominantly named in Urdu — Karachi
  // is "ضلع کراچی" and Lahore is "لاہور" — so an exact `name` match resolves
  // to ZERO areas and the query returns an honest-but-empty result for every
  // city (verified live: exact `name` selector -> 0 areas for BOTH Karachi
  // and Lahore, while the union below -> 9 areas each). The union of the
  // exact local name and an English-name prefix covers the city/district/
  // division areas (`name:en` = "Karachi District", "Karachi Division", …),
  // and is still constrained to `(area.pk)` so nothing outside Pakistan can
  // enter. Both literals are escaped: `escapeQl` for the exact match and
  // `escapeQl(escapeRegex(...))` for the regex, so a hostile city string can
  // never break out of its quoted literal (regex metacharacters are escaped
  // first, then backslashes/quotes are QL-escaped for the parser).
  const cityLine = cityName
    ? [
        '(',
        `area["name"="${escapeQl(cityName)}"](area.pk);`,
        `area["name:en"~"^${escapeQl(escapeRegex(cityName))}",i](area.pk);`,
        ')->.city;',
      ].join('\n')
    : '';
  const scope = cityName ? 'area.city' : 'area.pk';

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
   * Optional fallback interpreter endpoints, tried in order ONLY after the
   * current endpoint has actually FAILED it: a transport-level failure (no
   * HTTP response) or an exhausted bounded backoff against a gateway/
   * capacity status (502/503/504). An HTTP response of any other status is
   * authoritative and never falls back. Each candidate must be a
   * credential-free https URL; invalid candidates are dropped and never
   * contacted. Global-coverage instances only — every query this adapter
   * sends is Pakistan-scoped.
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
  /**
   * Backoff step between the bounded gateway-failure retries. Injected so a
   * test can RECORD the delays instead of sleeping through them — the
   * default waits for real, exactly as the Overpass API's own guidance
   * ("wait a short interval, then retry ... double the wait time") requires.
   * Never returns a negative delay; the bound itself is fixed in code.
   */
  sleepImpl?: (ms: number) => Promise<void>;
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

/**
 * Read-only status URL for ONE endpoint: a standard interpreter exposes
 * `<base>/status`; anything else needs the free count-probe instead (null).
 * Shared by every pool member so the health probe and the search agree on
 * which host is being contacted.
 */
function statusUrlOf(endpoint: string): string | null {
  return endpoint.endsWith('/interpreter')
    ? `${endpoint.slice(0, -'/interpreter'.length)}/status`
    : null;
}

export function createOverpassDiscoveryAdapter(opts: OverpassAdapterOptions = {}): OverpassDiscoveryPort {
  const primaryCheck = validateEndpoint(opts.endpoint ?? DEFAULT_OVERPASS_ENDPOINT);
  const configError = primaryCheck.ok ? null : primaryCheck.reason;

  // Primary first, then fallbacks — deduped, each independently validated and
  // hard-bounded by MAX_ENDPOINTS so fan-out can never become a request
  // storm. An invalid PRIMARY is surfaced honestly as configError (no
  // network at all: a broken configuration must not be silently swapped); an
  // invalid FALLBACK is dropped and never contacted.
  //
  // When the owner has configured NO fallback, the built-in validated mirror
  // list is used instead of running with a pool of one. That pool of one is
  // precisely what turned a single transport failure into "Discovery failed
  // for every city": one endpoint down → 60s cooldown → every later city
  // fail-fasts. (DISCOVERY_OVERPASS_FALLBACK_URLS can still replace the list
  // entirely, and setting it to anything valid takes precedence here.)
  const requestedFallbacks =
    (opts.fallbackEndpoints ?? []).length > 0 ? (opts.fallbackEndpoints ?? []) : DEFAULT_FALLBACK_ENDPOINTS;
  const candidates = [opts.endpoint ?? DEFAULT_OVERPASS_ENDPOINT, ...requestedFallbacks].slice(0, MAX_ENDPOINTS);
  const endpoints: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const check = validateEndpoint(raw);
    if (check.ok && !seen.has(check.url)) {
      seen.add(check.url);
      endpoints.push(check.url);
    }
  }
  const primary = configError === null ? (endpoints[0] ?? '') : '';

  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, init) => fetch(u, init));
  const userAgent = opts.userAgent ?? 'UWS-AI-Sales-Agent/0.1 (lead-discovery; OpenStreetMap/Overpass)';
  // Real waiting by default (the provider's own guidance is "wait a short
  // interval, then retry"); injectable so a test can RECORD the delays
  // without spending them. Never sleeps on a negative value.
  const sleep: (ms: number) => Promise<void> =
    opts.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))));

  // Failure cooldown, keyed by HOST (a dead host is dead on every path of
  // that host). Covers BOTH failure kinds: a transport failure and an HTTP
  // gateway failure (502/503/504). A host that just answered 504 is not
  // healthy, so it must not be re-requested by the next search. Bounded
  // fan-out: a search never re-requests a cooling host, and when every
  // candidate is cooling down it fails fast with the last known category
  // instead of waiting out every timeout again. pings ignore the cooldown
  // (health must stay honest) but still RECORD it, so a failed probe benefits
  // the next search.
  const cooldownMs = opts.cooldownMs ?? 60_000;
  /** Sanitized failure category shown in diagnostics: `transport: <cat>` or `HTTP <status>`. */
  type FailureCategory = string;
  interface CooldownEntry {
    until: number;
    category: FailureCategory;
    err: unknown;
    /**
     * Consecutive failures of this host. Drives a bounded exponential backoff
     * (1x, 2x, 4x … capped at 5x the base cooldown) so a persistently dead
     * endpoint is not re-contacted every cycle while a one-off blip still
     * recovers quickly. Cleared by markUp(): one success resets the host.
     */
    streak: number;
  }
  const cooldowns = new Map<string, CooldownEntry>();
  const isCooling = (host: string): boolean => {
    const entry = cooldowns.get(host);
    return cooldownMs > 0 && entry !== undefined && entry.until > Date.now();
  };
  /** Milliseconds left on a host's cooldown (0 when not cooling). */
  const cooldownLeft = (host: string): number => {
    const entry = cooldowns.get(host);
    if (!entry) return 0;
    return Math.max(0, entry.until - Date.now());
  };
  const markDown = (url: string, category: FailureCategory, err: unknown): void => {
    const host = hostOf(url);
    const streak = (cooldowns.get(host)?.streak ?? 0) + 1;
    const factor = Math.min(2 ** (streak - 1), 5);
    cooldowns.set(host, { until: Date.now() + cooldownMs * factor, category, err, streak });
  };
  const markUp = (url: string): void => {
    cooldowns.delete(hostOf(url));
  };

  /**
   * Single-endpoint request used by ping(): one pool member at a time,
   * cooldown ignored. A transport failure becomes a `network` AdapterError
   * carrying the sanitized category, the effective host, and the original
   * error as `cause`. An HTTP gateway/availability failure (502/503/504) is
   * recorded as a host failure (so the next search skips it) but the response
   * is still returned — the CALLER decides whether to keep walking the pool.
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
      // A gateway failure is NOT evidence of health: mark the host down so the
      // next search skips it. Any other response proves the endpoint answered,
      // so it clears the cooldown.
      if (GATEWAY_FAILURE_STATUSES.has(res.status)) {
        markDown(path, `HTTP ${res.status}`, undefined);
      } else {
        markUp(path);
      }
      return res;
    } catch (err) {
      const cat: TransportCategory = classifyTransportError(err);
      markDown(path, `transport: ${cat}`, err);
      throw new AdapterError('network', `Could not reach the Overpass API at ${hostOf(path)} (transport: ${cat})`, {
        retryable: true,
        cause: err,
      });
    }
  }

  /**
   * Search request: primary first, then non-cooling fallbacks.
   *
   * Per endpoint the walk makes at most MAX_ENDPOINT_ATTEMPTS tries: a fast
   * capacity answer (502/503) is retried in place with exponential backoff
   * (the provider's own instruction), while a transport failure or a 504
   * abandons that host immediately and moves on. Any OTHER HTTP response is
   * authoritative and is returned for normal status mapping — it is never
   * swapped for another host.
   *
   * Exactly ONE diagnostic entry is recorded per endpoint (its final
   * category), so the final error discloses the real fan-out (count + safe
   * host + per-host category) without repeating intermediate retries — and
   * the cooldown streak is bumped once per endpoint per search, not once per
   * attempt, so a single bad search cannot inflate the backoff.
   */
  async function requestSearch(body: string, timeoutMs: number): Promise<Response> {
    let tried = 0;
    const attempts: string[] = [];
    let lastErr: unknown;
    for (const url of endpoints) {
      const host = hostOf(url);
      if (isCooling(host)) continue;
      tried += 1;

      let finalCategory: FailureCategory | null = null;
      let finalErr: unknown;
      for (let attempt = 1; attempt <= MAX_ENDPOINT_ATTEMPTS; attempt++) {
        if (attempt > 1) {
          // Exponential backoff: 500ms, then 1000ms — bounded, never a storm.
          await sleep(RETRY_BACKOFF_BASE_MS * 2 ** (attempt - 2));
        }
        let res: Response;
        try {
          res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': userAgent },
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          // Transport failure: the full timeout was already paid for this
          // host, so it is NEVER retried here — fail over instead.
          finalCategory = `transport: ${classifyTransportError(err)}`;
          finalErr = err;
          break;
        }
        if (GATEWAY_FAILURE_STATUSES.has(res.status)) {
          finalCategory = `HTTP ${res.status}`;
          finalErr = undefined;
          // Only the fast capacity statuses are worth a bounded in-place
          // retry; a 504 has already spent the upstream deadline.
          if (CAPACITY_RETRY_STATUSES.has(res.status) && attempt < MAX_ENDPOINT_ATTEMPTS) continue;
          break;
        }
        // An authoritative answer from a working endpoint: healthy, and the
        // search proceeds with it.
        markUp(url);
        return res;
      }

      if (finalCategory !== null) {
        attempts.push(`${host} (${finalCategory})`);
        if (finalErr !== undefined) lastErr = finalErr;
        // ONE cooldown bump per endpoint per search (not per attempt) so the
        // streak-driven backoff measures searches, not internal retries.
        markDown(url, finalCategory, finalErr);
      }
    }
    if (tried === 0) {
      // Every candidate host is inside its cooldown window: fail fast with
      // the last known category rather than stalling on every timeout again.
      // The message must still DIAGNOSE: which host, how big the pool is, and
      // how long the cooldown has left — never a URL query, credential or any
      // other secret (hostOf() exposes hostname only; validateEndpoint()
      // already rejects credentialed URLs).
      const cooling = endpoints.map((u) => ({
        host: hostOf(u),
        left: cooldownLeft(hostOf(u)),
        category: cooldowns.get(hostOf(u))?.category ?? 'unknown',
      }));
      const worstLeft = cooling.reduce((m, c) => Math.max(m, c.left), 0);
      const entry = primary !== '' ? cooldowns.get(hostOf(primary)) : undefined;
      const detail = cooling
        .map((c) => `${c.host} [${c.category}] retry in ${Math.ceil(c.left / 1000)}s`)
        .join('; ');
      throw new AdapterError(
        'network',
        `Could not reach the Overpass API (${entry?.category ?? 'transport: unknown'}; every endpoint in the pool of ${endpoints.length} is cooling down after a recent failure — ${detail}; pool usable again in ~${Math.ceil(worstLeft / 1000)}s)`,
        { retryable: true, cause: entry?.err },
      );
    }
    throw new AdapterError(
      'network',
      `Could not reach the Overpass API — ${tried} endpoint(s) tried: ${attempts.join('; ')}`,
      { retryable: true, cause: lastErr },
    );
  }

  /**
   * Map an HTTP status that represents a real ANSWER from a working endpoint.
   * 429 is the only status that is genuine proof of rate limiting.
   *
   * A gateway failure (502/503/504) never reaches this from search() or
   * ping() — those paths intercept it and fail over — but the guard below
   * keeps the invariant "504 is never sold as rate limiting" no matter which
   * caller ends up here.
   */
  function mapHttpError(status: number): AdapterError {
    if (GATEWAY_FAILURE_STATUSES.has(status)) {
      return new AdapterError(
        'provider_error',
        `Overpass endpoint gateway failure (HTTP ${status}) — the endpoint did not answer`,
        { providerStatus: status, retryable: true },
      );
    }
    if (status === 429) {
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

    async status(): Promise<AdapterStatus> {
      // Honest health: configuration being valid is NOT the same as being able
      // to run a search. If every pool member is inside its cooldown window,
      // discovery is down right now — report `error` with what is cooling and
      // for how long instead of claiming Ready while every city fails.
      const coolingHosts = endpoints.filter((u) => isCooling(hostOf(u)));
      const poolWideOutage =
        configError === null && endpoints.length > 0 && coolingHosts.length === endpoints.length;
      const worstLeft = coolingHosts.reduce((m, u) => Math.max(m, cooldownLeft(hostOf(u))), 0);
      const outageNote = poolWideOutage
        ? `All ${endpoints.length} endpoint(s) in the discovery pool are cooling down after recent failures (${coolingHosts
            .map((u) => `${hostOf(u)} ${cooldowns.get(hostOf(u))?.category ?? 'unknown'}`)
            .join(', ')}); searches fail fast for ~${Math.ceil(worstLeft / 1000)}s more`
        : null;
      return {
        key: 'discovery',
        label: 'Lead discovery',
        implementation: 'overpass',
        // An invalid configured endpoint is a real configuration error, not a
        // silently-swappable one: it is reported as `error` with the reason.
        // A pool-wide cooldown is a runtime error and is reported as one.
        state: configError !== null ? 'error' : poolWideOutage ? 'error' : 'configured',
        features: [
          'public OpenStreetMap lead search (free, no API key)',
          'Pakistan coverage via the Overpass API',
          // Non-secret endpoint policy — HOSTNAMES ONLY. validateEndpoint()
          // rejects any URL carrying embedded credentials, and hostOf() drops
          // path, query and fragment entirely, so neither DISCOVERY_OVERPASS_URL
          // nor DISCOVERY_OVERPASS_FALLBACK_URLS can leak here. This is what
          // lets the owner verify the EFFECTIVE endpoint pool (including
          // whether a fallback is really configured) without reading any env
          // file or asking for a secret.
          `endpoint pool: ${endpoints.length} configured${endpoints.length > 0 ? ` (${endpoints.map(hostOf).join(', ')})` : ''}`,
          ...(poolWideOutage ? [`pool-wide cooldown: ${coolingHosts.length}/${endpoints.length} endpoints cooling`] : []),
        ],
        lastError: configError ?? outageNote,
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
      // Walk the SAME configured pool as search() (primary + fallbacks),
      // ignoring the cooldown — health must stay honest even right after a
      // failure. Two kinds of failure move on to the next endpoint: a
      // transport failure, and a gateway/availability failure (502/503/504)
      // where the endpoint's infrastructure produced no answer. Any OTHER
      // HTTP response is an authoritative answer from a working endpoint and
      // stops the loop, exactly like search(): a search could not succeed
      // against a host that health just reported as answering.
      const attempted: string[] = [];
      let lastCause: unknown;
      for (const endpoint of endpoints) {
        const host = hostOf(endpoint);
        const statusUrl = statusUrlOf(endpoint);
        let res: Response;
        try {
          res =
            statusUrl !== null
              ? // FREE status endpoint: rate-limit info, no query is executed.
                await request(statusUrl, null, PING_TIMEOUT_MS)
              : // Custom endpoint that is not a standard interpreter URL: a
                // count-only query (returns a single number; free of charge).
                await request(
                  endpoint,
                  `data=${encodeURIComponent(`[out:json][timeout:${QUERY_TIMEOUT_S}];node(around:1,0,0)["name"];out count;`)}`,
                  PING_TIMEOUT_MS,
                );
        } catch (err) {
          const cat: TransportCategory = classifyTransportError(err);
          attempted.push(`${host} (transport: ${cat})`);
          // Keep the ORIGINAL fetch failure as the cause (request() wrapped it
          // in an AdapterError), matching what search() reports.
          lastCause = err instanceof AdapterError && err.cause !== undefined ? err.cause : err;
          continue;
        }
        if (!res.ok) {
          if (GATEWAY_FAILURE_STATUSES.has(res.status)) {
            // Gateway/availability failure: the endpoint's infrastructure did
            // not answer, so it is NOT healthy (request() already cooled it
            // down) and the walk continues to the next configured endpoint.
            attempted.push(`${host} (HTTP ${res.status})`);
            continue;
          }
          // An authoritative answer (4xx / 429 / 500): this endpoint works and
          // is telling us the request failed. Stop the walk and report it.
          const httpErr = mapHttpError(res.status);
          throw new AdapterError(httpErr.code, `${httpErr.message} (at ${host})`, {
            providerStatus: httpErr.providerStatus,
            retryable: httpErr.retryable,
          });
        }
        const body = (await res.text()).slice(0, 2000);
        // Every success detail discloses the CONFIGURED pool size alongside the
        // host that actually answered, so the dashboard can distinguish "no
        // fallback is configured" from "a fallback exists and was reached".
        const poolNote = ` — endpoint pool: ${endpoints.length} configured`;
        if (statusUrl !== null) {
          const limitLine = /rate limit:\s*(.+)/i.exec(body)?.[1]?.trim();
          return {
            ok: true,
            detail: `Overpass API reachable at ${host} (free status probe; no search performed)${limitLine ? ` — rate limit: ${limitLine.slice(0, 60)}` : ''}${poolNote}`,
          };
        }
        return { ok: true, detail: `Overpass endpoint reachable at ${host} (free count probe; no search performed)${poolNote}` };
      }
      throw new AdapterError(
        'network',
        `Could not reach the Overpass API — ${attempted.length} endpoint(s) tried: ${attempted.join('; ')}`,
        { retryable: true, cause: lastCause },
      );
    },
  };
}
