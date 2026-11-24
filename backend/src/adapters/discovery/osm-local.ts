/**
 * Offline `osm_local` discovery provider (Geofabrik plan, Phase 3).
 *
 * Reads the locally extracted NDJSON dataset produced by the OWNER-RUN,
 * offline extractor (`scripts/extract-osm.ts`, from a Geofabrik PBF). This
 * adapter:
 *   - NEVER touches the network (no fetch, no DNS — pure local file I/O);
 *   - NEVER parses a raw `.pbf` (the PBF parser is a dev-only dependency of
 *     the extractor script; a `.pbf` path is refused outright);
 *   - NEVER invents data: every hit is a verbatim record from the dataset,
 *     and a missing/empty/corrupt dataset fails honestly instead of
 *     returning fabricated "leads".
 *
 * `DISCOVERY_PROVIDER=osm_local` selects it (keyless — there is no API key
 * for local files). `OSM_LOCAL_DATASET` overrides the dataset path
 * (default: `data/osm-leads.ndjson`, relative to the process cwd and
 * gitignored — datasets are never committed).
 *
 * Semantics mirror the Overpass adapter (overpass.ts) so both providers
 * agree: comma-separated terms, PK-only, limit clamped 1..100 (default 50),
 * first requested match wins, dedupe by sourceUrl and by name+contact
 * identity, known category terms match the record's category while unknown
 * terms fall back to a case-insensitive name substring.
 */
import { closeSync, createReadStream, openSync, readSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { AdapterError } from '../types.ts';
import type {
  AdapterStatus,
  DiscoveryHit,
  DiscoveryPort,
  DiscoveryQuery,
  PingResult,
} from '../types.ts';

type Env = Record<string, string | undefined>;

/** Default dataset location, relative to the process working directory. */
export const DEFAULT_OSM_LOCAL_DATASET = path.join('data', 'osm-leads.ndjson');

/** Resolve the dataset path: `OSM_LOCAL_DATASET` override or the default. */
export function resolveOsmLocalDataset(env: Env): string {
  const override = (env['OSM_LOCAL_DATASET'] ?? '').trim();
  return override !== '' ? override : DEFAULT_OSM_LOCAL_DATASET;
}

/**
 * The seven discovery-policy categories. Kept in sync with
 * POLICY_CATEGORIES (scripts/extract-osm.ts) and with SETTING_DEFINITIONS
 * discovery_policy default — tests/unit/osm-local.test.ts asserts the lists
 * never drift apart. Defined locally (never imported from scripts/) so the
 * PBF parser stays a dev-only dependency out of the server import graph.
 */
export const OSM_LOCAL_CATEGORIES = [
  'clinic',
  'restaurant',
  'school',
  'real_estate',
  'retail',
  'ecommerce',
  'professional_services',
] as const;

/** Why the configured dataset cannot serve searches right now. */
export interface DatasetProblem {
  /** `unconfigured` = dataset missing/empty; `provider_error` = unusable file. */
  code: 'unconfigured' | 'provider_error';
  message: string;
}

function isPbfPath(dataset: string): boolean {
  return path.extname(dataset).toLowerCase() === '.pbf';
}

function pbfProblem(dataset: string): DatasetProblem {
  return {
    code: 'provider_error',
    message:
      `"${dataset}" is a raw OSM PBF file - osm_local reads the extracted NDJSON dataset only ` +
      `(a PBF is never parsed at runtime). Set OSM_LOCAL_DATASET to the .ndjson output of scripts/extract-osm.ts`,
  };
}

/**
 * Single source of truth for dataset availability. Checked by `status()`,
 * `search()`, `ping()` and `npm run doctor` — all four report the same
 * honest reason. A raw `.pbf` is refused before it is even stat'ed.
 */
export function osmLocalDatasetProblem(env: Env): DatasetProblem | null {
  const dataset = resolveOsmLocalDataset(env);
  if (isPbfPath(dataset)) return pbfProblem(dataset);

  let stats;
  try {
    stats = statSync(dataset);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT'
      ? {
          code: 'unconfigured',
          message:
            `Local dataset not found at "${dataset}". Extract one offline: ` +
            `npm run extract:osm -- --input <pakistan-latest.osm.pbf> --output ${dataset}`,
        }
      : { code: 'unconfigured', message: `Local dataset "${dataset}" is not readable (${code ?? 'unknown error'})` };
  }
  if (!stats.isFile()) {
    return { code: 'unconfigured', message: `Local dataset "${dataset}" is not a regular file` };
  }
  if (stats.size === 0) {
    return { code: 'unconfigured', message: `Local dataset "${dataset}" is empty - run the offline extractor to populate it` };
  }
  return null;
}

// --------------------------------------------------------------- records ---

/** Hard cap on one NDJSON line (extractor records are ~1 KiB; 64 KiB guards
 *  against binary/corrupt content being buffered without bound). */
const MAX_LINE_CHARS = 64 * 1024;
/** Bytes read from the head of the file by the free ping() probe. */
const PING_PROBE_BYTES = 8 * 1024;

/** One validated dataset record — exactly the extractor's output schema. */
interface OsmLocalRecord {
  osmType: 'node' | 'way';
  osmId: number;
  name: string;
  category: string;
  city: string | null;
  phone?: string;
  website?: string;
  email?: string;
  address?: string;
  lat: number;
  lon: number;
  source: string;
  sourceUrl: string;
}

function malformed(lineNo: number, detail: string): AdapterError {
  return new AdapterError('provider_error', `Malformed NDJSON at line ${lineNo}: ${detail}`);
}

/**
 * Strict schema check against the extractor's record shape. A record that
 * does not match means the file is not (or no longer) an extracted dataset:
 * abort loudly with the line number rather than silently skipping data the
 * owner believes is there. Nothing is ever coerced or invented.
 */
function validateRecord(value: unknown, lineNo: number): OsmLocalRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw malformed(lineNo, 'record is not a JSON object');
  }
  const r = value as Record<string, unknown>;

  const requiredString = (field: string): string => {
    const v = r[field];
    if (typeof v !== 'string' || v.trim() === '') throw malformed(lineNo, `"${field}" must be a non-empty string`);
    return v;
  };
  const optionalString = (field: string): string | undefined => {
    const v = r[field];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') throw malformed(lineNo, `"${field}" must be a string when present`);
    return v.trim() === '' ? undefined : v;
  };
  const coord = (field: string, max: number): number => {
    const v = r[field];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < -max || v > max) {
      throw malformed(lineNo, `"${field}" must be a finite number within +/-${max}`);
    }
    return v;
  };

  const osmType = r['osmType'];
  if (osmType !== 'node' && osmType !== 'way') throw malformed(lineNo, '"osmType" must be "node" or "way"');
  const osmId = r['osmId'];
  if (typeof osmId !== 'number' || !Number.isInteger(osmId)) throw malformed(lineNo, '"osmId" must be an integer');
  const category = r['category'];
  if (typeof category !== 'string') throw malformed(lineNo, '"category" must be a string');
  const cityRaw = r['city'];
  if (cityRaw !== undefined && cityRaw !== null && typeof cityRaw !== 'string') {
    throw malformed(lineNo, '"city" must be a string or null');
  }

  return {
    osmType,
    osmId,
    name: requiredString('name'),
    category,
    city: typeof cityRaw === 'string' && cityRaw.trim() !== '' ? cityRaw : null,
    phone: optionalString('phone'),
    website: optionalString('website'),
    email: optionalString('email'),
    address: optionalString('address'),
    lat: coord('lat', 90),
    lon: coord('lon', 180),
    source: optionalString('source') ?? 'openstreetmap',
    sourceUrl: requiredString('sourceUrl'),
  };
}

