/**
 * Dashboard accuracy: the import-preview row problems must render as their
 * MESSAGE text.
 *
 * `summary.rows[].problems` is `FieldProblem[]` ({ field, message, severity }),
 * but the preview table used to pipe each element straight through `esc()`,
 * which stringifies an object — every cell showed "[object Object]" instead of
 * the validation message. This test renders a real preview payload through the
 * actual view function (imported as an ES module, no DOM needed) and pins both
 * the fix and the XSS escaping.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', 'frontend');

let importPreviewHtml: (preview: Record<string, unknown>) => string;

describe('import preview renders field problems honestly', () => {
  before(async () => {
    const mod = await import(pathToFileURL(path.join(frontendDir, 'views', 'leads.js')).href);
    importPreviewHtml = mod.importPreviewHtml;
    assert.equal(typeof importPreviewHtml, 'function', 'importPreviewHtml is exported for this test');
  });

  test('FieldProblem objects render their message, never [object Object]', () => {
    const html = importPreviewHtml({
      totalRows: 1,
      imported: 0,
      merged: 0,
      needsReview: 1,
      rejected: 0,
      parseErrors: [],
      unmappedHeaders: [],
      rows: [
        {
          line: 2,
          status: 'needs_review',
          name: 'Karachi Care Clinic',
          problems: [
            { field: 'phone', message: 'Phone number is not usable (too short)', severity: 'warning' },
            { field: 'email', message: 'Email is not valid (missing @)', severity: 'warning' },
          ],
          duplicate: null,
        },
      ],
    });

    assert.ok(html.includes('Phone number is not usable (too short)'), 'problem message is shown');
    assert.ok(html.includes('Email is not valid (missing @)'), 'second problem message is shown');
    assert.ok(!html.includes('[object Object]'), 'no stringified objects leak into the table');
  });

  test('problem messages are HTML-escaped before interpolation', () => {
    const html = importPreviewHtml({
      totalRows: 1,
      imported: 0,
      merged: 0,
      needsReview: 0,
      rejected: 1,
      parseErrors: [],
      unmappedHeaders: [],
      rows: [
        {
          line: 2,
          status: 'rejected',
          name: 'Evil <img src=x onerror=alert(1)>',
          problems: [{ field: 'name', message: 'Business name is required <script>alert(2)</script>', severity: 'error' }],
          duplicate: null,
        },
      ],
    });

    assert.ok(!html.includes('<script>alert(2)</script>'), 'problem message is escaped');
    assert.ok(html.includes('&lt;script&gt;'), 'escaped form is present instead');
    assert.ok(!html.includes('<img src=x'), 'row name is escaped too');
  });
});
