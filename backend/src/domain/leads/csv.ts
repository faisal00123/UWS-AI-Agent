/**
 * RFC 4180 CSV parser with delimiter sniffing.
 *
 * Handles quoted fields, embedded commas/newlines/quotes, CRLF & LF, UTF-8 BOM
 * and reports row-level problems instead of throwing. Written in-house (and
 * unit tested) to avoid pulling a parser dependency for a small, well-specified
 * format.
 */
import { headerMatchesField } from './headers.ts';

export interface CsvRow {
  /** 1-based line number in the source file. */
  line: number;
  cells: string[];
}

export interface CsvParseResult {
  rows: CsvRow[];
  delimiter: ',' | ';' | '\t' | '|';
  errors: { line: number; message: string }[];
  /** True when the file had a UTF-8 BOM (stripped). */
  hadBom: boolean;
}

export function stripBom(text: string): { text: string; hadBom: boolean } {
  if (text.charCodeAt(0) === 0xfeff) return { text: text.slice(1), hadBom: true };
  return { text, hadBom: false };
}

export function sniffDelimiter(headerLine: string): ',' | ';' | '\t' | '|' {
  const candidates: (',' | ';' | '\t' | '|')[] = [',', ';', '\t', '|'];
  let best: ',' | ';' | '\t' | '|' = ',';
  let bestCount = 0;
  for (const d of candidates) {
    // Count only outside quotes.
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < headerLine.length; i++) {
      const c = headerLine[i];
      if (c === '"') inQuotes = !inQuotes;
      else if (c === d && !inQuotes) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

export function parseCsv(
  input: string,
  options: { delimiter?: string; maxRows?: number } = {},
): CsvParseResult {
  const { text, hadBom } = stripBom(input);
  const errors: { line: number; message: string }[] = [];
  const maxRows = options.maxRows;

  // Determine delimiter from the first non-empty line.
  const firstLineEnd = text.search(/\r\n|\n|\r/);
  const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  const delimiter = (options.delimiter as ',' | ';' | '\t' | '|') ?? sniffDelimiter(firstLine);

  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let rowStartLine = 1;
  let fieldWasQuoted = false;
  /** Index where an over-limit read stopped, or -1 when the file was fully read. */
  let stopIndex = -1;

  const pushField = (): void => {
    // Symmetric with the export writer: a formula-guard apostrophe added by
    // leadsToCsv is removed here, so export → import round-trips exactly.
    cells.push(stripFormulaGuard(field));
    field = '';
    fieldWasQuoted = false;
  };
  const pushRow = (): void => {
    pushField();
    // Skip completely empty lines.
    if (!(cells.length === 1 && cells[0]!.trim() === '')) {
      rows.push({ line: rowStartLine, cells });
    }
    cells = [];
    rowStartLine = line;
  };

  for (let i = 0; i < text.length; i++) {
    // Row cap: stop reading once the limit is filled so a hostile multi-MB
    // file cannot build millions of row objects before any policy check runs.
    // The check sits at the top of the loop, so a file that ends exactly on
    // the limit is read to completion — only genuinely unread rows flag a stop.
    if (maxRows !== undefined && rows.length >= maxRows) {
      stopIndex = i;
      break;
    }
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"') {
      if (field !== '' && !fieldWasQuoted) {
        errors.push({ line, message: 'Unexpected quote in the middle of a field' });
      }
      inQuotes = true;
      fieldWasQuoted = true;
      continue;
    }
    if (c === delimiter) {
      pushField();
      continue;
    }
    if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      line++;
      pushRow();
      rowStartLine = line;
      continue;
    }
    if (c === '\n') {
      line++;
      pushRow();
      rowStartLine = line;
      continue;
    }
    field += c;
  }

  if (stopIndex === -1) {
    if (inQuotes) {
      errors.push({ line: rowStartLine, message: 'Unterminated quoted field at end of file' });
    }
    if (field !== '' || cells.length > 0) {
      pushRow();
    }
  } else {
    // Over-limit stop: report it only when real content was left unread — a
    // file ending exactly on the limit plus trailing blank lines is complete,
    // not truncated.
    let j = stopIndex;
    while (j < text.length) {
      const cc = text.charCodeAt(j);
      if (cc !== 10 && cc !== 13 && cc !== 9 && cc !== 32 && cc !== 12 && cc !== 11) break;
      j++;
    }
    if (j < text.length) {
      errors.push({ line: rowStartLine, message: `Row limit of ${maxRows} reached — the rest of the file was not read` });
    }
  }

  if (rows.length === 0) {
    errors.push({ line: 1, message: 'File contains no data rows' });
  }

  return { rows, delimiter, errors, hadBom };
}

/** Build a line number -> cells map using a header row (case/space insensitive). */
export interface HeaderMappedRows {
  headers: string[];
  records: { line: number; values: Record<string, string> }[];
  errors: { line: number; message: string }[];
}

