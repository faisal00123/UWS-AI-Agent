/**
 * Backup & restore-test jobs (Phase 9).
 *
 * Rules inherited from the scheduler:
 *  - both jobs are no-ops (silent, no job_runs churn) while BACKUP_ENABLED is
 *    false — the owner opts into backups explicitly
 *  - they tick hourly but only ACT when due (last backup older than
 *    BACKUP_INTERVAL_HOURS / last restore test older than
 *    RESTORE_TEST_INTERVAL_DAYS), so restarts never mass-create backups
 *  - a failure is loud: runBackup/runRestoreTest record the failed row and
 *    raise a critical notification, then rethrow so the scheduler also
 *    records the failed job run and raises an incident
 */
import { registerJob, type JobDefinition } from './scheduler.ts';
import {
  latestBackup,
  latestRestoreTest,
  latestVerifiedBackup,
  runBackup,
  runRestoreTest,
} from '../domain/backup/service.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const backupJob: JobDefinition = {
  name: 'backup',
  intervalMs: HOUR_MS,
  async run(ctx) {
    const { db, config } = ctx;
    if (!config.backup.enabled) return undefined;
    const last = latestBackup(db);
    if (
      last &&
      last.status === 'verified' &&
      Date.now() - Date.parse(last.createdAt) < config.backup.intervalHours * HOUR_MS
    ) {
      return undefined; // fresh enough
    }
    const record = await runBackup(db, config, { actor: { userId: null, label: 'scheduler' } });
    return {
      detail: `backup ${record.id} ${record.status} (${record.sizeBytes ?? 0} bytes${record.encrypted ? ', encrypted' : ''})`,
    };
  },
};

export const restoreTestJob: JobDefinition = {
  name: 'restore_test',
  intervalMs: HOUR_MS,
  run(ctx) {
    const { db, config } = ctx;
    if (!config.backup.enabled) return undefined;
    if (!latestVerifiedBackup(db)) return undefined; // nothing worth testing yet
    const last = latestRestoreTest(db);
    if (last && Date.now() - Date.parse(last.startedAt) < config.backup.restoreTestDays * DAY_MS) {
      return undefined; // tested recently (passed or failed — both are records)
    }
    const test = runRestoreTest(db, config);
    return { detail: `restore test ${test.status} for backup ${test.backupId}` };
  },
};

/** Idempotent: registerJob replaces by name. */
export function registerBackupJobs(): void {
  registerJob(backupJob);
  registerJob(restoreTestJob);
}
