/**
 * Lead import pipeline (CSV / Excel / manual).
 *
 * Two phases so the UI can show a preview before anything is written:
 *   1. analyzeRecords()  - pure read-only: alias mapping, validation, dupes
 *   2. commitImport()    - one transaction: insert, merge, sources, audit
 *
 * Row statuses: imported | needs_review | merged | rejected
 */
import type { DB } from '../../db/index.ts';
import type { Config } from '../../core/config.ts';
import { newId } from '../../core/ids.ts';
import { nowIso } from '../../core/time.ts';
import { AppError } from '../../core/errors.ts';
import { recordAudit } from '../audit/service.ts';
import {
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizeWebsite,
} from './normalize.ts';
import {
  findDuplicate,
  flagForReview,
  markMerged,
  reconcileSurvivor,
  recordMerge,
  type DuplicateMatch,
  type LeadCandidate,
} from './dedupe.ts';
import type { CsvParseResult } from './csv.ts';
import { parseCsv } from './csv.ts';

export type ImportStatus = 'imported' | 'needs_review' | 'merged' | 'rejected';

export interface FieldProblem {
  field: string;
  message: string;
  /** 'error' rejects the row; 'warning' imports it as needs_review. */
  severity: 'error' | 'warning';
}

export interface AnalyzedRow {
  line: number;
  raw: Record<string, string>;
  candidate: LeadCandidate | null;
  problems: FieldProblem[];
  duplicate: DuplicateMatch | null;
  status: ImportStatus;
}

export interface ImportAnalysis {
  rows: AnalyzedRow[];
  parseErrors: { line: number; message: string }[];
  headers: string[];
  unmappedHeaders: string[];
}

export interface ImportMeta {
  sourceType: 'csv_import' | 'excel_import' | 'manual';
  sourceLabel: string | null;
  sourceUrl: string | null;
  importedBy: { userId: string | null; label: 'owner' | 'staff' | 'system' | 'scheduler' };
}

export interface ImportSummary {
  totalRows: number;
  imported: number;
  needsReview: number;
  merged: number;
  rejected: number;
  parseErrors: { line: number; message: string }[];
  rows: AnalyzedRow[];
  committed: boolean;
}

/** Column aliases (header normalised: lowercase, non-alphanumerics removed). */
import { COLUMN_ALIASES, headerKey } from './headers.ts';
export { COLUMN_ALIASES, headerKey } from './headers.ts';

const REQUIRED_COLUMNS = ['name'];

interface MappedHeaders {
  /** logical field -> column index */
  map: Record<string, number>;
  unmapped: string[];
}

function mapHeaders(headers: string[]): MappedHeaders {
  const map: Record<string, number> = {};
  const used = new Set<number>();
  const unmapped: string[] = [];
  const keys = headers.map(headerKey);

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      const idx = keys.indexOf(alias);
      if (idx !== -1 && !used.has(idx)) {
        map[field] = idx;
        used.add(idx);
        break;
      }
    }
  }
  headers.forEach((h, i) => {
    if (!used.has(i) && h.trim() !== '') unmapped.push(h.trim());
  });
  return { map, unmapped };
}

function pick(values: Record<string, string>, headers: string[], map: Record<string, number>, field: string): string {
  const idx = map[field];
  if (idx === undefined) return '';
  const header = headers[idx];
  if (header === undefined) return '';
  return (values[header] ?? '').trim();
}

