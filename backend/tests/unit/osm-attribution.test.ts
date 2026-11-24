/**
 * Phase 9: ODbL attribution is stated verbatim and identically everywhere.
 *
 *  - The required credit text and URL match the wording published at
 *    openstreetmap.org/copyright.
 *  - `OSM_ATTRIBUTION` (what the discovery run result carries) is built from
 *    the same constants — no second wording can appear in JSON.
 *  - The offline extractor script RE-EXPORTS the shared module, so the
 *    dataset sidecar and the dashboard can never drift apart: if someone
 *    edits one side, this test fails.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ODBL_ATTRIBUTION,
  ODBL_URL,
  OSM_ATTRIBUTION,
} from '../../src/domain/discovery/attribution.ts';
import * as extractor from '../../scripts/extract-osm.ts';

describe('ODbL attribution (Phase 9)', () => {
  test('the credit text and URL are verbatim', () => {
    assert.equal(ODBL_ATTRIBUTION, '© OpenStreetMap contributors — Data available under the Open Database License (ODbL).');
    assert.equal(ODBL_URL, 'https://www.openstreetmap.org/copyright');
    assert.ok(ODBL_ATTRIBUTION.includes('© OpenStreetMap contributors'), 'names the required copyright holder');
    assert.ok(ODBL_ATTRIBUTION.includes('Open Database License (ODbL)'), 'names the required licence');
  });

  test('the structured attribution carries exactly the same wording', () => {
    assert.equal(OSM_ATTRIBUTION.text, ODBL_ATTRIBUTION);
    assert.equal(OSM_ATTRIBUTION.license, 'ODbL');
    assert.equal(OSM_ATTRIBUTION.url, ODBL_URL);
    assert.ok(Object.isFrozen(OSM_ATTRIBUTION), 'a shared constant must not be mutated at runtime');
  });

  test('the offline extractor uses the SAME constants (sidecar = dashboard)', () => {
    assert.equal(extractor.ODBL_ATTRIBUTION, ODBL_ATTRIBUTION, 'extractor sidecar text drifted from the runtime');
    assert.equal(extractor.ODBL_URL, ODBL_URL, 'extractor sidecar URL drifted from the runtime');
  });
});
