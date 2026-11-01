/**
 * Discovery port placeholder (Phase 7).
 *
 * Choosing a live directory/search vendor is an owner decision (pricing,
 * terms, quota), so no vendor adapter ships yet — the platform discovers leads
 * through the CSV/Excel import path until one is chosen. This adapter exists
 * so the Integrations page can say exactly that instead of pretending the
 * port doesn't exist, and so `search()` fails loudly rather than returning
 * fabricated "leads".
 */
import { AdapterError, type AdapterStatus, type DiscoveryPort, type DiscoveryHit, type DiscoveryQuery } from '../types.ts';

export function createUnconfiguredDiscovery(): DiscoveryPort {
  return {
    key: 'discovery_none',
    label: 'Lead discovery',

    status(): AdapterStatus {
      return {
        key: 'discovery',
        label: 'Lead discovery',
        implementation: null,
        state: 'unconfigured',
        features: ['public web/directory lead search'],
        lastError: null,
      };
    },

    async search(_q: DiscoveryQuery): Promise<DiscoveryHit[]> {
      throw new AdapterError(
        'unconfigured',
        'No discovery provider is configured. Import leads from CSV/Excel, or configure a discovery API key (owner decision) — the platform never invents leads.',
      );
    },
  };
}