/** Analyse parsed rows: alias mapping + validation + duplicate lookup (read-only). */
export function analyzeRecords(
  db: DB,
  headers: string[],
  records: { line: number; values: Record<string, string> }[],
  parseErrors: { line: number; message: string }[] = [],
): ImportAnalysis {
  const { map, unmapped } = mapHeaders(headers);
  const missingRequired = REQUIRED_COLUMNS.filter((f) => map[f] === undefined);

  const rows: AnalyzedRow[] = [];
  if (missingRequired.length > 0) {
    return {
      rows: records.map((r) => ({
        line: r.line,
        raw: r.values,
        candidate: null,
        problems: [
          {
            field: 'name',
            message: `Required column not found (accepted headers: ${(COLUMN_ALIASES.name ?? ['name']).slice(0, 6).join(', ')}…)`,
            severity: 'error',
          },
        ],
        duplicate: null,
        status: 'rejected' as const,
      })),
      parseErrors: [
        ...parseErrors,
        { line: 0, message: `Missing required column: ${missingRequired.join(', ')}` },
      ],
      headers,
      unmappedHeaders: unmapped,
    };
  }

  for (const record of records) {
    const values = record.values;
    const name = pick(values, headers, map, 'name');
    const phoneRaw = pick(values, headers, map, 'phone');
    const whatsappRaw = pick(values, headers, map, 'whatsapp');
    const websiteRaw = pick(values, headers, map, 'website');
    const emailRaw = pick(values, headers, map, 'email');
    const cityRaw = pick(values, headers, map, 'city');
    const categoryRaw = pick(values, headers, map, 'category');
    const contactRaw = pick(values, headers, map, 'contactPerson');
    const sourceUrlRaw = pick(values, headers, map, 'sourceUrl');
    const notesRaw = pick(values, headers, map, 'requirements');

    const problems: FieldProblem[] = [];

    if (name === '') {
      problems.push({ field: 'name', message: 'Business name is required', severity: 'error' });
    } else if (name.length < 2) {
      problems.push({ field: 'name', message: 'Business name is too short', severity: 'error' });
    } else if (name.length > 200) {
      problems.push({ field: 'name', message: 'Business name is too long (max 200)', severity: 'error' });
    }

    const phone = normalizePhone(phoneRaw);
    if (phoneRaw !== '' && !phone.valid) {
      problems.push({
        field: 'phone',
        message: `Phone number is not usable (${phone.reason ?? 'invalid'})`,
        severity: 'warning',
      });
    }
    const whatsapp = normalizePhone(whatsappRaw);
    if (whatsappRaw !== '' && !whatsapp.valid) {
      problems.push({ field: 'whatsapp', message: `WhatsApp number is not usable (${whatsapp.reason ?? 'invalid'})`, severity: 'warning' });
    }
    const site = normalizeWebsite(websiteRaw);
    if (websiteRaw !== '' && !site.valid) {
      problems.push({ field: 'website', message: `Website URL is not usable (${site.reason ?? 'invalid'})`, severity: 'warning' });
    }
    const mail = normalizeEmail(emailRaw);
    if (emailRaw !== '' && !mail.valid) {
      problems.push({ field: 'email', message: `Email is not valid (${mail.reason ?? 'invalid'})`, severity: 'warning' });
    }
    if (phoneRaw === '' && websiteRaw === '' && emailRaw === '') {
      problems.push({
        field: 'contact',
        message: 'No phone, website or email provided - lead cannot be contacted yet',
        severity: 'warning',
      });
    }

    const hasError = problems.some((p) => p.severity === 'error');
    const hasWarning = problems.some((p) => p.severity === 'warning');

    if (hasError) {
      rows.push({ line: record.line, raw: values, candidate: null, problems, duplicate: null, status: 'rejected' });
      continue;
    }

    const candidate: LeadCandidate = {
      displayName: name,
      category: categoryRaw === '' ? null : categoryRaw.slice(0, 80),
      city: cityRaw === '' ? null : cityRaw.slice(0, 80),
      websiteUrl: site.url,
      websiteHost: site.host,
      phoneE164: phone.valid ? phone.e164 : null,
      phoneRaw: phoneRaw === '' ? null : phoneRaw.slice(0, 40),
      email: mail.valid ? mail.email : null,
      whatsappE164: whatsapp.valid ? whatsapp.e164 : null,
      contactPersonName: contactRaw === '' ? null : contactRaw.slice(0, 120),
      sourceUrl: sourceUrlRaw === '' ? null : sourceUrlRaw.slice(0, 500),
      requirements: notesRaw === '' ? null : notesRaw.slice(0, 2000),
    };

    const duplicate = findDuplicate(db, candidate);
    let status: ImportStatus;
    if (duplicate?.autoMerge) status = 'merged';
    else if (duplicate) status = 'needs_review';
    else if (hasWarning) status = 'needs_review';
    else status = 'imported';

    rows.push({ line: record.line, raw: values, candidate, problems, duplicate, status });
  }

  return { rows, parseErrors, headers, unmappedHeaders: unmapped };
}

