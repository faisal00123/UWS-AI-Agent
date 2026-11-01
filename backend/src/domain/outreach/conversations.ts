/**
 * Conversations & transcripts (Section 1.8 / Phase 6).
 *
 * A conversation belongs to a call and holds the transcript segments in order.
 * In simulation the segments come from the rehearsal script (source
 * 'simulated'); in live mode Phase 7 will store STT output (source 'stt') and
 * typed operator turns (source 'typed'). Consumers must be able to tell them
 * apart, so `simulated` is surfaced on the summary.
 */
import type { DB } from '../../db/index.ts';
import { notFound } from '../../core/errors.ts';

export const TRANSCRIPT_SOURCES = ['stt', 'typed', 'simulated', 'structured_outcome'] as const;
export type TranscriptSource = (typeof TRANSCRIPT_SOURCES)[number];

export interface TranscriptSegment {
  seq: number;
  speaker: 'agent' | 'prospect' | 'system';
  text: string;
  language: string | null;
  confidence: number | null;
  source: TranscriptSource;
  occurredAt: string;
}

export interface Conversation {
  id: string;
  callId: string | null;
  businessId: string;
  language: string;
  aiIdentityDisclosed: boolean;
  humanRequested: boolean;
  transcriptState: 'none' | 'partial' | 'complete' | 'unavailable';
  summary: string | null;
  extracted: Record<string, unknown> | null;
  startedAt: string;
  endedAt: string | null;
  /** True when this is a rehearsal transcript, not a real conversation. */
  simulated: boolean;
}

export interface ConversationDetail extends Conversation {
  segments: TranscriptSegment[];
}

interface Row {
  id: string;
  call_id: string | null;
  business_id: string;
  language: string;
  ai_identity_disclosed: number;
  human_requested: number;
  transcript_state: 'none' | 'partial' | 'complete' | 'unavailable';
  summary: string | null;
  extracted_json: string | null;
  started_at: string;
  ended_at: string | null;
  simulation: number;
}

interface SegmentRow {
  seq: number;
  speaker: 'agent' | 'prospect' | 'system';
  text: string;
  language: string | null;
  confidence: number | null;
  source: TranscriptSource;
  occurred_at: string;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * `simulation` lives on the call row (a conversation always belongs to a call
 * in this schema); the join keeps the flag truthful even if a conversation is
 * ever written without one.
 */
const SELECT = `
  SELECT c.*, COALESCE(ca.simulation, 0) AS simulation
    FROM conversations c
    LEFT JOIN calls ca ON ca.id = c.call_id`;

function toConversation(r: Row): Conversation {
  return {
    id: r.id,
    callId: r.call_id,
    businessId: r.business_id,
    language: r.language,
    aiIdentityDisclosed: r.ai_identity_disclosed === 1,
    humanRequested: r.human_requested === 1,
    transcriptState: r.transcript_state,
    summary: r.summary,
    extracted: r.extracted_json ? parseJson<Record<string, unknown> | null>(r.extracted_json, null) : null,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    simulated: r.simulation === 1,
  };
}

/** Conversations for a lead, newest first. */
export function listConversations(db: DB, businessId: string, limit = 50): Conversation[] {
  const rows = db
    .prepare(`${SELECT} WHERE c.business_id = ? ORDER BY c.started_at DESC, c.rowid DESC LIMIT ?`)
    .all(businessId, limit) as unknown as Row[];
  return rows.map(toConversation);
}

export function getConversation(db: DB, id: string): ConversationDetail | null {
  const r = db.prepare(`${SELECT} WHERE c.id = ?`).get(id) as Row | undefined;
  if (!r) return null;
  const segs = db
    .prepare(
      `SELECT seq, speaker, text, language, confidence, source, occurred_at
         FROM transcript_segments WHERE conversation_id = ? ORDER BY seq ASC`,
    )
    .all(id) as unknown as SegmentRow[];
  return {
    ...toConversation(r),
    segments: segs.map((s) => ({
      seq: s.seq,
      speaker: s.speaker,
      text: s.text,
      language: s.language,
      confidence: s.confidence,
      source: s.source,
      occurredAt: s.occurred_at,
    })),
  };
}

/** Like getConversation but throws a 404. */
export function requireConversation(db: DB, id: string): ConversationDetail {
  const c = getConversation(db, id);
  if (!c) throw notFound('Conversation');
  return c;
}
