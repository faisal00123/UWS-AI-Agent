/**
 * Restore tooling (Phase 9).
 *
 * A restore must never make the system LESS safe than before:
 *  - the swap is refused unless the operator passes --confirm AND the live
 *    database proves no other process is using it (exclusive-lock probe)
 *  - the pre-restore files are renamed aside, never deleted
 *  - opt-outs recorded AFTER the snapshot was taken are re-applied onto the
 *    restored database: `suppression_list` is authoritative and a restore
 *    must never resurrect a business that opted out after the backup
 *  - every restore ends with an integrity + foreign-key check of the live file
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, renameSync, writeFileSync, readFileSync, unlinkSync, copyFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { DB } from '../../db/index.ts';
import type { Config } from '../../core/config.ts';
import { AppError } from '../../core/errors.ts';
import { nowIso } from '../../core/time.ts';
import { decryptBuffer, isEncryptedBuffer } from './crypto.ts';
import { verifyBackupFile, type VerifyResult } from './service.ts';

export interface LateSuppression {
  id: string;
  business_id: string | null;
  scope: string;
  phone_e164: string | null;
  whatsapp_e164: string | null;
  email: string | null;
  reason: string;
  source: string;
  evidence: string | null;
  permanent: number;
  created_by: string | null;
  created_at: string;
}

/**
 * Opt-outs recorded in the LIVE database after the snapshot was taken. Read
 * before the swap so the restored file can re-apply them.
 */
export function capturePostBackupSuppressions(liveDb: DB, backupCreatedAt: string): LateSuppression[] {
  return liveDb
    .prepare('SELECT * FROM suppression_list WHERE created_at > ? ORDER BY created_at')
    .all(backupCreatedAt) as unknown as LateSuppression[];
}

/**
 * Re-applies late opt-outs onto a restored database. Idempotent: rows already
 * present (same id or same business+reason unique pair) are skipped, so a
 * double-run can never duplicate or error.
 */
