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

export function parseCsv(input: string, options: { delimiter?: string } = {}): CsvParseResult {
  const { text, hadBom } = stripBom(input);
  const errors: { line: number; message: string }[] = [];

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

  const pushField = (): void => {
    cells.push(field);
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

  if (inQuotes) {
    errors.push({ line: rowStartLine, message: 'Unterminated quoted field at end of file' });
  }
  if (field !== '' || cells.length > 0) {
    pushRow();
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