export function mapByHeader(result: CsvParseResult, requiredHeaders: string[]): HeaderMappedRows {
  const errors = [...result.errors];
  const headerRow = result.rows[0];
  if (!headerRow) {
    return { headers: [], records: [], errors: [...errors, { line: 1, message: 'Missing header row' }] };
  }
  const headers = headerRow.cells.map((h) => h.trim());

  // Required columns are resolved through the shared alias table so the CSV
  // preview accepts the same header variants the import pipeline does.
  const missing = requiredHeaders.filter((field) => !headers.some((h) => headerMatchesField(h, field)));
  if (missing.length > 0) {
    errors.push({
      line: headerRow.line,
      message: `Missing required column(s): ${missing.join(', ')}. Found: ${headers.join(', ') || '(none)'}`,
    });
    return { headers, records: [], errors };
  }

  const records: { line: number; values: Record<string, string> }[] = [];
  for (const row of result.rows.slice(1)) {
    const values: Record<string, string> = {};
    headers.forEach((h, i) => {
      values[h] = (row.cells[i] ?? '').trim();
    });
    records.push({ line: row.line, values });
  }
  return { headers, records, errors };
}

/* ------------------------------------------------------------------ export -- */

/**
 * Export column order. Every header here resolves through COLUMN_ALIASES on
 * re-import EXCEPT the read-only bookkeeping columns (Stage, Score, Interest
 * Level, Duplicate Status, Source Type, Discovered), which the import mapper
 * deliberately ignores — so an export → import round trip preserves exactly
 * the editable record (name, category, city, address, coordinates, contact
 * details, requirements, source URL) and never fights over derived fields.
 */
export const LEAD_EXPORT_HEADERS = [
  'Name',
  'Category',
  'City',
  'Address',
  'Lat',
  'Lon',
  'Website',
  'Phone',
  'WhatsApp',
  'Email',
  'Contact Person',
  'Requirements',
  'Stage',
  'Score',
  'Interest Level',
  'Duplicate Status',
  'Source Type',
  'Source URL',
  'Discovered',
] as const;

/**
 * Spreadsheet formula markers (CSV/formula injection, OWASP). Lead data is
 * UNTRUSTED: OSM tags are publicly editable and CSV values are typed by
 * anyone, so a cell like `=cmd|'/C calc'!A0`, `+…`, `-…` or `@SUM(…)` would
 * be EVALUATED by Excel/LibreOffice/Sheets when the exported file is opened.
 */
const FORMULA_MARKERS = new Set(['=', '+', '-', '@']);
/** Leading whitespace + control characters — a formula can hide behind them. */
const LEADING_TRIM_RE = /^[\u0000-\u0020\u007f]+/;

/** The first character a spreadsheet would treat as the cell's content. */
function firstContentChar(s: string): string {
  return s.replace(LEADING_TRIM_RE, '').charAt(0);
}

/**
 * Neutralise formula-shaped values with a single leading apostrophe — the
 * universal spreadsheet "this is text" marker. Excel renders the ORIGINAL
 * value (the apostrophe is never displayed) and never evaluates it; our own
 * parser strips it again (see stripFormulaGuard), so export → import keeps
 * the exact value. Ordinary cells are returned untouched.
 */
function neutralizeFormula(s: string): string {
  return FORMULA_MARKERS.has(firstContentChar(s)) ? `'${s}` : s;
}

/**
 * Remove ONE safety apostrophe written by neutralizeFormula. Applied by the
 * parser so the export round-trips byte-faithfully, and so a hand-made file
 * using Excel's own apostrophe text marker (`'+92300…`) imports as the value
 * its author saw on screen. A leading apostrophe NOT followed (after
 * whitespace/control characters) by a formula marker is kept as data.
 */
function stripFormulaGuard(s: string): string {
  if (!s.startsWith("'")) return s;
  return FORMULA_MARKERS.has(firstContentChar(s.slice(1))) ? s.slice(1) : s;
}

/** RFC 4180 cell: formula-guard first, then quote on delimiter/quote/newline/edge space. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  // The apostrophe is part of the cell's data, so it must be added BEFORE
  // deciding what to quote (it can never trigger quoting itself).
  const s = neutralizeFormula(String(value));
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialise raw `businesses` rows (as selected by `selectLeadsForExport`)
 * to CSV. Pure: no database access, no formatting of derived values beyond
 * String() — coordinates and score are written exactly as stored, and an
 * absent value is an empty cell, never a placeholder.
 *
 * Line endings are CRLF per RFC 4180 (Excel + our own parser accept both);
 * the trailing CRLF terminates the last row.
 */
export function leadsToCsv(rows: readonly Record<string, unknown>[]): string {
  const lines: string[] = [LEAD_EXPORT_HEADERS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.display_name,
        r.category,
        r.city,
        r.address,
        r.latitude,
        r.longitude,
        r.website_url,
        r.phone_e164,
        r.whatsapp_e164,
        r.email,
        r.contact_person_name,
        r.requirements,
        r.stage,
        r.score,
        r.interest_level,
        r.duplicate_status,
        r.source_type,
        r.source_url,
        r.discovered_at,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
