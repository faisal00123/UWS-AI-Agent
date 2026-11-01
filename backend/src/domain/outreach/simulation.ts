/**
 * Simulation adapters (Section 3.4 / Phase 6).
 *
 * Simulation is a FIRST-CLASS, fully supported mode — not a mock that fakes
 * success. A simulated call exercises the entire pipeline (guard, ledger,
 * counters, call row, transcript, timeline) while guaranteeing that no real
 * person is ever contacted. Every artefact it writes is labelled:
 *
 *   - calls.provider = 'simulation', calls.simulation = 1
 *   - conversations/transcript segments carry source 'simulated' and an
 *     explicit "no real call was placed" system turn
 *   - the timeline interaction has simulation = 1, so it can never evidence a
 *     stage change or complete a follow-up
 *
 * The outcome is deterministic (derived from the lead id + business day), so
 * the same rehearsal always plays out the same way — reproducible for tests
 * and for operator training. It never invents quotes from a real person: the
 * "prospect" turns are clearly marked scripted placeholders.
 */
import type { DB } from '../../db/index.ts';
import { newId } from '../../core/ids.ts';
import { nowIso } from '../../core/time.ts';

export interface SimScenario {
  /** High-level rehearsal scenario chosen for this lead+day. */
  key: 'interested' | 'not_interested' | 'no_answer' | 'busy';
  answered: boolean;
  humanRequested: boolean;
  durationSeconds: number;
}

/** FNV-1a: small, stable, dependency-free hash for deterministic choices. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Pick the rehearsal scenario for a lead on a given day. Deterministic in
 * (businessId, dayKey): the same lead rehearses the same way all day, and a
 * "retry" rehearsal the next day may play differently — mirroring how real
 * retries behave without any randomness that would make tests flaky.
 */
export function simScenarioFor(businessId: string, dayKey: string): SimScenario {
  const h = fnv1a(`${businessId}|${dayKey}`);
  const bucket = h % 100;
  // 45% answered+interested, 25% answered+not interested, 20% no answer, 10% busy.
  const key: SimScenario['key'] =
    bucket < 45 ? 'interested' : bucket < 70 ? 'not_interested' : bucket < 90 ? 'no_answer' : 'busy';
  const answered = key === 'interested' || key === 'not_interested';
  // Unsigned shifts: h can exceed 2^31, and a signed >> would produce a
  // negative remainder (breaking the duration CHECK and the flag test).
  const humanRequested = answered && (h >>> 8) % 100 < 15; // ~15% of answered rehearsals
  const durationSeconds = answered ? 45 + ((h >>> 16) % 136) : 0; // 45..180s
  return { key, answered, humanRequested, durationSeconds };
}

export interface SimCallInput {
  businessId: string;
  businessName: string;
  toNumber: string;
  attemptId: string;
  channel: 'call' | 'whatsapp_call';
  dayKey: string;
  createdBy?: string | null;
}

export interface SimCallRow {
  id: string;
  conversationId: string | null;
  outcome: string;
  status: string;
  scenario: SimScenario;
}

const OUTCOME_BY_SCENARIO: Record<SimScenario['key'], { status: string; outcome: string }> = {
  interested: { status: 'completed', outcome: 'interested' },
  not_interested: { status: 'completed', outcome: 'not_interested' },
  no_answer: { status: 'no_answer', outcome: 'unanswered' },
  busy: { status: 'busy', outcome: 'unanswered' },
};

/**
 * Execute one simulated call. Must be called inside a transaction by the
 * orchestration service (the caller has already consumed the daily counter).
 * Returns the created call row and conversation reference.
 */
export function placeSimulatedCall(db: DB, input: SimCallInput): SimCallRow {
  const scenario = simScenarioFor(input.businessId, input.dayKey);
  const map = OUTCOME_BY_SCENARIO[scenario.key];
  const callId = newId('cal');
  const at = nowIso();
  const started = Date.parse(at);
  const answeredAt = scenario.answered ? new Date(started + 3000).toISOString() : null;
  const endedAt = new Date(started + Math.max(scenario.durationSeconds, 1) * 1000).toISOString();

  db.prepare(
    `INSERT INTO calls (id, attempt_id, business_id, direction, channel, provider, provider_call_id, status, outcome,
       to_number_e164, recording_enabled, recording_consent, recording_ref, started_at, answered_at, ended_at,
       duration_seconds, failure_code, failure_detail, simulation, counts_against_daily_limit, daily_bucket,
       cost_minor, cost_currency, cost_state, created_at, updated_at)
     VALUES (?, ?, ?, 'outbound', ?, 'simulation', NULL, ?, ?, ?, 0, 0, NULL, ?, ?, ?, ?, NULL, ?, 1, 1, ?, NULL, NULL, 'unavailable', ?, ?)`,
  ).run(
    callId,
    input.attemptId,
    input.businessId,
    input.channel,
    map.status,
    map.outcome,
    input.toNumber,
    at,
    answeredAt,
    endedAt,
    scenario.durationSeconds,
    scenario.answered ? null : `simulated_${map.status}`,
    input.dayKey,
    at,
    at,
  );

  let conversationId: string | null = null;
  if (scenario.answered) {
    conversationId = writeSimulatedConversation(db, {
      callId,
      businessId: input.businessId,
      businessName: input.businessName,
      scenario,
      startedAt: answeredAt ?? at,
    });
  }
  return { id: callId, conversationId, outcome: map.outcome, status: map.status, scenario };
}

