/**
 * Contact eligibility & suppression (Section 3.2).
 *
 * This is the single authority consulted before ANY outbound action. The rule
 * it encodes is deliberately conservative:
 *
 *   Publicly available contact information does NOT establish permission to
 *   conduct marketing outreach. If consent is uncertain, the answer is
 *   "needs_review" and the action is blocked - never "eligible".
 *
 * Every decision is persisted with the full set of sub-checks so a reviewer
 * can see exactly which rule passed, failed, or could not be determined.
 * Decisions are recorded per channel because a prospect may be reachable on
 * one channel and not another.
 */
import type { DB } from '../../db/index.ts';
import { newId } from '../../core/ids.ts';
import { nowIso } from '../../core/time.ts';
import { normalizePhone, normalizeEmail } from '../leads/normalize.ts';
import { getSetting } from '../settings/service.ts';
import type { Config } from '../../core/config.ts';

export type Channel = 'call' | 'whatsapp_message' | 'whatsapp_call' | 'email';
export type Decision = 'eligible' | 'ineligible' | 'needs_review';

export const POLICY_VERSION = 'uws-eligibility-1.0.0';

/** A single named rule and how it resolved. */
export interface SubCheck {
  code: string;
  label: string;
  result: 'pass' | 'fail' | 'unknown';
  detail: string;
}

export interface EligibilityDecision {
  businessId: string;
  channel: Channel;
  decision: Decision;
  policyVersion: string;
  checks: SubCheck[];
  reasons: string[];
  checkedAt: string;
}

interface LeadRow {
  id: string;
  eligibility_state: string;
  phone_e164: string | null;
  whatsapp_e164: string | null;
  email: string | null;
  merged_into_id: string | null;
}

interface SuppressionRow {
  id: string;
  scope: string;
  reason: string;
  permanent: number;
  evidence: string | null;
  /** Phase 11B: set when an owner lifted this suppression (append-only). */
  lifted_at?: string | null;
  lifted_reason?: string | null;
}

/**
 * Consent recorded against the lead. There is no consent column that a scrape
 * can satisfy: consent must be captured through an explicit, auditable path
 * (an interaction of kind 'consent', or an owner override). Absence of such a
 * record means consent is UNKNOWN, which blocks outreach.
 */
function consentCheck(db: DB, businessId: string, channel: Channel): SubCheck {
  const row = db
    .prepare(
      `SELECT COUNT(*) c FROM interactions
        WHERE business_id = ? AND kind = 'consent'`,
    )
    .get(businessId) as { c: number };

  if (row.c > 0) {
    return {
      code: 'consent_recorded',
      label: 'Explicit consent on file',
      result: 'pass',
      detail: `${row.c} consent record(s) present for this lead.`,
    };
  }
  return {
    code: 'consent_recorded',
    label: 'Explicit consent on file',
    result: 'unknown',
    detail:
      `No explicit consent has been recorded for ${channel}. Published contact details alone do not ` +
      'establish marketing permission, so this blocks outreach until consent is captured or the owner reviews.',
  };
}

/** Opt-out / do-not-contact, which always wins over every other signal. */
function suppressionCheck(db: DB, businessId: string, channel: Channel): SubCheck {
  const lead = db
    .prepare('SELECT phone_e164, whatsapp_e164, email FROM businesses WHERE id = ?')
    .get(businessId) as { phone_e164: string | null; whatsapp_e164: string | null; email: string | null } | undefined;

  const rows = db
    .prepare(
      `SELECT id, scope, reason, permanent, evidence FROM suppression_list
        WHERE lifted_at IS NULL
          AND (business_id = ?
           OR (phone_e164 IS NOT NULL AND phone_e164 = ?)
           OR (whatsapp_e164 IS NOT NULL AND whatsapp_e164 = ?)
           OR (email IS NOT NULL AND email = ?))`,
    )
    .all(businessId, lead?.phone_e164 ?? null, lead?.whatsapp_e164 ?? null, lead?.email ?? null) as unknown as SuppressionRow[];

  if (rows.length === 0) {
    return {
      code: 'not_suppressed',
      label: 'Not on the do-not-contact list',
      result: 'pass',
      detail: 'No opt-out, refusal or do-not-contact record matches this lead on this channel.',
    };
  }
  const reasons = [...new Set(rows.map((r) => r.reason))].join(', ');
  const permanent = rows.every((r) => r.permanent === 1);
  return {
    code: 'not_suppressed',
    label: 'Not on the do-not-contact list',
    result: 'fail',
    detail: `${permanent ? 'Permanent suppression' : 'Suppression'} in effect (${reasons}). This overrides every other check.`,
  };
}

