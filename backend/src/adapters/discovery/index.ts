/**
 * Discovery provider dispatch (Phase 11A, Task 6; Phase 12).
 *
 * `DISCOVERY_PROVIDER` selects the concrete adapter:
 *   mock      - fixture-backed directory search (no network)
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
    default:
      // Unknown vendor name: honest unconfigured, never fabricated leads.
      return createUnconfiguredDiscovery();
  }
}

export const SUPPORTED_DISCOVERY_PROVIDERS = ['mock', 'overpass'] as const;
