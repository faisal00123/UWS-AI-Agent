/**
 * Excel (.xlsx) reading for lead import - converts the first worksheet to the
 * same header/records shape as the CSV parser, so both paths share one
 * validation + deduplication pipeline.
 */
import ExcelJS from 'exceljs';

export interface SheetRows {
  headers: string[];
  records: { line: number; values: Record<string, string> }[];
  errors: { line: number; message: string }[];
}

function cellToString(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const obj = v as unknown as Record<string, unknown>;
    if ('richText' in obj && Array.isArray(obj.richText)) {
      return (obj.richText as { text?: string }[]).map((t) => t.text ?? '').join('').trim();
    }
    if ('text' in obj && typeof obj.text === 'string') return obj.text.trim();
    if ('hyperlink' in obj && typeof obj.hyperlink === 'string') return obj.hyperlink.trim();
    if ('formula' in obj && 'result' in obj) return String(obj.result ?? '').trim();
    if ('error' in obj) return '';
    try {
      return JSON.stringify(v);
    } catch {
      return '';
    }
  }
  return String(v).trim();
}

export async function readExcelBuffer(buffer: Buffer): Promise<SheetRows> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    return { headers: [], records: [], errors: [{ line: 1, message: 'Workbook has no worksheets' }] };
  }

  const errors: { line: number; message: string }[] = [];
  const matrix: string[][] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const values: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      values[colNumber - 1] = cellToString(cell);
    });
    // trim trailing empties
    while (values.length > 0 && (values[values.length - 1] ?? '') === '') values.pop();
    if (values.every((v) => v === '')) return;
    matrix.push(values);
    void rowNumber;
  });

  if (matrix.length === 0) {
    return { headers: [], records: [], errors: [{ line: 1, message: 'Worksheet is empty' }] };
  }

  const headers = (matrix[0] ?? []).map((h) => h.trim());
  const records: { line: number; values: Record<string, string> }[] = [];
  for (let i = 1; i < matrix.length; i++) {
    const row = matrix[i]!;
    const values: Record<string, string> = {};
    headers.forEach((h, idx) => {
      values[h] = (row[idx] ?? '').trim();
    });
    records.push({ line: i + 1, values });
  }
  if (records.length === 0) {
    errors.push({ line: 1, message: 'Worksheet contains a header but no data rows' });
  }
  return { headers, records, errors };
}
