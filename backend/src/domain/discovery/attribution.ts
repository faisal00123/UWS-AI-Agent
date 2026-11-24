/**
 * ODbL attribution — the single source of truth for crediting OpenStreetMap.
 *
 * Every surface that carries OSM-derived data must say the same thing:
 *   - the offline extractor's `<dataset>.meta.json` sidecar (Phase 1),
 *   - the discovery run result rendered by the dashboard (Phase 9),
 *   - the Leads page footer in the UI (Phase 9).
 *
 * The wording is verbatim from https://www.openstreetmap.org/copyright so
 * the required attribution is reproduced exactly, and `tests/unit/
 * osm-attribution.test.ts` fails if any consumer drifts from it.
 *
 * This module is a deliberate leaf (zero imports): both production code and
 * the dev-only extractor script can depend on it without pulling in config,
 * database or adapter code.
 */

/** Verbatim ODbL attribution text. */
export const ODBL_ATTRIBUTION =
  '© OpenStreetMap contributors — Data available under the Open Database License (ODbL).';

/** Canonical ODbL / copyright reference. */
export const ODBL_URL = 'https://www.openstreetmap.org/copyright';

/** Structured form attached to discovery run results (JSON-safe). */
export const OSM_ATTRIBUTION = Object.freeze({
  text: ODBL_ATTRIBUTION,
  license: 'ODbL',
  url: ODBL_URL,
});

export interface OsmAttribution {
  text: string;
  license: string;
  url: string;
}