export function summaryFromRows(rows: AnalyzedRow[], parseErrors: { line: number; message: string }[], committed: boolean): ImportSummary {
  const summary: ImportSummary = {
    totalRows: rows.length,
    imported: 0,
    needsReview: 0,
    merged: 0,
    rejected: 0,
    parseErrors,
    rows,
    committed,
  };
  for (const r of rows) {
    if (r.status === 'imported') summary.imported++;
    else if (r.status === 'needs_review') summary.needsReview++;
    else if (r.status === 'merged') summary.merged++;
    else summary.rejected++;
  }
  return summary;
}

/** Analyse an already-parsed CSV (preview endpoint). */
export function analyzeCsv(db: DB, parsed: CsvParseResult): ImportAnalysis {
  if (parsed.rows.length === 0) {
    return {
      rows: [],
      parseErrors: [...parsed.errors, { line: 1, message: 'No rows found' }],
      headers: [],
      unmappedHeaders: [],
    };
  }
  const headerRow = parsed.rows[0]!;
  const headers = headerRow.cells.map((h) => h.trim());
  const records = parsed.rows.slice(1).map((r) => {
    const values: Record<string, string> = {};
    headers.forEach((h, i) => {
      values[h] = (r.cells[i] ?? '').trim();
    });
    return { line: r.line, values };
  });
  return analyzeRecords(db, headers, records, parsed.errors);
}

