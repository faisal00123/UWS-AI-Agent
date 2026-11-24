/**
 * Restore a verified backup.
 *
 * SQLite mode (no DATABASE_URL):
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
 * PostgreSQL mode (DATABASE_URL set) — the ONLY supported restore path:
 *   cmd:  npm run restore -- --backup <id>        (or --file <dump.jsonl>)
 *         Restore the logical JSONL dump into an ISOLATED, DISPOSABLE schema
 *         (restore_test_*), re-run the app's own migrations inside it,
 *         verify row counts + byte-level content digests, then DROP the
 *         schema again. The live `public` schema is never written to.
 *
 *   --apply is REFUSED in PostgreSQL mode: there is no file to swap, and a
 *   live-schema restore is never this tool's job (Supabase PITR / owner
 *   approval required). --to is likewise refused (it writes a SQLite file).
 *
 * Stop the server before --apply (SQLite mode). Exit code 0 = success, 1 = failure.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type Config } from '../core/config.ts';
import { openDatabase, openFromConfig, type DB } from '../db/index.ts';
import { AppError } from '../core/errors.ts';
import { getBackup, latestVerifiedBackup } from '../domain/backup/service.ts';
import { applyRestore, restoreBackupTo } from '../domain/backup/restore.ts';
import { restoreDumpIntoIsolatedSchema, type IsolatedRestoreResult } from '../domain/backup/pgdump.ts';
import { decryptBuffer, isEncryptedBuffer } from '../domain/backup/crypto.ts';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * PostgreSQL mode refuses the SQLite file-swap path. Exported so the
 * refusal itself is unit-testable without a live database.
 */
export function assertRestoreTarget(databaseUrl: string, apply: boolean): void {
  if (databaseUrl && apply) {
    throw new AppError(
      'validation_failed',
      'PostgreSQL mode: --apply (live file swap) is not supported and will not be attempted. ' +
        'A PostgreSQL restore is only ever performed into an isolated, disposable schema (restore test) ' +
        'via --backup <id> or --file <dump.jsonl>. Point-in-time recovery of the live database requires ' +
        'Supabase tooling and explicit owner approval.',
    );
  }
}

/**
 * Read a backup/dump file, decrypting AES-256-GCM blobs when needed.
 * A wrong/missing passphrase fails loudly (GCM tag check / explicit error).
 */
export function loadDumpBytes(path: string, passphrase: string): Buffer {
  const raw = readFileSync(path);
  if (!isEncryptedBuffer(raw)) return raw;
  if (!passphrase) {
    throw new AppError(
      'validation_failed',
      `Backup at ${path} is encrypted but BACKUP_PASSPHRASE is not set; refusing to guess a passphrase.`,
    );
  }
  return decryptBuffer(raw, passphrase);
}

/**
 * PostgreSQL branch: restore a logical dump into an isolated schema only.
 * Never reads from or writes to the live `public` data beyond the catalog
 * queries the restore helper needs.
 */
async function runPostgresRestore(
  config: Config,
  opts: { backupId?: string; file?: string; toPath?: string },
): Promise<void> {
  if (opts.toPath) {
    throw new AppError(
      'validation_failed',
      '--to writes a SQLite file copy and is not supported in PostgreSQL mode. ' +
        'Use --backup <id> or --file <dump.jsonl> for an isolated-schema restore test.',
    );
  }
  if (!opts.file && !opts.backupId) {
    process.stderr.write(
      'PostgreSQL mode usage:\n' +
        '  npm run restore -- --backup <id>     isolated-schema restore test of a stored backup\n' +
        '  npm run restore -- --file <path>     isolated-schema restore test of a dump file\n',
    );
    process.exitCode = 1;
    return;
  }

  // openFromConfig selects PostgreSQL whenever DATABASE_URL is set and
  // throws on failure — there is no silent fallback to a local file.
  const db = openFromConfig(config);
  try {
    const bytes = opts.file
      ? loadDumpBytes(opts.file, config.backup.passphrase)
      : await loadStoredBackupBytes(db, config, opts.backupId);

    const result: IsolatedRestoreResult = await restoreDumpIntoIsolatedSchema(db, bytes);
    process.stdout.write(
      `Isolated restore test ${result.ok ? 'PASSED' : 'FAILED'} (schema ${result.schema} — dropped afterwards; live schema untouched)\n`,
    );
    for (const c of result.checks) {
      process.stdout.write(`  ${c.passed ? 'ok  ' : 'FAIL'} ${c.label}: ${c.detail}\n`);
    }
    if (!result.ok) process.exitCode = 1;
  } finally {
    await db.close();
  }
}

async function loadStoredBackupBytes(db: DB, config: Config, backupId?: string): Promise<Buffer> {
  const backup = backupId ? await getBackup(db, backupId) : await latestVerifiedBackup(db);
  if (!backup) {
    throw new AppError('not_found', backupId ? `Backup ${backupId} not found` : 'No verified backup available');
  }
  if (backup.status !== 'verified') {
    throw new AppError('validation_failed', `Backup ${backup.id} is not verified (status: ${backup.status})`);
  }
  return loadDumpBytes(backup.path, config.backup.passphrase);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const backupId = arg('backup');
  const toPath = arg('to');
  const file = arg('file');
  const apply = flag('apply');
  const confirm = flag('confirm');

  // PostgreSQL mode must never reach the file-swap path: refuse up front.
  assertRestoreTarget(config.databaseUrl, apply);

  if (config.databaseUrl) {
    await runPostgresRestore(config, { backupId, file, toPath });
    return;
  }

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
    const backup = backupId ? await getBackup(db, backupId) : await latestVerifiedBackup(db);
    if (!backup) {
      throw new AppError('not_found', backupId ? `Backup ${backupId} not found` : 'No verified backup available');
    }
    if (backup.status !== 'verified') {
      throw new AppError('validation_failed', `Backup ${backup.id} is not verified (status: ${backup.status})`);
    }

    if (apply) {
      const result = await applyRestore(config, { path: backup.path, createdAt: backup.createdAt }, {
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
    void db.close();
  }
}

/** True only when this file is executed directly (not imported by tests). */
function invokedDirectly(): boolean {
  const meta = import.meta as unknown as { main?: boolean };
  if (typeof meta.main === 'boolean') return meta.main;
  const argv1 = process.argv[1];
  return argv1 !== undefined && resolve(argv1) === fileURLToPath(import.meta.url);
}

if (invokedDirectly()) {
  main().catch((err: unknown) => {
    process.stderr.write(`restore failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
