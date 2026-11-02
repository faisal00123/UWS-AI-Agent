/**
 * Live media pipeline (Phase 11B).
 *
 * Drives the conversation lifecycle of a LIVE call:
 *
 *   startConversation    -> create the `conversations` row (language from the
 *                           conversation policy; 'unknown' when the policy is
 *                           multi-language and the prospect's language is not
 *                           yet known)
 *   ingestProspectAudio  -> SpeechPort.transcribe (STT) -> transcript segment
 *                           (source 'stt'); refuses honestly when no speech
 *                           provider is wired (never fabricates text)
 *   generateAgentReply   -> engine.generateTurn (policy + disclosure + turn
 *                           ceiling) -> SpeechPort.synthesize (TTS) for the
 *                           audio the telephony layer speaks; agent turns are
 *                           stored with source 'typed' (generated text, not
 *                           transcribed speech)
 *   finishConversation   -> extractQualification over the full transcript ->
 *                           conversations.extracted_json + lead update
 *                           (interest_level / qualification_status); an
 *                           extracted opt-out suppresses the lead
 *                           (append-only, reason 'opt_out', source 'call')
 *
 * Security / honesty invariants:
 *  - AI disclosure and the turn ceiling come from `conversation_policy` and
 *    are enforced inside the engine — the pipeline cannot bypass them;
 *  - no recording is requested anywhere here: recording needs explicit
 *    consent (calls.recording_enabled / recording_consent stay 0 without it);
 *  - nothing here enables live mode or dials — it only processes media for a
 *    call that already exists;
 *  - STT/TTS/AI failures propagate as AppErrors — segments are only written
 *    for results that actually happened.
 */
import type { DB } from '../../db/index.ts';
import type { Config } from '../../core/config.ts';
import { nowIso } from '../../core/time.ts';
import { newId } from '../../core/ids.ts';
import { AppError } from '../../core/errors.ts';
import type { ConversationPort, SpeechLanguage, SpeechPort } from '../../adapters/types.ts';
import {
  extractQualification,
  generateTurn,
  loadConversationPolicy,
  type Qualification,
} from '../ai/engine.ts';
import { suppress } from '../eligibility/service.ts';

export interface MediaDeps {
  speech: SpeechPort | null;
  ai: ConversationPort | null;
}

export type ConversationLang = 'ur' | 'roman_ur' | 'en' | 'mixed' | 'unknown';

interface ConversationRow {
  id: string;
  call_id: string | null;
  business_id: string;
  language: ConversationLang;
  human_requested: number;
  transcript_state: string;
  started_at: string;
  ended_at: string | null;
}

interface SegmentRow {
  seq: number;
  speaker: 'agent' | 'prospect' | 'system';
  text: string;
  language: string | null;
}

/** Map a conversation language to an STT/TTS language hint. */
function speechLang(lang: ConversationLang): SpeechLanguage {
  return lang === 'ur' ? 'ur' : 'en';
}

function loadConversation(db: DB, conversationId: string): ConversationRow {
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) as
    | ConversationRow
    | undefined;
  if (!row) throw new AppError('not_found', 'Conversation not found');
  return row;
}

function nextSeq(db: DB, conversationId: string): number {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM transcript_segments WHERE conversation_id = ?').get(
    conversationId,
  ) as { m: number };
  return row.m + 1;
}