/** Commit an analysis in a single transaction. */
export function commitImport(db: DB, _cfg: Config, analysis: ImportAnalysis, meta: ImportMeta): ImportSummary {
  // Structural problems (e.g. the file has no business-name column) are not a
  // partial import - nothing is written and the caller gets a 400.
  const structural = analysis.parseErrors.filter((e) => /Missing required column|No rows found/.test(e.message));
  if (structural.length > 0) {
    throw new AppError('validation_failed', `Import file rejected: ${structural[0]!.message}`, {
      parseErrors: analysis.parseErrors,
      headers: analysis.headers,
    });
  }

  const at = nowIso();

  const insertRow = db.prepare(
    `INSERT INTO businesses (
       id, display_name, normalized_name, category, city, country,
       website_url, website_host, phone_e164, phone_raw, email, whatsapp_e164,
       contact_person_name, source_type, source_url, discovered_at, last_checked_at,
       stage, stage_changed_at, stage_change_reason,
       eligibility_state, merged_into_id, duplicate_status,
       created_by, created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?, 'PK',
       ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
       'new_lead', ?, ?,
       'unknown', ?, ?,
       ?, ?, ?
     )`,
  );

  const insertSource = db.prepare(
    `INSERT INTO lead_sources (id, business_id, source_type, source_url, source_ref, raw_payload_json, imported_by, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertVerification = db.prepare(
    `INSERT INTO field_verifications (id, business_id, field, value, state, method, evidence, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  );

  const insertInteraction = db.prepare(
    `INSERT INTO interactions (id, business_id, kind, direction, summary, evidence_json, occurred_at, created_by)
     VALUES (?, ?, 'import', 'internal', ?, ?, ?, ?)`,
  );

  const run = (): ImportSummary => {
    const rows: AnalyzedRow[] = [];
    for (const row of analysis.rows) {
      if (row.status === 'rejected' || !row.candidate) {
        rows.push(row);
        continue;
      }
      const c = row.candidate;
      const id = newId('biz');
      const normName = normalizeName(c.displayName) || c.displayName.toLowerCase();

      // Re-evaluate duplicates at COMMIT time, not analysis time. Rows inserted
      // earlier in this same file are now visible to the database, so a phone
      // repeated three times in one file merges into the first occurrence
      // instead of tripping the unique index. This also closes the gap where a
      // lead is imported between preview and commit.
      const duplicate = findDuplicate(db, c) ?? row.duplicate;

      let mergedIntoId: string | null = null;
      let status = row.status;

      if (duplicate?.autoMerge) {
        mergedIntoId = duplicate.businessId;
        status = 'merged';
      }

      insertRow.run(
        id,
        c.displayName.trim(),
        normName,
        c.category,
        c.city,
        c.websiteUrl,
        c.websiteHost,
        c.phoneE164,
        c.phoneRaw,
        c.email,
        c.whatsappE164,
        c.contactPersonName,
        meta.sourceType,
        c.sourceUrl,
        at,
        at,
        at, // stage_changed_at
        mergedIntoId
          ? `merged_as_duplicate:${duplicate!.strategy}`
          : status === 'needs_review'
            ? 'imported_needs_review'
            : 'imported',
        mergedIntoId,
        mergedIntoId ? 'duplicate' : duplicate ? 'pending_review' : 'unique',
        meta.importedBy.userId,
        at,
        at,
      );

      // Provenance: keep the original row verbatim.
      insertSource.run(
        newId('src'),
        id,
        meta.sourceType,
        c.sourceUrl ?? meta.sourceUrl,
        meta.sourceLabel,
        JSON.stringify({ ...row.raw, __line: row.line }),
        meta.importedBy.userId,
        at,
      );

      // Per-field verification states (format checks only - never claims of
      // ownership or reachability).
      if (c.phoneE164) {
        insertVerification.run(newId('fv'), id, 'phone', c.phoneE164, 'verified', 'format_check', 'E.164/PK format valid', at);
      } else if (row.raw.phone) {
        insertVerification.run(newId('fv'), id, 'phone', String(row.raw.phone).slice(0, 40), 'failed', 'format_check', 'could not normalise to E.164', at);
      }
      if (c.websiteHost) {
        insertVerification.run(newId('fv'), id, 'website', c.websiteHost, 'verified', 'format_check', 'hostname parsed', at);
      } else if (row.raw.website) {
        insertVerification.run(newId('fv'), id, 'website', String(row.raw.website).slice(0, 200), 'failed', 'format_check', 'unparseable URL', at);
      }
      if (c.email) {
        insertVerification.run(newId('fv'), id, 'email', c.email, 'verified', 'format_check', 'address format valid', at);
      }

      insertInteraction.run(
        newId('itx'),
        id,
        `Lead imported from ${meta.sourceLabel ?? meta.sourceType} (line ${row.line})`,
        JSON.stringify({ problems: row.problems, line: row.line }),
        at,
        meta.importedBy.userId,
      );

      if (mergedIntoId) {
        const survivorId = mergedIntoId;
        // merged_into_id is written as part of insert for auto-merges, so the
        // survivor can now be reconciled from the retained incoming row.
        const outcome = reconcileSurvivor(db, survivorId, id);
        recordMerge(
          db,
          {
            survivorId,
            mergedId: id,
            strategy: duplicate!.strategy,
            matchScore: duplicate!.score,
            actor: meta.importedBy,
            reason: `auto-merged on import from ${meta.sourceLabel ?? meta.sourceType}`,
          },
          outcome,
        );
      } else if (duplicate) {
        flagForReview(db, id, duplicate, meta.importedBy);
      }

      rows.push({ ...row, status, duplicate });
    }

    const summary = summaryFromRows(rows, analysis.parseErrors, true);
    recordAudit(db, {
      actorUserId: meta.importedBy.userId,
      actorLabel: meta.importedBy.label,
      action: 'lead.import',
      entityType: 'lead_import',
      entityId: meta.sourceLabel,
      summary:
        `Imported ${summary.totalRows} row(s) from ${meta.sourceLabel ?? meta.sourceType}: ` +
        `${summary.imported} imported, ${summary.needsReview} need review, ` +
        `${summary.merged} merged, ${summary.rejected} rejected`,
      details: {
        sourceType: meta.sourceType,
        sourceLabel: meta.sourceLabel,
        counts: {
          total: summary.totalRows,
          imported: summary.imported,
          needsReview: summary.needsReview,
          merged: summary.merged,
          rejected: summary.rejected,
        },
        unmappedHeaders: analysis.unmappedHeaders,
      },
    });
    return summary;
  };

  db.exec('BEGIN IMMEDIATE');
  try {
    const summary = run();
    db.exec('COMMIT');
    return summary;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** Convenience: analyze + commit (used by CLI/seed paths and tests). */
export function importCsvText(
  db: DB,
  cfg: Config,
  csvText: string,
  meta: ImportMeta,
): ImportSummary {
  const analysis = analyzeCsv(db, parseCsv(csvText));
  return commitImport(db, cfg, analysis, meta);
}
