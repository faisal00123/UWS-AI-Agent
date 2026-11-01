/**
 * Restore a verified backup.
 *
 *   cmd:  npm run restore -- --to ./data/restored.sqlite [--backup <id>]
 *         Verify a backup and write a restorable copy to the target path.
 *         The live database is NOT touched.
 *
 *   cmd:  npm run restore -- --backup <id> --apply --confirm
 *         Replace the live database file with the backup. Requires BOTH
 *         --apply and --confirm, refuses while any process (the server) holds
 *         the database, preserves the pre-restore files alongside it, and
 *         re-applies opt-outs recorded AFTER the snapshot so a restore can
 *         never resurrect a business that opted out later.
 *
 * Stop the server before --apply. Exit code 0 = success, 1 = failure.
 */
import { loadConfig } from '../core/config.ts';
import { openDatabase } from '../db/index.ts';
import { AppError } from '../core/errors.ts';
import { getBackup, latestVerifiedBackup } from '../domain/backup/service.ts';
import { applyRestore, restoreBackupTo } from '../domain/backup/restore.ts';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function main(): void {
  const config = loadConfig();
  const backupId = arg('backup');
  const toPath = arg('to');
  const apply = flag('apply');
  const confirm = flag('confirm');

  if (!toPath && !apply) {
    process.stderr.write('Usage:\n  npm run restore -- --to <path> [--backup <id>]\n  npm run restore -- --backup <id> --apply --confirm\n');
    process.exitCode = 1;
    return;
  }
  if (apply && !confirm) {
    process.stderr.write('Refusing to overwrite the live database without --confirm.\n');
    process.exitCode = 1;
    return;
  }

  const db = openDatabase(config.databasePath);
  try {
    const backup = backupId ? getBackup(db, backupId) : latestVerifiedBackup(db);
    if (!backup) {
      throw new AppError('not_found', backupId ? `Backup ${backupId} not found` : 'No verified backup available');
    }
    if (backup.status !== 'verified') {
      throw new AppError('validation_failed', `Backup ${backup.id} is not verified (status: ${backup.status})`);
    }

    if (apply) {
      const result = applyRestore(config, { path: backup.path, createdAt: backup.createdAt }, {
        passphrase: config.backup.passphrase,
      });
      process.stdout.write(
        `Restored backup ${backup.id} (taken ${backup.createdAt}) over ${result.databasePath}\n` +
          `  pre-restore files preserved at: ${result.preserved.database}\n` +
          `  post-backup opt-outs re-applied: ${result.lateSuppressions.applied} applied, ${result.lateSuppressions.skipped} already present\n` +
          `  verification: ${result.verification.ok ? 'OK' : 'FAILED'}\n` +
          `\nStart the server and run: npm run doctor\n`,
      );
      if (!result.verification.ok) process.exitCode = 1;
      return;
    }

    const copy = restoreBackupTo(backup.path, toPath!, { passphrase: config.backup.passphrase });
    process.stdout.write(
      `Verified copy of backup ${backup.id} written to ${copy.targetPath}\n` +
        `  encrypted source decrypted: ${copy.encryptedSource ? 'yes' : 'no (plain backup)'}\n` +
        `  verification: ${copy.verification.ok ? 'OK' : 'FAILED'}\n` +
        `\nTo make it live: stop the server, then re-run with --apply --confirm\n`,
    );
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`restore failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
