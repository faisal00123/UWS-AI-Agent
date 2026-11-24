/**
 * Shared backup artifact formats: verification result types, the manifest
 * table lists, and byte-level helpers used by BOTH the SQLite file path and
 * the PostgreSQL logical-dump path.
 *
 * Kept in its own module so service.ts (SQLite verify) and pgdump.ts (dump
 * format) can share the definitions without an import cycle.
 */
import { createHash } from 'node:crypto';

export interface VerifyCheck {
  code: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  checks: VerifyCheck[];
  counts: Record<string, number>;
}

/** Tables whose presence a restorable snapshot must prove. */
export const REQUIRED_TABLES = [
  'users',
  'businesses',
  'suppression_list',
  'interactions',
  'outreach_attempts',
  'calls',
  'messages',
  'audit_events',
  'daily_reports',
];

/** Tables whose row counts are captured as the backup manifest. */
export const COUNTED_TABLES = [
  ...REQUIRED_TABLES,
  'followup_tasks',
  'portfolio_items',
  'budget_usage',
  'provider_events',
];

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * True when the (decrypted) bytes are a PostgreSQL logical JSONL dump rather
 * than a SQLite database file. Dumps always start with the manifest line
 * `{`...`; SQLite files start with the 16-byte magic "SQLite format 3\0".
 */
export function looksLikeDump(bytes: Buffer): boolean {
  if (bytes.length === 0) return false;
  // Skip a UTF-8 BOM if a tool added one.
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return bytes[start] === 0x7b; // '{'
}

export function looksLikeSqlite(bytes: Buffer): boolean {
  return bytes.length >= 16 && bytes.subarray(0, 16).toString('latin1') === 'SQLite format 3';
}
