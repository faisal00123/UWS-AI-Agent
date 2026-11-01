/**
 * Apply pending database migrations.
 *
 *   cmd:  npm run migrate
 */
import { loadConfig } from '../core/config.ts';
import { openDatabase } from '../db/index.ts';
import { runMigrations, hasPendingMigrations } from '../db/migrate.ts';

const config = loadConfig();
const db = openDatabase(config.databasePath);
try {
  const result = runMigrations(db);
  if (result.applied.length === 0) {
    process.stdout.write('Database is up to date (no pending migrations).\n');
  } else {
    for (const name of result.applied) process.stdout.write(`  applied  ${name}\n`);
    process.stdout.write(`\n${result.applied.length} migration(s) applied.\n`);
  }
  const pending = hasPendingMigrations(db);
  process.stdout.write(`Pending migrations remaining: ${pending ? 'YES' : 'none'}\n`);
  process.stdout.write(`Database: ${config.databasePath}\n`);
} finally {
  db.close();
}
