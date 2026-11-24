/**
 * Discovery provider dispatch (Phase 11A, Task 6; Phase 12).
 *
 * `DISCOVERY_PROVIDER` selects the concrete adapter:
 *   mock      - fixture-backed directory search (no network)
 *   osm_local - OFFLINE search over the locally extracted NDJSON dataset
 *               (scripts/extract-osm.ts, owner-run from a Geofabrik PBF).
 *               Keyless: no network, no API key, never parses a raw PBF.
 *   overpass  - real OpenStreetMap search via the free Overpass API (no API
 *               key, no billing). Owner-selected vendor (Phase 12); the only
 *               supported country is Pakistan (country=PK).
 *
 * Anything else (including empty) yields the honest unconfigured adapter —
 * discovery continues through the CSV/Excel import path. A `website` helper
 * (see website.ts) is provided for on-demand verification of a lead's own
 * website, which is free and public-data-only.
 */
import type { DiscoveryPort } from '../types.ts';
import type { FetchLike } from '../http.ts';
import { createMockDiscoveryAdapter } from '../mock/index.ts';
import { createUnconfiguredDiscovery } from './unconfigured.ts';
import { createOsmLocalDiscoveryAdapter } from './osm-local.ts';
import { createOverpassDiscoveryAdapter } from './overpass.ts';

type Env = Record<string, string | undefined>;

export interface DiscoveryAdapterOptions {
  fetchImpl?: FetchLike;
}

export function createDiscoveryAdapter(
  env: Env,
  opts: DiscoveryAdapterOptions = {},
): DiscoveryPort {
  const provider = (env['DISCOVERY_PROVIDER'] ?? '').trim().toLowerCase();

  // If GEOAPIFY_API_KEY is set (non-empty) and this is not a keyless discovery
  // provider (overpass/osm_local), initialize Geoapify Places API discovery
  // regardless of the DISCOVERY_PROVIDER value.
  if (env['GEOAPIFY_API_KEY'] && env['GEOAPIFY_API_KEY'].trim() !== '' && provider !== 'overpass' && provider !== 'osm_local') {
    return createGeoapifyDiscoveryAdapter({
      apiKey: env['GEOAPIFY_API_KEY'],
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  }

  if (!provider) return createUnconfiguredDiscovery();

  switch (provider) {
    case 'mock':
      // Deterministic fixtures for rehearsal/tests. Zero network.
      return createMockDiscoveryAdapter([
        {
          name: 'Demo Grill House',
          city: 'Lahore',
          sourceUrl: 'mock://fixtures',
          source: 'mock_directory',
        },
        {
          name: 'Sample Salon Studio',
          city: 'Karachi',
          sourceUrl: 'mock://fixtures',
          source: 'mock_directory',
        },
      ]);
    case 'osm_local':
      // Offline local dataset: reads only the extracted NDJSON file
      // (OSM_LOCAL_DATASET or data/osm-leads.ndjson). No network, no key,
      // and a raw .pbf path is refused inside the adapter.
      return createOsmLocalDiscoveryAdapter(env);
    case 'overpass': {
      // Real OpenStreetMap search; free, no credentials exist for it at all.
      // Optional fallbacks are tried ONLY after a transport-level failure of
      // the primary; each candidate is re-validated inside the adapter
      // (credential-free https only). Parsed here: trimmed, non-empty,
      // deduped against the primary and each other, hard-capped at 2 so the
      // fallback fan-out can never grow unbounded.
      const primaryRaw = (env['DISCOVERY_OVERPASS_URL'] ?? '').trim();
      const seenFallbacks = new Set<string>(primaryRaw !== '' ? [primaryRaw] : []);
      const fallbacks: string[] = [];
      for (const entry of (env['DISCOVERY_OVERPASS_FALLBACK_URLS'] ?? '').split(',')) {
        const candidate = entry.trim();
        if (candidate.length === 0 || seenFallbacks.has(candidate)) continue;
        seenFallbacks.add(candidate);
        fallbacks.push(candidate);
        if (fallbacks.length >= 2) break;
      }
      return createOverpassDiscoveryAdapter({
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(primaryRaw !== '' ? { endpoint: primaryRaw } : {}),
        ...(fallbacks.length > 0 ? { fallbackEndpoints: fallbacks } : {}),
      });
    }
    case 'geoapify': {
      // Geoapify Places API search — requires GEOAPIFY_API_KEY env var.
      // Searches for businesses by category within a Pakistan administrative area.
      // Returns auditable leads with stable OSM source URLs.
      const apiKey = env['GEOAPIFY_API_KEY'];
      if (!apiKey) {
        return createUnconfiguredDiscovery();
      }
      return createGeoapifyDiscoveryAdapter({
        apiKey,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
    }
    default:
      // Unknown vendor name: honest unconfigured, never fabricated leads.
      return createUnconfiguredDiscovery();
  }
}

export const SUPPORTED_DISCOVERY_PROVIDERS = ['mock', 'osm_local', 'overpass', 'geoapify'] as const;