export function applyRestoredSuppressions(restoredDb: DB, late: LateSuppression[]): { applied: number; skipped: number } {
  let applied = 0;
  let skipped = 0;
  for (const row of late) {
    const exists = restoredDb
      .prepare(
        `SELECT 1 FROM suppression_list WHERE id = ?
           OR (business_id IS ? AND business_id IS NOT NULL AND reason = ?)`,
      )
      .get(row.id, row.business_id, row.reason);
    if (exists) {
      skipped += 1;
      continue;
    }
    try {
      restoredDb
        .prepare(
          `INSERT INTO suppression_list (id, business_id, scope, phone_e164, whatsapp_e164, email,
             reason, source, evidence, permanent, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.business_id,
          row.scope,
          row.phone_e164,
          row.whatsapp_e164,
          row.email,
          row.reason,
          row.source,
          row.evidence,
          row.permanent,
          row.created_by,
          row.created_at,
        );
      applied += 1;
    } catch {
      // Unique-pair collision with an equivalent row: the opt-out already
      // exists in spirit, which is the safe direction.
      skipped += 1;
    }
  }
  return { applied, skipped };
}

export interface RestoreCopyResult {
  targetPath: string;
  verification: VerifyResult;
  encryptedSource: boolean;
}

/**
 * Materialises a restorable copy of a backup at `targetPath` (decrypting an
 * encrypted backup on the way). Verifies the copy before returning; refuses
 * (throws) when verification fails so a corrupt copy is never handed over.
 */
export function restoreBackupTo(
  backupPath: string,
  targetPath: string,
  opts: { passphrase?: string } = {},
): RestoreCopyResult {
  const outer = verifyBackupFile(backupPath, { passphrase: opts.passphrase });
  if (!outer.ok) {
    const failed = outer.checks.filter((c) => !c.passed).map((c) => `${c.code}: ${c.detail}`).join('; ');
    throw new AppError('validation_failed', `Backup cannot be restored — verification failed (${failed})`);
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  const raw = readFileSync(backupPath);
  const encryptedSource = isEncryptedBuffer(raw);
  if (encryptedSource) {
    writeFileSync(targetPath, decryptBuffer(raw, opts.passphrase ?? ''));
  } else {
    copyFileSync(backupPath, targetPath);
  }

  const verification = verifyBackupFile(targetPath, {});
  if (!verification.ok) {
    try {
      unlinkSync(targetPath);
    } catch {
      /* best effort */
    }
    throw new AppError('validation_failed', 'Restored copy failed verification after writing');
  }
  return { targetPath, verification, encryptedSource };
}

/**
 * Proves the live database file is not in use by another process: opens it
 * with a short busy timeout and attempts an EXCLUSIVE transaction. A running
 * server holds the WAL write lock and makes this fail fast.
 */
export function probeExclusiveAccess(dbPath: string): { free: boolean; detail: string } {
  let probe: DatabaseSync | null = null;
  try {
    probe = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false });
    probe.exec('PRAGMA busy_timeout = 200');
    probe.exec('BEGIN EXCLUSIVE');
    probe.exec('ROLLBACK');
    return { free: true, detail: 'No other process holds the database.' };
  } catch (err) {
    return {
      free: false,
      detail: `Database appears to be in use: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    try {
      probe?.close();
    } catch {
      /* best effort */
    }
  }
}

export interface ApplyRestoreResult {
  databasePath: string;
  preserved: { database: string; wal: string; shm: string };
  lateSuppressions: { applied: number; skipped: number };
  verification: VerifyResult;
  backupCreatedAt: string;
}

/**
 * Applies a backup OVER the live database file. The caller (CLI) must have
 * verified the backup and collected an explicit --confirm; this function
 * re-checks that the live file is free before touching anything.
 */
export function applyRestore(
  cfg: Config,
  backup: { path: string; createdAt: string },
  opts: { passphrase?: string },
): ApplyRestoreResult {
  const dbPath = cfg.databasePath;
  if (dbPath === ':memory:') {
    throw new AppError('validation_failed', 'Cannot apply a restore to an in-memory database');
  }

  const probe = probeExclusiveAccess(dbPath);
  if (!probe.free) {
    throw new AppError('conflict', `${probe.detail} Stop the server (and any other process) before --apply.`);
  }

  // 1. Capture post-backup opt-outs from the CURRENT database.
  let late: LateSuppression[] = [];
  if (existsSync(dbPath)) {
    const live = new DatabaseSync(dbPath, { readOnly: true, enableForeignKeyConstraints: false });
    try {
      late = capturePostBackupSuppressions(live as unknown as DB, backup.createdAt);
    } finally {
      live.close();
    }
  }

  // 2. Materialise the restored snapshot at a temporary sibling path.
  const tmpPath = `${dbPath}.restore-tmp`;
  restoreBackupTo(backup.path, tmpPath, { passphrase: opts.passphrase });

  // 3. Re-apply late opt-outs onto the restored copy BEFORE it goes live.
  const restored = new DatabaseSync(tmpPath, { enableForeignKeyConstraints: true });
  let applied = { applied: 0, skipped: 0 };
  try {
    restored.exec('PRAGMA foreign_keys = ON');
    applied = applyRestoredSuppressions(restored as unknown as DB, late);
    const integrity = restored.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
    if (integrity?.integrity_check !== 'ok') {
      throw new AppError('validation_failed', `Restored copy failed final integrity check: ${integrity?.integrity_check}`);
    }
  } finally {
    restored.close();
  }

  // 4. Move the old files aside (kept for forensics — never deleted here).
  const stampTag = nowIso().replace(/[:.]/g, '-');
  const preserved = {
    database: `${dbPath}.pre-restore-${stampTag}`,
    wal: `${dbPath}-wal.pre-restore-${stampTag}`,
    shm: `${dbPath}-shm.pre-restore-${stampTag}`,
  };
  if (existsSync(dbPath)) renameSync(dbPath, preserved.database);
  if (existsSync(`${dbPath}-wal`)) renameSync(`${dbPath}-wal`, preserved.wal);
  if (existsSync(`${dbPath}-shm`)) renameSync(`${dbPath}-shm`, preserved.shm);

  // 5. Move the restored copy into place and re-verify the live file.
  renameSync(tmpPath, dbPath);
  const verification = verifyBackupFile(dbPath, {});
  if (!verification.ok) {
    throw new AppError('internal_error', 'Restore completed but the live file failed verification — investigate immediately');
  }

  // Note: the LIVE database stays a plain SQLite file (the server must open
  // it); the encrypted artifact is the backup. At-rest encryption of the live
  // file is an OS/disk-encryption concern by design.
  return { databasePath: dbPath, preserved, lateSuppressions: applied, verification, backupCreatedAt: backup.createdAt };
}
