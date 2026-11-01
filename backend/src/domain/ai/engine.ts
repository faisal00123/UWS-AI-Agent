/**
 * AI conversation engine (Phase 11A, Task 2).
 *
 * Sits between the domain and the ConversationPort. Responsibilities:
 *  - compose the SYSTEM prompt from the owner's `conversation_policy`
 *    (languages, mandatory AI disclosure, turn limit, handoff rule);
 *  - drive context-aware conversation turns (history is the message list);
 *  - extract structured qualification from a transcript/completion with
 *    TOLERANT parsing — a model that wraps JSON in prose, fences, or emits a
 *    slightly-off enum must still yield a usable, safe result (never a crash,
 *    never a silently-wrong 'qualified').
 *
 * The engine never performs outreach: it is called by the orchestration
 * layer AFTER the outreach guard has approved an action.
 */
import type { DB } from '../../db/index.ts';
import type { Config } from '../../core/config.ts';
import { getSetting } from '../settings/service.ts';
import type { ConversationPort, ConversationTurn } from '../../adapters/types.ts';

// ------------------------------------------------------------ policy -------

export type ConversationLanguage = 'ur' | 'roman_ur' | 'en';

export interface ConversationPolicy {
  languages: ConversationLanguage[];
  aiDisclosureRequired: boolean;
  maxTurns: number;
  humanHandoffOnRequest: boolean;
}

export function loadConversationPolicy(db: DB, cfg: Config): ConversationPolicy {
  // getSetting falls back to the definition default on a missing/corrupt row.
  return getSetting<ConversationPolicy>(db, 'conversation_policy', cfg);
}

// ------------------------------------------------------- system prompt -----

export interface PromptContext {
  businessName: string;
  businessWebsite: string;
  leadName?: string | null;
  leadCity?: string | null;
  leadBusiness?: string | null;
}

const LANGUAGE_GUIDANCE: Record<ConversationLanguage, string> = {
  en: 'Speak English clearly and professionally.',
  ur: 'اردو میں بات کریں۔ Simple, conversational Urdu — avoid literary formality.',
  roman_ur: 'Roman Urdu: write Urdu in Latin script (e.g. "Assalam-o-Alaikum, main Universal Web Solutions se baat kar raha hoon").',
};

/**
 * Compose the system prompt. Disclosure is ALWAYS included when the policy
 * requires it (and the schema makes aiDisclosureRequired a literal true, so
 * this cannot be turned off through settings).
 */
export function buildSystemPrompt(policy: ConversationPolicy, ctx: PromptContext): string {
  const lines: string[] = [];
  lines.push(`You are a polite sales assistant calling on behalf of ${ctx.businessName} (${ctx.businessWebsite}).`);
  if (policy.aiDisclosureRequired) {
    lines.push(
      'DISCLOSURE (mandatory, say early in the call): "I am an AI assistant calling on behalf of ' +
        `${ctx.businessName}. I am not a human." If the person asks to speak to a human, end the call politely.`,
    );
  }
  lines.push('Languages you may use:');
  for (const lang of policy.languages) {
    lines.push(` - ${LANGUAGE_GUIDANCE[lang]}`);
  }
  lines.push(
    'Rules:',
    ` - Never exceed ${policy.maxTurns} conversation turns; wrap up politely at the limit.`,
    ' - If the person says STOP, "do not call", "band karo", or expresses any opt-out, apologise, confirm they will not be contacted again, and end the call immediately.',
    ' - Never invent prices, deadlines, or guarantees not provided in the script.',
    ' - One question at a time; listen and respond to the actual answer (objection handling over script-reading).',
    ' - At the end of the conversation, output a fenced JSON block with your assessment:',
    '   {"qualification":"unqualified|needs_review|qualified|disqualified","interest_level":"unknown|not_interested|neutral|interested|opted_out","objections":["..."],"next_step":"callback|send_portfolio|meeting|none","notes":"short factual note"}',
  );
  if (ctx.leadName || ctx.leadBusiness) {
    const who = [ctx.leadBusiness, ctx.leadName].filter(Boolean).join(' / ');
    lines.push(`Lead context: ${who}${ctx.leadCity ? ` (city: ${ctx.leadCity})` : ''}. Address them appropriately.`);
  }
  return lines.join('\n');
}

// ------------------------------------------------------------- turns ------

export interface TurnInput {
  policy: ConversationPolicy;
  context: PromptContext;
  /** Full history, oldest first. The last turn may be the lead's message. */
  history: ConversationTurn[];
  maxTokens?: number;
}

/**
 * Generate the assistant's next turn. Throws `unconfigured` when no AI port
 * is wired (never fabricates a reply). The system prompt is injected as a
 * system turn; the provider adapter routes it correctly.
 */
export async function generateTurn(
  ai: ConversationPort,
  input: TurnInput,
): Promise<{ text: string; model: string }> {
  if (input.history.length >= input.policy.maxTurns * 2) {
    // Hard stop: do not call the model at all past the turn ceiling.
    return {
      text: 'Thank you for your time. I will wrap up here — goodbye!',
      model: 'engine_turn_limit',
    };
  }
  const system: ConversationTurn = {
    role: 'system',
    content: buildSystemPrompt(input.policy, input.context),
  };
  return ai.complete({
    messages: [system, ...input.history],
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
  });
}

