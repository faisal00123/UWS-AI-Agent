/**
 * Phase 10: the vanilla-JS dashboard must at least PARSE.
 *
 * The frontend has no build step (plain ES modules served as-is), so a
 * syntax error would only surface in the browser as a blank page. This gate
 * runs `node --check` over every frontend script — the same parser the
 * backend tests run on — so a broken view file fails `npm test` instead of
 * the owner's dashboard.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const frontendDir = path.resolve(backendDir, '..', 'frontend');

function collectScripts(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectScripts(full));
    } else if (/\.(js|mjs)$/.test(entry)) {
      out.push(full);
    }
  }
  return out.sort();
}

describe('Phase 10: frontend scripts parse', () => {
  let files: string[] = [];

  before(() => {
    assert.ok(existsSync(frontendDir), `frontend directory exists at ${frontendDir}`);
    files = collectScripts(frontendDir);
    assert.ok(files.length >= 5, `found the dashboard scripts (${files.length})`);
  });

  test('every frontend .js/.mjs file passes node --check', () => {
    const failures: string[] = [];
    for (const file of files) {
      const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 30_000 });
      if (res.status !== 0) {
        failures.push(`${path.relative(frontendDir, file)}:\n${(res.stderr || res.stdout || '').trim()}`);
      }
    }
    assert.deepEqual(failures, [], `frontend syntax errors:\n\n${failures.join('\n\n')}`);
  });

  test('the dashboard views we changed in Phases 7-9 are present', () => {
    for (const view of ['lead.js', 'leads.js']) {
      const file = path.join(frontendDir, 'views', view);
      assert.ok(files.includes(file), `views/${view} exists and is covered by the gate`);
    }
  });
});
