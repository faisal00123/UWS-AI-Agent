/**
 * Environment / deployment diagnostics.
 *
 *   cmd:  npm run doctor
 *
 * Prints runtime, database, migration, operating-state and provider status.
 * Never prints secrets - only whether a credential is present.
 */
import { loadConfig } from '../core/config.ts';
import { openDatabase } from '../db/index.ts';
import { pendingMigrationFiles } from '../db/migrate.ts';
import { getOperatingState, summarise } from '../domain/state/service.ts';
import { countOwners } from '../domain/auth/service.ts';
import { latestBackup, latestRestoreTest } from '../domain/backup/service.ts';
import { existsSync, accessSync, constants as fsConstants } from 'node:fs';

const ok = (s: string): string => `  [ OK ] ${s}`;
const warn = (s: string): string => `  [WARN] ${s}`;
const bad = (s: string): string => `  [FAIL] ${s}`;

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(bad(`configuration: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
    return;
  }

  const lines: string[] = [];
  lines.push('UWS AI Sales Agent - doctor\n');

  lines.push('Runtime');
  lines.push(ok(`node ${process.version}`));
  lines.push(ok(`NODE_ENV=${config.nodeEnv}`));
  lines.push(
    config.ephemeralSessionSecret
      ? warn('SESSION_SECRET not set - an ephemeral secret is used (sessions reset on restart)')
      : ok('SESSION_SECRET provided'),
  );
  lines.push(ok(`timezone ${config.businessTimezone}`));

  lines.push('\nDatabase');
  let db;
  try {
    db = openDatabase(config.databasePath);
    lines.push(ok(`open: ${config.databasePath}`));
    const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: number } | undefined;
    lines.push(fk?.foreign_keys === 1 ? ok('foreign_keys ON') : bad('foreign_keys OFF'));
    const pending = pendingMigrationFiles(db);
    lines.push(
      pending.length > 0
        ? bad(`pending migrations: ${pending.join(', ')} - run: npm run migrate`)
        : ok('migrations up to date'),
    );
    const owners = countOwners(db);
    lines.push(owners > 0 ? ok(`${owners} active owner account(s)`) : warn('no owner account - run: npm run setup'));
    const state = getOperatingState(db);
    const summary = summarise(db);
    lines.push(ok(`mode=${state.mode} paused=${state.paused} emergencyStop=${state.emergencyStop}`));
    lines.push(`         outreach: ${summary.outreachEnabled ? 'ENABLED' : 'BLOCKED'} - ${summary.reason}`);
    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM businesses) leads,
                (SELECT COUNT(*) FROM suppression_list) suppressions,
                (SELECT COUNT(*) FROM audit_events) audit_events`,
      )
      .get() as { leads: number; suppressions: number; audit_events: number };
    lines.push(
      ok(`data: ${counts.leads} lead(s), ${counts.suppressions} suppression record(s), ${counts.audit_events} audit event(s)`),
    );
  } catch (err) {
    lines.push(bad(`database: ${err instanceof Error ? err.message : String(err)}`));
    process.exitCode = 1;
  }

  lines.push('\nIntegrations (values never displayed)');
  for (const p of config.providers) {
    const marker = p.state === 'configured' ? ok : p.state === 'unconfigured' ? warn : warn;
    lines.push(
      marker(`${p.label.padEnd(26)} ${p.state}`) +
        (p.missing.length ? ` - missing: ${p.missing.join(', ')}` : ''),
    );
  }

  lines.push('\nOperating safeguards');
  lines.push(ok(`hard daily call ceiling: ${config.hardDailyCallLimit}`));
  lines.push(ok(`hard daily budget ceiling: ${config.hardDailyBudgetMinor} minor units`));

  lines.push('\nBackups');
  if (!config.backup.enabled) {
    lines.push(warn('scheduled backups DISABLED - set BACKUP_ENABLED=true to opt in'));
  } else {
    const dirExists = existsSync(config.backup.dir);
    let dirWritable = false;
    try {
      if (dirExists) {
        accessSync(config.backup.dir, fsConstants.W_OK);
        dirWritable = true;
      }
    } catch {
      dirWritable = false;
    }
    lines.push(
      dirExists && dirWritable
        ? ok(`backup dir writable: ${config.backup.dir}`)
        : bad(`backup dir missing or not writable: ${config.backup.dir}`),
    );
    lines.push(
      config.backup.passphrase
        ? ok('backup encryption configured (AES-256-GCM)')
        : warn('BACKUP_PASSPHRASE not set - backups are stored unencrypted (as is the live database)'),
    );
    const last = db ? latestBackup(db) : null;
    if (!last) {
      lines.push(warn('no backup taken yet - run: npm run backup'));
    } else if (last.status === 'failed') {
      lines.push(bad(`last backup FAILED at ${last.createdAt}: ${last.error ?? 'unknown error'}`));
    } else {
      const ageHours = (Date.now() - Date.parse(last.createdAt)) / 3_600_000;
      const staleAfter = config.backup.intervalHours * 2;
      lines.push(
        ageHours <= staleAfter
          ? ok(`last backup ${last.status} at ${last.createdAt} (${Math.round(ageHours)}h ago, ${last.sizeBytes ?? 0} bytes)`)
          : warn(`last backup is ${Math.round(ageHours)}h old (> ${staleAfter}h) - is the scheduler running?`),
      );
    }
    const test = db ? latestRestoreTest(db) : null;
    if (!test) {
      lines.push(warn('no restore test recorded yet - run: npm run backup -- test'));
    } else if (test.status === 'passed') {
      lines.push(ok(`last restore test PASSED at ${test.startedAt} (backup ${test.backupId})`));
    } else {
      lines.push(bad(`last restore test FAILED at ${test.startedAt}: ${test.error ?? 'checks failed'}`));
    }
  }

  process.stdout.write(lines.join('\n') + '\n');
  db?.close();
}

try {
  main();
} catch (err) {
  process.stderr.write(`doctor failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