// -------------------------------------------------- qualification ----------

export type QualificationStatus = 'unqualified' | 'needs_review' | 'qualified' | 'disqualified';
export type InterestLevel = 'unknown' | 'not_interested' | 'neutral' | 'interested' | 'opted_out';
export type NextStep = 'callback' | 'send_portfolio' | 'meeting' | 'none';

export interface Qualification {
  qualification: QualificationStatus;
  interestLevel: InterestLevel;
  objections: string[];
  nextStep: NextStep;
  notes: string;
}

const QUALIFICATIONS: ReadonlySet<string> = new Set([
  'unqualified',
  'needs_review',
  'qualified',
  'disqualified',
]);
const INTERESTS: ReadonlySet<string> = new Set([
  'unknown',
  'not_interested',
  'neutral',
  'interested',
  'opted_out',
]);
const NEXT_STEPS: ReadonlySet<string> = new Set(['callback', 'send_portfolio', 'meeting', 'none']);

/** Loose aliases seen in model output -> canonical enum. */
const QUALIFICATION_ALIASES: Record<string, QualificationStatus> = {
  qualify: 'qualified',
  'sales qualified': 'qualified',
  sql: 'qualified',
  review: 'needs_review',
  'needs human': 'needs_review',
  human: 'needs_review',
  disqualify: 'disqualified',
  'not a fit': 'disqualified',
  junk: 'disqualified',
};
const INTEREST_ALIASES: Record<string, InterestLevel> = {
  'not interested': 'not_interested',
  no: 'not_interested',
  yes: 'interested',
  maybe: 'neutral',
  optedout: 'opted_out',
  'opt out': 'opted_out',
  'opt-out': 'opted_out',
};

function canon<T extends string>(
  raw: unknown,
  allowed: ReadonlySet<string>,
  aliases: Record<string, T>,
  fallback: T,
): T {
  if (typeof raw !== 'string') return fallback;
  const v = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (allowed.has(v)) return v as T;
  const alias = aliases[raw.trim().toLowerCase()] ?? aliases[v];
  if (alias) return alias;
  return fallback;
}

/** Extract the LAST fenced ```json ... ``` block (or bare JSON object). */
function extractJsonCandidate(text: string): string | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let i = fenced.length - 1; i >= 0; i--) {
    const body = fenced[i]?.[1];
    if (body && body.includes('{')) return body;
  }
  // Fall back to the last balanced {...} that parses.
  const objects = [...text.matchAll(/\{[\s\S]*?\}/g)];
  for (let i = objects.length - 1; i >= 0; i--) {
    const candidate = objects[i]?.[0];
    if (candidate) return candidate;
  }
  return null;
}

/**
 * Tolerant qualification extraction from a transcript/completion.
 *
 * Never throws. On anything unparseable the result is the conservative
 * `needs_review` + `unknown` interest — a human looks at it instead of the
 * system guessing 'qualified' from noise. `opted_out` always wins when the
 * text contains an opt-out signal.
 */
export function extractQualification(text: string): Qualification {
  const conservative: Qualification = {
    qualification: 'needs_review',
    interestLevel: 'unknown',
    objections: [],
    nextStep: 'none',
    notes: 'Could not parse a structured assessment; needs human review.',
  };

  // Opt-out words in ANY casing anywhere in the text are authoritative.
  const lower = text.toLowerCase();
  const optOutSignal = /\b(stop|unsubscribe|do not call|don'?t call|band karo|ruk jao|no messages)\b/.test(lower);

  const candidate = extractJsonCandidate(text);
  if (!candidate) {
    return optOutSignal
      ? { ...conservative, qualification: 'disqualified', interestLevel: 'opted_out', notes: 'Opt-out signal detected.' }
      : conservative;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return optOutSignal
      ? { ...conservative, qualification: 'disqualified', interestLevel: 'opted_out', notes: 'Opt-out signal detected.' }
      : conservative;
  }
  if (!parsed || typeof parsed !== 'object') return conservative;

  const obj = parsed as Record<string, unknown>;
  const rawObjections = Array.isArray(obj['objections'])
    ? (obj['objections'] as unknown[]).filter((o): o is string => typeof o === 'string').slice(0, 10)
    : [];

  let interest = canon<InterestLevel>(obj['interest_level'] ?? obj['interestLevel'], INTERESTS, INTEREST_ALIASES, 'unknown');
  let qualification = canon<QualificationStatus>(
    obj['qualification'] ?? obj['qualification_status'],
    QUALIFICATIONS,
    QUALIFICATION_ALIASES,
    'needs_review',
  );

  if (optOutSignal) {
    // The person said stop: the assessment cannot remain 'interested'.
    interest = 'opted_out';
    qualification = 'disqualified';
  }
  // Safety asymmetry: 'interested' alone never implies 'qualified'.
  if (qualification === 'qualified' && interest === 'opted_out') {
    qualification = 'disqualified';
  }

  const nextStep = canon<NextStep>(obj['next_step'] ?? obj['nextStep'], NEXT_STEPS, {}, 'none');

  return {
    qualification,
    interestLevel: interest,
    objections: rawObjections,
    nextStep,
    notes: typeof obj['notes'] === 'string' ? obj['notes'].slice(0, 500) : '',
  };
}