function insertSegment(
  db: DB,
  conversationId: string,
  input: {
    speaker: 'agent' | 'prospect' | 'system';
    text: string;
    language: string | null;
    confidence?: number | null;
    source: 'stt' | 'typed' | 'simulated' | 'structured_outcome';
  },
): number {
  const seq = nextSeq(db, conversationId);
  db.prepare(
    `INSERT INTO transcript_segments (conversation_id, seq, speaker, text, language, confidence, source, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    conversationId,
    seq,
    input.speaker,
    input.text,
    input.language,
    input.confidence ?? null,
    input.source,
    nowIso(),
  );
  return seq;
}

// --------------------------------------------------------------- start -----

export interface StartConversationInput {
  businessId: string;
  callId?: string | null;
  /** Override the policy-derived language (e.g. inbound call declared ur). */
  language?: ConversationLang;
}

/**
 * Open a live conversation for a call. The language defaults to the
 * conversation policy's single configured language, or 'unknown' when the
 * policy allows several (the prospect's language is learned, not assumed).
 */
export function startConversation(db: DB, cfg: Config, input: StartConversationInput): string {
  const policy = loadConversationPolicy(db, cfg);
  const language: ConversationLang =
    input.language ??
    (policy.languages.length === 1 && (policy.languages[0] === 'ur' || policy.languages[0] === 'roman_ur' || policy.languages[0] === 'en')
      ? policy.languages[0]
      : 'unknown');

  const lead = db.prepare('SELECT id FROM businesses WHERE id = ?').get(input.businessId) as
    | { id: string }
    | undefined;
  if (!lead) throw new AppError('not_found', 'Lead not found');

  const id = newId('cnv');
  const at = nowIso();
  db.prepare(
    `INSERT INTO conversations (id, call_id, business_id, language, ai_identity_disclosed, human_requested,
       transcript_state, summary, extracted_json, started_at, ended_at, created_at)
     VALUES (?, ?, ?, ?, 1, 0, 'none', NULL, NULL, ?, NULL, ?)`,
  ).run(id, input.callId ?? null, input.businessId, language, at, at);
  return id;
}

// ------------------------------------------------------------- prospect ----

export interface ProspectTurn {
  segmentSeq: number;
  text: string;
}

/**
 * Transcribe prospect audio (STT) and append it to the transcript.
 * Refuses with `provider_unavailable` when no speech provider is wired —
 * a missing provider must never yield invented words.
 */
export async function ingestProspectAudio(
  db: DB,
  deps: MediaDeps,
  conversationId: string,
  input: { audio: Uint8Array; mimeType?: string; filename?: string },
): Promise<ProspectTurn> {
  const conversation = loadConversation(db, conversationId);
  if (conversation.ended_at) {
    throw new AppError('conflict', 'Conversation has already ended');
  }
  if (!deps.speech) {
    throw new AppError('provider_unavailable', 'No speech provider is configured — audio cannot be transcribed.');
  }
  const { text } = await deps.speech.transcribe({
    audio: input.audio,
    ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
    ...(input.filename !== undefined ? { filename: input.filename } : {}),
    language: speechLang(conversation.language),
  });
  const trimmed = text.trim();
  if (!trimmed) {
    throw new AppError('provider_unavailable', 'Transcription returned no text — nothing was recorded.');
  }
  const seq = insertSegment(db, conversationId, {
    speaker: 'prospect',
    text: trimmed,
    language: conversation.language,
    source: 'stt',
  });
  db.prepare(`UPDATE conversations SET transcript_state = 'partial' WHERE id = ? AND transcript_state = 'none'`).run(
    conversationId,
  );
  return { segmentSeq: seq, text: trimmed };
}

/**
 * Append a prospect turn captured as text (e.g. typed by an operator). */
export function ingestProspectText(db: DB, conversationId: string, text: string): ProspectTurn {
  const conversation = loadConversation(db, conversationId);
  if (conversation.ended_at) throw new AppError('conflict', 'Conversation has already ended');
  const trimmed = text.trim();
  if (!trimmed) throw new AppError('validation_failed', 'Prospect text is required');
  const seq = insertSegment(db, conversationId, {
    speaker: 'prospect',
    text: trimmed,
    language: conversation.language,
    source: 'typed',
  });
  db.prepare(`UPDATE conversations SET transcript_state = 'partial' WHERE id = ? AND transcript_state = 'none'`).run(
    conversationId,
  );
  return { segmentSeq: seq, text: trimmed };
}

/**
 * Append a system note (e.g. a DTMF digit the prospect pressed). System
 * segments are evidence, not speech: they are excluded from the engine's
 * history and from qualification extraction.
 */
export function ingestSystemNote(db: DB, conversationId: string, text: string): ProspectTurn {
  const conversation = loadConversation(db, conversationId);
  if (conversation.ended_at) throw new AppError('conflict', 'Conversation has already ended');
  const trimmed = text.trim();
  if (!trimmed) throw new AppError('validation_failed', 'System note is required');
  const seq = insertSegment(db, conversationId, {
    speaker: 'system',
    text: trimmed,
    language: null,
    source: 'typed',
  });
  db.prepare(`UPDATE conversations SET transcript_state = 'partial' WHERE id = ? AND transcript_state = 'none'`).run(
    conversationId,
  );
  return { segmentSeq: seq, text: trimmed };
}

// ----------------------------------------------------------------- agent ---

export interface AgentTurn {
  segmentSeq: number;
  text: string;
  /** TTS audio for telephony playback; null when no speech provider exists. */
  audio: Uint8Array | null;
  contentType: string | null;
  /** Sample rate of `audio` when the provider reported one (raw PCM). */
  sampleRate: number | null;
  model: string;
}

/** Full transcript as engine history (oldest first): prospect=user, agent=assistant. */
export function conversationHistory(db: DB, conversationId: string): { role: 'user' | 'assistant'; content: string }[] {
  const rows = db
    .prepare(
      `SELECT seq, speaker, text, language FROM transcript_segments
        WHERE conversation_id = ? AND speaker IN ('agent','prospect')
        ORDER BY seq ASC`,
    )
    .all(conversationId) as unknown as SegmentRow[];
  return rows.map((r) => ({
    role: r.speaker === 'agent' ? 'assistant' : 'user',
    content: r.text,
  }));
}

/**
 * Generate the agent's next turn: engine reply (policy, mandatory AI
 * disclosure, turn ceiling) -> persist the segment -> synthesize speech when
 * a speech provider is wired (returns null audio otherwise — the caller can
 * fall back to text-to-speech at the TwiML layer or skip playback).
 *
 * `opts.speechFormat` asks the provider for a specific byte format: the
 * duplex bridge requests `pcm` so it can convert the reply into telephony
 * frames, while the HTTP seam keeps the default mp3 bytes.
 *
 * Throws `provider_unavailable` when no AI port is wired: no reply is ever
 * fabricated without a model.
 */
export async function generateAgentReply(
  db: DB,
  cfg: Config,
  deps: MediaDeps,
  conversationId: string,
  opts: { speechFormat?: 'mp3' | 'pcm' } = {},
): Promise<AgentTurn> {
  const conversation = loadConversation(db, conversationId);
  if (conversation.ended_at) throw new AppError('conflict', 'Conversation has already ended');
  if (!deps.ai) {
    throw new AppError('provider_unavailable', 'No AI provider is configured — no reply can be generated.');
  }

  const lead = db
    .prepare('SELECT display_name, city, category, website_url FROM businesses WHERE id = ?')
    .get(conversation.business_id) as
    | { display_name: string; city: string | null; category: string | null; website_url: string | null }
    | undefined;
  if (!lead) throw new AppError('not_found', 'Lead not found');

  const policy = loadConversationPolicy(db, cfg);
  const { text, model } = await generateTurn(deps.ai, {
    policy,
    context: {
      businessName: lead.display_name,
      businessWebsite: lead.website_url ?? cfg.businessWebsite,
      leadName: lead.display_name,
      leadCity: lead.city,
      leadBusiness: lead.category,
    },
    history: conversationHistory(db, conversationId),
  });

  const reply = text.trim();
  if (!reply) throw new AppError('internal_error', 'AI provider returned an empty reply — nothing was recorded.');

  const seq = insertSegment(db, conversationId, {
    speaker: 'agent',
    text: reply,
    language: conversation.language,
    source: 'typed',
  });

  let audio: Uint8Array | null = null;
  let contentType: string | null = null;
  let sampleRate: number | null = null;
  if (deps.speech && deps.speech.status().state !== 'unconfigured') {
    const synthesized = await deps.speech.synthesize({
      text: reply,
      language: speechLang(conversation.language),
      ...(opts.speechFormat ? { format: opts.speechFormat } : {}),
    });
    audio = synthesized.audio;
    contentType = synthesized.contentType;
    sampleRate = synthesized.sampleRate ?? null;
  }

  return { segmentSeq: seq, text: reply, audio, contentType, sampleRate, model };
}

// ---------------------------------------------------------------- finish ---

export interface FinishedConversation {
  conversationId: string;
  qualification: Qualification;
  segmentCount: number;
  suppressed: boolean;
  humanRequested: boolean;
}

function looksLikeHumanRequest(text: string): boolean {
  return /\b(human|real person|actual person|live agent)\b/i.test(text);
}

/**
 * Close a live conversation: transcript -> qualification extraction ->
 * conversations.extracted_json + summary + transcript_state, lead update
 * (interest_level / qualification_status), opt-out suppression when the
 * transcript says so, and the human-handoff flag when the prospect asked for
 * a human. Never throws on unparseable content — the conservative
 * `needs_review` result is stored and a human looks at it.
 */
export async function finishConversation(db: DB, conversationId: string): Promise<FinishedConversation> {
  const conversation = loadConversation(db, conversationId);
  const segments = db
    .prepare(
      `SELECT seq, speaker, text, language FROM transcript_segments
        WHERE conversation_id = ? ORDER BY seq ASC`,
    )
    .all(conversationId) as unknown as SegmentRow[];

  const spoken = segments.filter((s) => s.speaker !== 'system');
  const transcript = spoken.map((s) => `${s.speaker}: ${s.text}`).join('\n');
  const qualification = extractQualification(transcript);

  const humanRequested =
    conversation.human_requested === 1 || spoken.some((s) => s.speaker === 'prospect' && looksLikeHumanRequest(s.text));

  const at = nowIso();
  const segmentCount = segments.length;

  db.prepare(
    `UPDATE conversations
        SET ended_at = COALESCE(ended_at, ?),
            transcript_state = ?,
            extracted_json = ?,
            summary = ?,
            human_requested = ?
      WHERE id = ?`,
  ).run(
    at,
    segmentCount > 0 ? 'complete' : 'unavailable',
    JSON.stringify({
      simulated: false,
      ...qualification,
      extractedAt: at,
    }),
    segmentCount > 0
      ? `Live conversation — ${segmentCount} transcript turns; assessment: ${qualification.qualification} / ${qualification.interestLevel}.`
      : 'Live conversation ended with no transcript turns.',
    humanRequested ? 1 : 0,
    conversationId,
  );

  // Lead update (canonical enums straight from the extraction).
  db.prepare(
    `UPDATE businesses SET interest_level = ?, qualification_status = ? WHERE id = ?`,
  ).run(qualification.interestLevel, qualification.qualification, conversation.business_id);

  // Opt-out expressed on the call: suppression is append-only and wins.
  let suppressed = false;
  if (qualification.interestLevel === 'opted_out') {
    const res = suppress(db, {
      businessId: conversation.business_id,
      scope: 'business',
      reason: 'opt_out',
      source: 'call',
      evidence: `Live call transcript opt-out (conversation ${conversationId})`,
      createdBy: null,
    });
    suppressed = !res.deduped;
  }

  return {
    conversationId,
    qualification,
    segmentCount,
    suppressed,
    humanRequested,
  };
}
