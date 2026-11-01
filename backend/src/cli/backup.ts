/**
 * Manual backup operations.
 *
 *   cmd:  npm run backup            take a verified backup now
 *   cmd:  npm run backup -- list    list backups and restore tests
 *   cmd:  npm run backup -- test    run a restore test against the newest backup
 *
 * Exit code 0 = success, 1 = failure (a failed backup also raises a
 * notification and, when scheduled, an incident).
 */
import { loadConfig } from '../core/config.ts';
import { openDatabase } from '../db/index.ts';
import {
  listBackups,
  listRestoreTests,
  runBackup,
  runRestoreTest,
} from '../domain/backup/service.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  try {
    const mode = process.argv[2] ?? 'run';

    if (mode === 'list') {
      const backups = listBackups(db);
      if (backups.length === 0) {
        process.stdout.write('No backups recorded yet.\n');
      } else {
        process.stdout.write('Backups (newest first):\n');
        for (const b of backups) {
          process.stdout.write(
            `  ${b.createdAt}  ${b.status.padEnd(9)}  ${String(b.sizeBytes ?? 0).padStart(10)} bytes  ` +
              `${b.encrypted ? 'encrypted' : 'plain    '}  ${b.path}\n`,
          );
          if (b.error) process.stdout.write(`      error: ${b.error}\n`);
        }
      }
      const tests = listRestoreTests(db);
      process.stdout.write('\nRestore tests:\n');
      if (tests.length === 0) {
        process.stdout.write('  none yet (run: npm run backup -- test)\n');
      }
      for (const t of tests) {
        process.stdout.write(`  ${t.startedAt}  ${t.status.padEnd(6)}  backup ${t.backupId}\n`);
        if (t.error) process.stdout.write(`      error: ${t.error}\n`);
      }
      return;
    }

    if (mode === 'test') {
      const test = runRestoreTest(db, config);
      process.stdout.write(`Restore test ${test.status} for backup ${test.backupId}\n`);
      for (const c of test.checks) {
        process.stdout.write(`  [${c.passed ? 'PASS' : 'FAIL'}] ${c.label} - ${c.detail}\n`);
      }
      if (test.status !== 'passed') process.exitCode = 1;
      return;
    }

    if (mode !== 'run') {
      process.stderr.write(`Unknown command "${mode}". Use: run | list | test\n`);
      process.exitCode = 1;
      return;
    }

    if (!config.backup.passphrase) {
      process.stdout.write('NOTE: BACKUP_PASSPHRASE is not set - the backup is stored UNENCRYPTED.\n');
    }
    const record = await runBackup(db, config, { actor: { userId: null, label: 'owner' } });
    process.stdout.write(
      `Backup ${record.status}: ${record.path}\n` +
        `  size: ${record.sizeBytes} bytes  encrypted: ${record.encrypted ? 'yes' : 'no'}\n` +
        `  sha256: ${record.sha256}\n` +
        `  retention until: ${record.retentionUntil}\n`,
    );
    for (const c of record.verifyResult?.checks ?? []) {
      process.stdout.write(`  [${c.passed ? 'PASS' : 'FAIL'}] ${c.label}\n`);
    }
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`backup failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
