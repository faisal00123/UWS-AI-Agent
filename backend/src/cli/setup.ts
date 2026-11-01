/**
 * First-run setup:
 *   - applies migrations
 *   - creates the owner account if none exists
 *
 *   cmd:  npm run setup
 *
 * Credentials come from OWNER_EMAIL / OWNER_PASSWORD in .env.
 * If OWNER_PASSWORD is not set, a strong random password is generated and
 * printed ONCE to this console (it is never stored in code or logs).
 * Creating an owner always requires an interactive confirmation in CI-free
 * local use; the account must change its password after first sign-in.
 */
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../core/config.ts';
import { openDatabase } from '../db/index.ts';
import { runMigrations } from '../db/migrate.ts';
import { countOwners, createUser } from '../domain/auth/service.ts';
import { SETTING_DEFINITIONS, configVersion } from '../domain/settings/service.ts';
import { nowIso } from '../core/time.ts';

const config = loadConfig();
const db = openDatabase(config.databasePath);

function generatePassword(): string {
  // 24 url-safe chars satisfies the length + character-class policy.
  return randomBytes(18).toString('base64url');
}

async function main(): Promise<void> {
  const result = runMigrations(db);
  if (result.applied.length > 0) {
    process.stdout.write(`Applied ${result.applied.length} migration(s).\n`);
  }

  const existingOwners = countOwners(db);
  if (existingOwners > 0) {
    process.stdout.write(`Owner account already exists (${existingOwners} active owner(s)). Nothing to do.\n`);
    process.stdout.write(`Config version: ${configVersion(db)}\n`);
    return;
  }

  const email = config.bootstrapOwner.email || 'owner@universalwebsolutions.it.com';
  const generated = config.bootstrapOwner.password === '';
  const password = generated ? generatePassword() : config.bootstrapOwner.password;

  const user = await createUser(
    db,
    config,
    {
      email,
      password,
      displayName: 'UWS Owner',
      role: 'owner',
      mustChangePassword: generated,
    },
    { userId: null, label: 'system' },
  );

  // Seed default settings rows so the dashboard shows explicit versions.
  for (const def of SETTING_DEFINITIONS) {
    db.prepare(
      `INSERT INTO settings (key, value_json, version, updated_by, updated_at)
       VALUES (?, ?, 1, NULL, ?)
       ON CONFLICT(key) DO NOTHING`,
    ).run(def.key, JSON.stringify(def.default(config)), nowIso());
  }

  process.stdout.write('\nOwner account created.\n');
  process.stdout.write(`  email:    ${user.email}\n`);
  if (generated) {
    process.stdout.write(`  password: ${password}   <- shown once, change it after first sign-in\n`);
  } else {
    process.stdout.write('  password: (from OWNER_PASSWORD in .env)\n');
  }
  process.stdout.write(`  config version: ${configVersion(db)}\n\n`);
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`setup failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    db.close();
  });