/** Do we actually hold a usable destination for this channel? */
function channelAddressCheck(lead: LeadRow, channel: Channel): SubCheck {
  if (channel === 'call') {
    if (lead.phone_e164) {
      return { code: 'has_destination', label: 'Usable destination on this channel', result: 'pass', detail: 'A normalised phone number is on record.' };
    }
    return { code: 'has_destination', label: 'Usable destination on this channel', result: 'fail', detail: 'No usable phone number on record for a call.' };
  }
  if (channel === 'whatsapp_call' || channel === 'whatsapp_message') {
    const n = lead.whatsapp_e164 ?? lead.phone_e164;
    if (n) {
      return {
        code: 'has_destination',
        label: 'Usable destination on this channel',
        result: 'pass',
        detail: lead.whatsapp_e164 ? 'A WhatsApp number is on record.' : 'Falling back to the voice number (WhatsApp-specific number not confirmed).',
      };
    }
    return { code: 'has_destination', label: 'Usable destination on this channel', result: 'fail', detail: 'No usable WhatsApp or phone number on record.' };
  }
  if (lead.email) {
    return { code: 'has_destination', label: 'Usable destination on this channel', result: 'pass', detail: 'An email address is on record.' };
  }
  return { code: 'has_destination', label: 'Usable destination on this channel', result: 'fail', detail: 'No usable email address on record.' };
}

/** The owner must have switched the channel on AND a provider must exist. */
function channelEnabledCheck(db: DB, cfg: Config, channel: Channel): SubCheck {
  const enabled = getSetting<{ call: boolean; whatsappMessage: boolean; whatsappCall: boolean; email: boolean }>(
    db,
    'eligible_channels',
    cfg,
  );
  const key = channel === 'call' ? 'call' : channel === 'email' ? 'email' : channel === 'whatsapp_call' ? 'whatsappCall' : 'whatsappMessage';
  if (enabled[key]) {
    return { code: 'channel_enabled', label: 'Channel permitted by owner', result: 'pass', detail: `The owner has enabled the ${channel} channel.` };
  }
  return {
    code: 'channel_enabled',
    label: 'Channel permitted by owner',
    result: 'fail',
    detail: `The ${channel} channel is disabled in settings. SMS is never used as a fallback.`,
  };
}

/**
 * Evaluate eligibility for one lead on one channel. Never throws for a normal
 * "not eligible" outcome - that is a first-class result.
 */
export function evaluateEligibility(db: DB, cfg: Config, businessId: string, channel: Channel): EligibilityDecision {
  const lead = db
    .prepare('SELECT id, eligibility_state, phone_e164, whatsapp_e164, email, merged_into_id FROM businesses WHERE id = ?')
    .get(businessId) as LeadRow | undefined;

  const checks: SubCheck[] = [];
  const at = nowIso();

  if (!lead) {
    return {
      businessId,
      channel,
      decision: 'ineligible',
      policyVersion: POLICY_VERSION,
      checks: [{ code: 'lead_exists', label: 'Lead exists', result: 'fail', detail: 'No such lead.' }],
      reasons: ['Lead not found'],
      checkedAt: at,
    };
  }

  if (lead.merged_into_id) {
    checks.push({
      code: 'is_live_record',
      label: 'Record is a live lead',
      result: 'fail',
      detail: 'This record was merged into another lead; outreach must target the surviving record.',
    });
  } else {
    checks.push({ code: 'is_live_record', label: 'Record is a live lead', result: 'pass', detail: 'Record is not a merged duplicate.' });
  }

  checks.push(suppressionCheck(db, businessId, channel));
  checks.push(channelAddressCheck(lead, channel));
  checks.push(channelEnabledCheck(db, cfg, channel));
  checks.push(consentCheck(db, businessId, channel));

  const reasons: string[] = [];
  let decision: Decision;

  const hasFail = checks.some((c) => c.result === 'fail');
  const hasUnknown = checks.some((c) => c.result === 'unknown');

  if (hasFail) {
    decision = 'ineligible';
    for (const c of checks) if (c.result === 'fail') reasons.push(`${c.label}: ${c.detail}`);
  } else if (hasUnknown) {
    decision = 'needs_review';
    for (const c of checks) if (c.result === 'unknown') reasons.push(`${c.label}: ${c.detail}`);
  } else {
    decision = 'eligible';
    reasons.push('All eligibility checks passed.');
  }

  const result: EligibilityDecision = {
    businessId,
    channel,
    decision,
    policyVersion: POLICY_VERSION,
    checks,
    reasons,
    checkedAt: at,
  };

  persistDecision(db, result);
  return result;
}

