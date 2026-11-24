/**
 * Contact enrichment (Phase 4): apply publicly observed contact details to a
 * lead — gap-fill only, evidence always recorded.
 *
 * Honesty rules:
 *  - GAP-FILL ONLY: a lead that already has an email/phone is never touched.
 *    Enrichment can only add what is missing; it never rewrites source data.
 *  - NOTHING IS INVENTED: every applied value was literally present on the
 *    business's own page and passes the same normalizers the import path
 *    uses (normalizeEmail / normalizePhone).
 *  - STRUCTURE-ONLY PHONE GUARD: a bare long digit string (dates, order
 *    numbers, IDs) is never treated as a phone number — the candidate must
 *    carry a `+`, a national trunk `0`, the PK `92` prefix, or a bare PK
 *    mobile shape. Visible-text regexes are greedy; this keeps false
 *    positives out of the lead record.
 *  - NO MACHINE MAILBOXES: noreply-style addresses are recorded nowhere and
 *    never filled — they cannot reach a human.
 *  - EVIDENCE FIRST: every valid candidate is written to
 *    `field_verifications` (state=verified, method + page URL as evidence)
 *    BEFORE any gap-fill, so the decision is always auditable. When a field
 *    was actually filled, a `system` interaction records it on the timeline
 *    (bookkeeping — it can never evidence a customer-facing stage change).
 *
 * Used by two free paths that share one fetch each (no extra network):
 *  - website analysis  (method `website_analysis`, the analysis HTML)
 *  - lead verify route (method `http_fetch`, discoverFromWebsite)
 */
import type { DB } from '../../db/index.ts';
import { newId } from '../../core/ids.ts';
import { nowIso } from '../../core/time.ts';
import { AppError } from '../../core/errors.ts';
import { normalizeEmail, normalizePhone, isMachineMailbox } from './normalize.ts';
import { updateLead } from './repository.ts';
import { recordInteraction } from '../pipeline/interactions.ts';

/** Upper bound of evidence rows written per field per enrichment. */
const MAX_PER_FIELD = 10;
/** Candidates considered from the extractor (which is itself capped). */
const MAX_CANDIDATES = 20;

export interface EnrichmentInput {
  businessId: string;
  /** Email candidates observed on the page, in document order. */
  emails: string[];
  /** Phone candidates observed on the page, in document order. */
  phones: string[];
  /** Page URL the values were observed on — recorded as evidence. */
  evidenceUrl: string;
  /** Verification method recorded on each row: 'website_analysis' | 'http_fetch'. */
  method: string;
}

export interface EnrichmentResult {
  /** Valid candidates after normalization (deduped, capped). */
  emailCandidates: number;
  phoneCandidates: number;
  /** True when this enrichment filled the lead's empty field. */
  emailFilled: boolean;
  phoneFilled: boolean;
  /** True when the lead already had the field — left untouched. */
  emailAlreadySet: boolean;
  phoneAlreadySet: boolean;
  /** field_verifications rows written (evidence for every valid candidate). */
  recorded: number;
}

/** Machine mailboxes are rejected by `isMachineMailbox` (normalize.ts) —
 *  shared with import and manual creation so every entry point agrees. */

/**
 * A candidate may only become a phone number when its SHAPE says "phone":
 * `+` international, `0` national trunk, `92` PK country code, or a bare
 * 10-digit PK mobile (`3xxxxxxxxx`). A long digit string without any of
 * those signals (dates, order numbers) is rejected before normalization.
 */
function looksLikePhone(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.startsWith('+')) return true;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.startsWith('0') || digits.startsWith('92')) return true;
  if (digits.length === 10 && digits.startsWith('3')) return true;
  return false;
}

export async function enrichLeadContacts(db: DB, input: EnrichmentInput): Promise<EnrichmentResult> {
  const existing = (await db
    .prepare('SELECT email, phone_e164, phone_raw FROM businesses WHERE id = ?')
    .get(input.businessId)) as { email: string | null; phone_e164: string | null; phone_raw: string | null } | undefined;
  if (!existing) throw new AppError('not_found', 'Lead not found');

  // --- validate + normalize candidates (nothing is coerced) ---------------
  const emails: string[] = [];
  for (const raw of input.emails.slice(0, MAX_CANDIDATES)) {
    const e = normalizeEmail(raw);
    if (!e.valid || !e.email || isMachineMailbox(e.email)) continue;
    if (!emails.includes(e.email)) emails.push(e.email);
  }
  const phones: { e164: string; original: string }[] = [];
  const seenE164 = new Set<string>();
  for (const raw of input.phones.slice(0, MAX_CANDIDATES)) {
    if (!looksLikePhone(raw)) continue;
    const p = normalizePhone(raw);
    if (!p.valid || !p.e164 || seenE164.has(p.e164)) continue;
    seenE164.add(p.e164);
    phones.push({ e164: p.e164, original: p.original });
  }

  const emailAlreadySet = (existing.email ?? '') !== '';
  const phoneAlreadySet = (existing.phone_e164 ?? '') !== '' || (existing.phone_raw ?? '') !== '';

  // --- evidence first: every valid candidate becomes a verification row ---
  const at = nowIso();
  const evidence = input.evidenceUrl.slice(0, 300);
  const insert = db.prepare(
    `INSERT INTO field_verifications (id, business_id, field, value, state, method, evidence, checked_at)
     VALUES (?, ?, ?, ?, 'verified', ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  );
  let recorded = 0;
  for (const email of emails.slice(0, MAX_PER_FIELD)) {
    recorded += Number((await insert.run(newId('fv'), input.businessId, 'email', email, input.method, evidence, at)).changes);
  }
  for (const phone of phones.slice(0, MAX_PER_FIELD)) {
    recorded += Number((await insert.run(newId('fv'), input.businessId, 'phone', phone.e164, input.method, evidence, at)).changes);
  }

  // --- gap-fill only: never overwrite what the lead already has -----------
  const updates: { field: string; value: string }[] = [];
  if (!emailAlreadySet && emails.length > 0) updates.push({ field: 'email', value: emails[0]! });
  if (!phoneAlreadySet && phones.length > 0) updates.push({ field: 'phone', value: phones[0]!.original });

  let emailFilled = false;
  let phoneFilled = false;
  if (updates.length > 0) {
    // updateLead validates again, keeps phone_raw in step, and writes the
    // audited `lead.update` event — the same path a human edit takes.
    await updateLead(db, input.businessId, updates, { userId: null, label: 'system' });
    emailFilled = updates.some((u) => u.field === 'email');
    phoneFilled = updates.some((u) => u.field === 'phone');
  }

  // --- timeline bookkeeping only when something was actually filled -------
  if (emailFilled || phoneFilled) {
    const filled = [emailFilled ? 'email' : null, phoneFilled ? 'phone' : null].filter((f): f is string => f !== null);
    let host: string;
    try {
      host = new URL(input.evidenceUrl).host;
    } catch {
      host = input.evidenceUrl.slice(0, 60);
    }
    await recordInteraction(db, {
      businessId: input.businessId,
      kind: 'system',
      direction: 'internal',
      summary: `Contact enriched from ${host}: filled ${filled.join(' + ')} from the business's own page`,
      evidence: { method: input.method, source: evidence, filled },
    });
  }

  return {
    emailCandidates: emails.length,
    phoneCandidates: phones.length,
    emailFilled,
    phoneFilled,
    emailAlreadySet,
    phoneAlreadySet,
    recorded,
  };
}