interface SimConversationInput {
  callId: string;
  businessId: string;
  businessName: string;
  scenario: SimScenario;
  startedAt: string;
}

/**
 * Write the rehearsal transcript. Honesty rules baked into the content:
 *  - the first segment is a system turn stating this is a simulation
 *  - the agent always discloses it is an AI (ai_identity_disclosed = 1)
 *  - prospect turns are explicit scripted placeholders, never invented quotes
 */
function writeSimulatedConversation(db: DB, input: SimConversationInput): string {
  const id = newId('cnv');
  const at = nowIso();
  const interested = input.scenario.key === 'interested';

  db.prepare(
    `INSERT INTO conversations (id, call_id, business_id, language, ai_identity_disclosed, human_requested,
       transcript_state, summary, extracted_json, started_at, ended_at, created_at)
     VALUES (?, ?, ?, 'en', 1, ?, 'complete', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.callId,
    input.businessId,
    input.scenario.humanRequested ? 1 : 0,
    `[SIMULATION] Rehearsal call for ${input.businessName}. No real call was placed and no real person responded. ` +
      `Scripted scenario: ${input.scenario.key}${input.scenario.humanRequested ? ' (scripted prospect asks for a human)' : ''}.`,
    JSON.stringify({
      simulated: true,
      scenario: input.scenario.key,
      humanRequested: input.scenario.humanRequested,
      note: 'Simulation only — this is NOT a real qualification and must not be treated as prospect intent.',
    }),
    input.startedAt,
    at,
    at,
  );

  const segments: { speaker: 'system' | 'agent' | 'prospect'; text: string; language: string }[] = [
    {
      speaker: 'system',
      text: '[SIMULATION] This transcript is a generated rehearsal. No real call was placed and no real person responded.',
      language: 'en',
    },
    {
      speaker: 'agent',
      text:
        `Hello, this is the AI calling assistant from Universal Web Solutions, calling about your business in ` +
        `${input.businessName}. I am an AI, and I disclose that up front. This is a simulated rehearsal call — ` +
        'in live mode this is where the approved opening script would be spoken.',
      language: 'en',
    },
    {
      speaker: 'prospect',
      text: `[simulated] Scripted prospect response for scenario "${input.scenario.key}" — not a real person's words.`,
      language: 'en',
    },
  ];
  if (input.scenario.humanRequested) {
    segments.push({
      speaker: 'prospect',
      text: '[simulated] Scripted prospect turn: "please have a human from your team contact me" — a human handoff is flagged.',
      language: 'en',
    });
  }
  segments.push({
    speaker: 'agent',
    text: interested
      ? 'Thank you. In live mode the assistant would confirm the best way to share our portfolio and book a human follow-up.'
      : 'Understood, thank you for your time. In live mode the assistant would close politely and honour any opt-out immediately.',
    language: 'en',
  });

  const stmt = db.prepare(
    `INSERT INTO transcript_segments (conversation_id, seq, speaker, text, language, confidence, source, occurred_at)
     VALUES (?, ?, ?, ?, ?, NULL, 'simulated', ?)`,
  );
  let t = Date.parse(input.startedAt);
  segments.forEach((s, i) => {
    stmt.run(id, i + 1, s.speaker, s.text, s.language, new Date(t).toISOString());
    t += 4000;
  });
  return id;
}

/**
 * Summary text for the timeline interaction produced by a simulated call.
 * Deliberately prefixed so nobody can mistake it for real contact in a list.
 */
export function simInteractionSummary(scenario: SimScenario): string {
  return `[SIMULATION] Rehearsal call (${scenario.key}) — no real person was contacted`;
}