/**
 * Filter semantics identical to the Overpass adapter: city (case-insensitive)
 * when requested, then category match for KNOWN policy terms, with a
 * case-insensitive name substring fallback for UNKNOWN terms only.
 */
function matchesQuery(
  rec: OsmLocalRecord,
  knownTerms: ReadonlySet<string>,
  freeTextTerms: readonly string[],
  city: string | undefined,
): boolean {
  if (city !== undefined && (rec.city === null || rec.city.toLowerCase() !== city.toLowerCase())) return false;
  if (knownTerms.has(rec.category)) return true;
  if (freeTextTerms.length > 0) {
    const name = rec.name.toLowerCase();
    if (freeTextTerms.some((t) => name.includes(t))) return true;
  }
  return false;
}

function toHit(rec: OsmLocalRecord, city: string | undefined): DiscoveryHit {
  const hit: DiscoveryHit = {
    name: rec.name,
    city: rec.city ?? city,
    category: rec.category,
    lat: rec.lat,
    lon: rec.lon,
    osmType: rec.osmType,
    osmId: rec.osmId,
    source: rec.source,
    sourceUrl: rec.sourceUrl,
  };
  if (rec.phone !== undefined) hit.phone = rec.phone;
  if (rec.website !== undefined) hit.website = rec.website;
  if (rec.email !== undefined) hit.email = rec.email;
  if (rec.address !== undefined) hit.address = rec.address;
  return hit;
}

// --------------------------------------------------------------- adapter ---

/** The osm_local port always exposes its free local health probe. */
export interface OsmLocalDiscoveryPort extends DiscoveryPort {
  ping(): Promise<PingResult>;
}

