/**
 * Provider onboarding (Phase 11B).
 *
 * Onboarding = proving that the credentials the owner configured actually
 * authenticate — via the FREE `ping()` probe only. The outcome is persisted
 * per integration in `provider_onboardings`:
 *
 *   pending  -> never verified, or the last probe could not run
 *              (unconfigured/disabled — an honest "not yet", not a failure)
 *   verified -> the last free probe authenticated successfully
 *   failed   -> credentials were presented and REJECTED by the provider
 *
 * Security invariants:
 *  - credentials NEVER enter this module or its tables: only the integration
 *    key, the provider implementation name, a redacted detail summary and
 *    the operator who ran the verification;
 *  - the probe is free by adapter contract (account fetch / model listing /
 *    SMTP connect+QUIT) — no call, message, email, transcription or
 *    completion is ever produced by an onboarding verification;
 *  - verification results are audited (who, when, which integration).
 *
 * Live-mode guardrails depend on this table: live activation requires the
 * `telephony` integration to be `verified`.
 */
import type { DB } from '../../db/index.ts';
import type { Config } from '../../core/config.ts';
import { nowIso } from '../../core/time.ts';
import { recordAudit } from '../audit/service.ts';
import type { AdapterRegistry, IntegrationKey } from '../../adapters/registry.ts';
import { assertIntegrationKey, runHealthCheck, type HealthCheckResult } from './service.ts';

export type OnboardingState = 'pending' | 'verified' | 'failed' | 'disabled';

export interface OnboardingRecord {
  integration: IntegrationKey;
  provider: string | null;
  state: OnboardingState;
  verifiedAt: string | null;
  verifiedBy: string | null;
  detail: string | null;
  updatedAt: string | null;
}

interface OnboardingRow {
  integration: string;
  provider: string | null;
  state: OnboardingState;
  verified_at: string | null;
  verified_by: string | null;
  detail: string | null;
  updated_at: string;
}

const ALL_KEYS: IntegrationKey[] = ['telephony', 'whatsapp', 'ai', 'speech', 'email', 'discovery'];

function toRecord(row: OnboardingRow): OnboardingRecord {
  return {
    integration: assertIntegrationKey(row.integration),
    provider: row.provider,
    state: row.state,
    verifiedAt: row.verified_at,
    verifiedBy: row.verified_by,
    detail: row.detail,
    updatedAt: row.updated_at,
  };
}

function pendingRecord(key: IntegrationKey): OnboardingRecord {
  return {
    integration: key,
    provider: null,
    state: 'pending',
    verifiedAt: null,
    verifiedBy: null,
    detail: null,
    updatedAt: null,
  };
}

/** Onboarding record for one integration (missing row => pending). */
export function getOnboarding(db: DB, key: IntegrationKey): OnboardingRecord {
  const row = db.prepare('SELECT * FROM provider_onboardings WHERE integration = ?').get(key) as
    | OnboardingRow
    | undefined;
  return row ? toRecord(row) : pendingRecord(key);
}

/** Onboarding records for every integration (missing rows => pending). */
export function getOnboardingState(db: DB): Record<IntegrationKey, OnboardingRecord> {
  const rows = db.prepare('SELECT * FROM provider_onboardings').all() as unknown as OnboardingRow[];
  const out = {} as Record<IntegrationKey, OnboardingRecord>;
  for (const key of ALL_KEYS) {
    const row = rows.find((r) => r.integration === key);
    out[key] = row ? toRecord(row) : pendingRecord(key);
  }
  return out;
}

/** Map a health-probe outcome to an honest onboarding state. */
function stateFromProbe(result: HealthCheckResult): OnboardingState {
  if (result.ok) return 'verified';
  // Not configured / disabled is NOT a credential failure — it is "not yet".
  if (result.state === 'unconfigured' || result.state === 'disabled') return 'pending';
  return 'failed';
}

export interface OnboardingVerification {
  record: OnboardingRecord;
  probe: HealthCheckResult;
}

/**
 * Run the FREE connection probe for one integration and record the outcome
 * as its onboarding state. Never stores credentials; the probe detail is
 * redacted by the health-check layer before persistence.
 *
 * Audited as `integration.onboarded` / `integration.onboarding_failed`.
 */
export async function recordOnboardingVerification(
  db: DB,
  cfg: Config,
  registry: AdapterRegistry,
  key: IntegrationKey,
  actor: { userId: string | null; label: 'owner' | 'staff' | 'system' },
): Promise<OnboardingVerification> {
  // Reuse the health probe: same free ping(), same redaction, same persistence.
  const probe = await runHealthCheck(db, cfg, registry, key);

  const state = stateFromProbe(probe);
  const status = registry[key]?.status?.() ?? null;
  const provider = status?.implementation ?? null;
  const at = nowIso();

  db.prepare(
    `INSERT INTO provider_onboardings (integration, provider, state, verified_at, verified_by, detail, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(integration) DO UPDATE SET
       provider    = excluded.provider,
       state       = excluded.state,
       verified_at = excluded.verified_at,
       verified_by = excluded.verified_by,
       detail      = excluded.detail,
       updated_at  = excluded.updated_at`,
  ).run(
    key,
    provider,
    state,
    state === 'verified' ? probe.checkedAt : null,
    state === 'verified' ? actor.userId : null,
    probe.detail.slice(0, 300),
    at,
  );

  recordAudit(db, {
    actorUserId: actor.userId,
    actorLabel: actor.label,
    action: state === 'verified' ? 'integration.onboarded' : 'integration.onboarding_failed',
    entityType: 'provider_onboarding',
    entityId: key,
    summary: `Provider onboarding ${state} for ${key}${provider ? ` (${provider})` : ''}`,
    details: { integration: key, provider, state, probeState: probe.state },
  });

  return { record: getOnboarding(db, key), probe };
}

/**
 * True when every integration listed is `verified`. Used by the live-mode
 * guardrail (telephony must be verified before live activation) and by the
 * dashboard to show readiness.
 */
export function allVerified(db: DB, keys: IntegrationKey[] = ALL_KEYS): boolean {
  return keys.every((k) => getOnboarding(db, k).state === 'verified');
}