function persistDecision(db: DB, d: EligibilityDecision): void {
  db.prepare(
    `INSERT INTO eligibility_checks (id, business_id, channel, decision, policy_version, checks_json, reasons_json, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId('elig'), d.businessId, d.channel, d.decision, d.policyVersion, JSON.stringify(d.checks), JSON.stringify(d.reasons), d.checkedAt);

  // Project the most recent decision onto the lead for listing/filters. The
  // call/whatsapp channels are the ones that matter for the pipeline view.
  if (d.channel === 'call' || d.channel === 'whatsapp_message') {
    db.prepare(`UPDATE businesses SET eligibility_state = ?, updated_at = ? WHERE id = ?`).run(
      d.decision,
      d.checkedAt,
      d.businessId,
    );
  }
}

/** Latest decision for a lead+channel, or null. */
export function latestEligibility(db: DB, businessId: string, channel: Channel): EligibilityDecision | null {
  const row = db
    .prepare(
      `SELECT channel, decision, policy_version, checks_json, reasons_json, checked_at
         FROM eligibility_checks WHERE business_id = ? AND channel = ? ORDER BY checked_at DESC, rowid DESC LIMIT 1`,
    )
    .get(businessId, channel) as
    | { channel: Channel; decision: Decision; policy_version: string; checks_json: string; reasons_json: string; checked_at: string }
    | undefined;
  if (!row) return null;
  return {
    businessId,
    channel: row.channel,
    decision: row.decision,
    policyVersion: row.policy_version,
    checks: safeParse<SubCheck[]>(row.checks_json, []),
    reasons: safeParse<string[]>(row.reasons_json, []),
    checkedAt: row.checked_at,
  };
}

function safeParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export interface SuppressionInput {
  businessId: string;
  scope: 'business' | 'phone' | 'whatsapp' | 'email';
  reason:
    | 'opt_out'
    | 'do_not_contact'
    | 'refused'
    | 'invalid_number'
    | 'legal'
    | 'customer_request'
    | 'owner_manual'
    | 'unreachable_permanent';
  source: 'call' | 'message' | 'import' | 'manual' | 'owner' | 'system';
  evidence?: string | null;
  permanent?: boolean;
  createdBy?: string | null;
}

/**
 * Add a suppression record. Suppression is authoritative and MUST survive
 * merges, restores and retention cleanup, so it is append-only here.
 */
export function suppress(db: DB, input: SuppressionInput): { id: string; deduped: boolean } {
  const lead = db.prepare('SELECT phone_e164, whatsapp_e164, email FROM businesses WHERE id = ?').get(input.businessId) as
    | { phone_e164: string | null; whatsapp_e164: string | null; email: string | null }
    | undefined;
  if (!lead) throw new Error(`suppress: lead ${input.businessId} not found`);

  const existing = db
    // Only an ACTIVE suppression dedupes: a lifted row must not swallow a
    // genuine later opt-out (Phase 11B append-only review flow).
    .prepare(`SELECT id FROM suppression_list WHERE business_id = ? AND reason = ? AND lifted_at IS NULL`)
    .get(input.businessId, input.reason) as { id: string } | undefined;
  if (existing) return { id: existing.id, deduped: true };

  const id = newId('sup');
  db.prepare(
    `INSERT INTO suppression_list (id, business_id, scope, phone_e164, whatsapp_e164, email, reason, source, evidence, permanent, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.businessId,
    input.scope,
    input.scope === 'business' || input.scope === 'phone' ? lead.phone_e164 : null,
    input.scope === 'business' || input.scope === 'whatsapp' ? lead.whatsapp_e164 : null,
    input.scope === 'business' || input.scope === 'email' ? lead.email : null,
    input.reason,
    input.source,
    input.evidence ?? null,
    input.permanent === false ? 0 : 1,
    input.createdBy ?? null,
    nowIso(),
  );
  return { id, deduped: false };
}

export function listSuppression(db: DB, businessId: string): SuppressionRow[] {
  return db
    .prepare(
      `SELECT id, scope, reason, permanent, evidence, lifted_at, lifted_reason FROM suppression_list WHERE business_id = ? ORDER BY created_at DESC`,
    )
    .all(businessId) as unknown as SuppressionRow[];
}

/** Count of ACTIVE (not lifted) suppression records, for dashboard/health. */
export function suppressionCount(db: DB): number {
  return (db.prepare('SELECT COUNT(*) c FROM suppression_list WHERE lifted_at IS NULL').get() as { c: number }).c;
}

/** Normalise-and-check helper used by tests and by the import path. */
export function isSuppressedPhone(db: DB, phoneRaw: string): boolean {
  const n = normalizePhone(phoneRaw);
  if (!n.valid || !n.e164) return false;
  const row = db.prepare('SELECT COUNT(*) c FROM suppression_list WHERE phone_e164 = ? AND lifted_at IS NULL').get(n.e164) as { c: number };
  return row.c > 0;
}

export function isSuppressedEmail(db: DB, emailRaw: string): boolean {
  const e = normalizeEmail(emailRaw);
  if (!e.valid || !e.email) return false;
  const row = db.prepare('SELECT COUNT(*) c FROM suppression_list WHERE email = ? AND lifted_at IS NULL').get(e.email) as { c: number };
  return row.c > 0;
}