export function createOsmLocalDiscoveryAdapter(env: Env): OsmLocalDiscoveryPort {
  const dataset = resolveOsmLocalDataset(env);

  return {
    key: 'osm_local_discovery',
    label: 'Lead discovery (offline OSM)',

    async status(): Promise<AdapterStatus> {
      const problem = osmLocalDatasetProblem(env);
      return {
        key: 'discovery',
        label: 'Lead discovery',
        implementation: 'osm_local',
        // A missing/empty dataset is an ERROR (with the actionable reason),
        // deliberately not `unconfigured`: DISCOVERY_PROVIDER IS configured —
        // runDiscovery then proceeds to search, which fails per city with the
        // same honest message instead of a generic "no provider" one.
        state: problem === null ? 'configured' : 'error',
        features: [
          'offline OpenStreetMap lead search from a local dataset (free, no key, no network)',
          'dataset extracted on this machine from a Geofabrik PBF (npm run extract:osm)',
        ],
        lastError: problem?.message ?? null,
      };
    },

    async search(q: DiscoveryQuery): Promise<DiscoveryHit[]> {
      if (q.country !== undefined && q.country !== 'PK') {
        throw new AdapterError('invalid_destination', 'osm_local discovery covers Pakistan (country=PK) only');
      }
      const terms = q.query
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0);
      if (terms.length === 0) {
        throw new AdapterError('invalid_destination', 'A discovery search needs at least one category');
      }
      // Re-checked at call time: the file may have vanished since status().
      const problem = osmLocalDatasetProblem(env);
      if (problem !== null) throw new AdapterError(problem.code, problem.message);

      const requested = typeof q.limit === 'number' && Number.isFinite(q.limit) ? q.limit : 50;
      const limit = Math.min(Math.max(requested, 1), 100);
      const city = q.city?.trim() || undefined;
      const categories = OSM_LOCAL_CATEGORIES as readonly string[];
      const knownTerms = new Set(terms.filter((t) => categories.includes(t)));
      const freeTextTerms = terms.filter((t) => !categories.includes(t));

      const hits: DiscoveryHit[] = [];
      const seenSources = new Set<string>();
      const seenIdentity = new Set<string>();
      const stream = createReadStream(dataset, { encoding: 'utf8' });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      let lineNo = 0;
      let firstContentSeen = false;
      try {
        for await (const line of rl) {
          lineNo += 1;
          const trimmed = line.trim();
          if (trimmed === '') continue;
          if (!firstContentSeen) {
            firstContentSeen = true;
            // Binary content (e.g. a mis-pointed dataset) never starts with
            // '{' — refuse immediately instead of scanning garbage.
            if (!trimmed.startsWith('{')) {
              throw new AdapterError(
                'provider_error',
                `"${dataset}" is not an NDJSON dataset (line ${lineNo} does not start with "{")`,
              );
            }
          }
          if (trimmed.length > MAX_LINE_CHARS) {
            throw new AdapterError(
              'provider_error',
              `Line ${lineNo} of "${dataset}" exceeds ${MAX_LINE_CHARS} characters - refusing (file may be binary)`,
            );
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            throw new AdapterError('provider_error', `Malformed NDJSON at line ${lineNo} of "${dataset}" (invalid JSON)`);
          }
          const rec = validateRecord(parsed, lineNo);
          if (!matchesQuery(rec, knownTerms, freeTextTerms, city)) continue;

          // Same dedupe as the Overpass adapter: one OSM element, one hit —
          // even when two different elements describe the same business.
          const identity = `${rec.name.toLowerCase()}|${rec.phone ?? rec.website ?? ''}`;
          if (seenSources.has(rec.sourceUrl) || seenIdentity.has(identity)) continue;
          seenSources.add(rec.sourceUrl);
          seenIdentity.add(identity);

          hits.push(toHit(rec, city));
          if (hits.length >= limit) break; // early exit: never scan past the limit
        }
      } catch (err) {
        if (err instanceof AdapterError) throw err;
        throw new AdapterError(
          'provider_error',
          `Could not read local dataset "${dataset}": ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
        );
      } finally {
        rl.close();
        stream.destroy();
      }
      return hits;
    },

    async ping(): Promise<PingResult> {
      // FREE + local: one stat and an 8 KiB head read. No network, ever.
      const problem = osmLocalDatasetProblem(env);
      if (problem !== null) return { ok: false, detail: problem.message };

      let handle: number | null = null;
      try {
        const buf = Buffer.alloc(PING_PROBE_BYTES);
        handle = openSync(dataset, 'r');
        const bytesRead = readSync(handle, buf, 0, PING_PROBE_BYTES, 0);
        const text = buf.subarray(0, bytesRead).toString('utf8');
        const newlineAt = text.indexOf('\n');
        const firstLine = (newlineAt !== -1 ? text.slice(0, newlineAt) : text).trim();
        if (!firstLine.startsWith('{')) {
          return {
            ok: false,
            detail: `"${dataset}" does not start with an NDJSON record - it may not be an extracted dataset (raw .pbf files are never read here)`,
          };
        }
        // Parse only when the first line is complete inside the probe window
        // (a record larger than 8 KiB is not a failure by itself).
        if (newlineAt !== -1 || bytesRead < PING_PROBE_BYTES) {
          try {
            JSON.parse(firstLine);
          } catch {
            return {
              ok: false,
              detail: `First record of "${dataset}" is not valid JSON - the dataset may be corrupt; re-run the offline extractor`,
            };
          }
        }
        const size = statSync(dataset).size;
        return { ok: true, detail: `Local dataset OK: ${size} byte(s), first record parses` };
      } catch (err) {
        return {
          ok: false,
          detail: `Could not read "${dataset}": ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
        };
      } finally {
        if (handle !== null) {
          try {
            closeSync(handle);
          } catch {
            /* already closed */
          }
        }
      }
    },
  };
}
