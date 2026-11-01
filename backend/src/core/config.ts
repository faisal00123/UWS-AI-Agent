/**
 * Environment configuration.
 *
 * - Validates every variable with zod so a bad deploy fails fast, not at 3am.
 * - Never returns credential *values* for providers; it only reports whether a
 *   credential is present so the Integrations page can show
 *   configured / unconfigured without leaking secrets to the client.
 * - Operational settings (calling hours, budgets, follow-up rules, mode) live
 *   in the database because the owner edits them at runtime; this module only
 *   provides bootstrap defaults and hard safety ceilings.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()),
  );

const intIn = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max);

const isUrl = (v: string): boolean => {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Default 3100: 3000 is commonly occupied by other local dev servers. */
  PORT: intIn(1, 65535).default(3100),
  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
  DATABASE_PATH: z.string().min(1).default('./data/uws.sqlite'),

  SESSION_SECRET: z.string().default(''),
  SESSION_TTL_HOURS: intIn(1, 24 * 30).default(12),

  OPERATING_MODE: z.enum(['simulation', 'live']).default('simulation'),

  BUSINESS_TIMEZONE: z.string().min(1).default('Asia/Karachi'),
  BUSINESS_NAME: z.string().min(1).default('Universal Web Solutions'),
  BUSINESS_WEBSITE: z
    .string()
    .default('https://www.universalwebsolutions.it.com'),

  /** Absolute ceiling on outbound calls in a single business day. */
  HARD_DAILY_CALL_LIMIT: intIn(1, 1000).default(100),
  /** Absolute ceiling on daily paid calling + messaging spend (minor units). */
  HARD_DAILY_BUDGET_MINOR: intIn(0, 100_000_000).default(100_000),

  LOGIN_MAX_ATTEMPTS: intIn(1, 100).default(5),
  LOGIN_WINDOW_MINUTES: intIn(1, 1440).default(15),
  LOGIN_LOCK_MINUTES: intIn(1, 1440).default(15),

  /** scrypt work factor. Lowered only in tests for speed. */
  SCRYPT_N: intIn(1024, 1 << 20).default(16384),

  BACKUP_ENABLED: boolish.default(false),
  BACKUP_DIR: z.string().default('./data/backups'),
  BACKUP_RETENTION_DAYS: intIn(1, 3650).default(30),
  BACKUP_PASSPHRASE: z.string().default(''),
  /** The backup job ticks hourly but only acts when the last backup is older. */
  BACKUP_INTERVAL_HOURS: intIn(1, 48).default(24),
  /** How often a restore test must re-verify the newest backup. */
  RESTORE_TEST_INTERVAL_DAYS: intIn(1, 30).default(7),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  LOG_REDACT: boolish.default(true),

  // Provider variables are optional and unconfigured by default. Only their
  // presence is reported - never their values.
  TELEPHONY_PROVIDER: z.string().default(''),
  TELEPHONY_ACCOUNT_SID: z.string().default(''),
  TELEPHONY_AUTH_TOKEN: z.string().default(''),
  TELEPHONY_FROM_NUMBER: z.string().default(''),

  WHATSAPP_PROVIDER: z.string().default(''),
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
  WHATSAPP_ACCESS_TOKEN: z.string().default(''),
  WHATSAPP_TEMPLATE_NAME_PORTFOLIO: z.string().default(''),
  /** Language code of the approved portfolio template (e.g. 'en'). */
  WHATSAPP_TEMPLATE_LANGUAGE: z.string().default('en'),
  /** Meta app secret — verifies X-Hub-Signature-256 on inbound webhooks. */
  WHATSAPP_APP_SECRET: z.string().default(''),
  /** Owner-chosen token Meta must echo back on the webhook subscription GET. */
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().default(''),

  DISCOVERY_PROVIDER: z.string().default(''),
  DISCOVERY_API_KEY: z.string().default(''),
  // Optional self-hosted Overpass instance (Phase 12); empty = the public
  // overpass-api.de instance. Not a secret — it is a URL, but it is env-only
  // configuration like everything else and never echoed in responses.
  DISCOVERY_OVERPASS_URL: z.string().default(''),

  AI_PROVIDER: z.string().default(''),
  AI_API_KEY: z.string().default(''),
  AI_MODEL: z.string().default(''),
  /** Optional override of the AI base URL (self-hosted OpenAI-compatible). */
  AI_BASE_URL: z.string().default(''),
  STT_PROVIDER: z.string().default(''),
  STT_API_KEY: z.string().default(''),
  TTS_PROVIDER: z.string().default(''),
  TTS_API_KEY: z.string().default(''),

  // Speech voice/language defaults (Phase 11A). Non-secret configuration.
  /** Default STT language hint: 'en' or 'ur'. */
  SPEECH_LANGUAGE: z.enum(['en', 'ur']).default('en'),
  /** Default TTS voice (English / fallback). */
  SPEECH_VOICE: z.string().default(''),
  /** TTS voice used when synthesising Urdu (falls back to SPEECH_VOICE). */
  SPEECH_VOICE_UR: z.string().default(''),

  // Adapter resilience (Phase 11A). Applies to idempotent operations only.
  /** Total attempts (including the first) for retryable idempotent ops. */
  ADAPTER_RETRY_ATTEMPTS: intIn(1, 6).default(2),
  /** Operations per minute per integration (rate limiting). */
  ADAPTER_RATE_LIMIT_PER_MIN: intIn(1, 10_000).default(60),

  SMTP_HOST: z.string().default(''),
  SMTP_PORT: intIn(1, 65535).default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  MAIL_FROM: z.string().default(''),
  NOTIFY_OWNER_EMAIL: z.string().default(''),

  OWNER_EMAIL: z.string().default(''),
  OWNER_PASSWORD: z.string().default(''),
});

export type IntegrationState = 'configured' | 'unconfigured' | 'partial' | 'error';

export interface ProviderStatus {
  key: string;
  label: string;
  state: IntegrationState;
  /** Names of credentials that are present. Values are never included. */
  present: string[];
  /** Names of credentials that are missing. */
  missing: string[];
  features: string[];
  requiredSetup: string[];
}

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  publicBaseUrl: string;
  databasePath: string;
  sessionSecret: string;
  sessionTtlHours: number;
  operatingModeSeed: 'simulation' | 'live';
  businessTimezone: string;
  businessName: string;
  businessWebsite: string;
  hardDailyCallLimit: number;
  hardDailyBudgetMinor: number;
  login: { maxAttempts: number; windowMinutes: number; lockMinutes: number };
  scryptN: number;
  backup: {
    enabled: boolean;
    dir: string;
    retentionDays: number;
    passphrase: string;
    intervalHours: number;
    restoreTestDays: number;
  };
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  logRedact: boolean;
  providers: ProviderStatus[];
  /** Optional AI base URL override (self-hosted OpenAI-compatible). */
  aiBaseUrl: string;
  /** Speech voice/language defaults (never secrets). */
  speech: { language: 'en' | 'ur'; voice: string; voiceUr: string };
  /** Adapter resilience settings: retry attempts + per-minute rate limit. */
  adapter: { retryAttempts: number; ratePerMinute: number };
  bootstrapOwner: { email: string; password: string };
  /** true when the session secret was generated for this process only. */
  ephemeralSessionSecret: boolean;
}

type Env = Record<string, string | undefined>;

function providerStatus(
  key: string,
  label: string,
  env: Env,
  required: string[],
  features: string[],
  requiredSetup: string[],
): ProviderStatus {
  const present = required.filter((f) => (env[f] ?? '').trim() !== '');
  const missing = required.filter((f) => !present.includes(f));
  const named = (env[`${key.toUpperCase()}_PROVIDER`] ?? '').trim();
  let state: IntegrationState;
  if (missing.length === 0 && named !== '') state = 'configured';
  else if (present.length === 0) state = 'unconfigured';
  else state = 'partial';
  return { key, label, state, present, missing, features, requiredSetup };
}

export function loadConfig(env: Env = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;

  if (!isUrl(e.PUBLIC_BASE_URL)) {
    throw new Error('PUBLIC_BASE_URL must be a valid http(s) URL');
  }

  let sessionSecret = e.SESSION_SECRET.trim();
  let ephemeral = false;
  if (sessionSecret === '') {
    if (e.NODE_ENV === 'production') {
      throw new Error(
        'SESSION_SECRET is required in production. Generate one with:\n' +
          '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
      );
    }
    sessionSecret = randomBytes(48).toString('hex');
    ephemeral = true;
  } else if (sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }

  const providers: ProviderStatus[] = [
    providerStatus(
      'telephony',
      'Telephony (calls)',
      env,
      ['TELEPHONY_PROVIDER', 'TELEPHONY_ACCOUNT_SID', 'TELEPHONY_AUTH_TOKEN', 'TELEPHONY_FROM_NUMBER'],
      ['outbound calls', 'call status events', 'recording (if enabled)'],
      ['Provider account approved for voice', 'valid credentials in .env'],
    ),
    providerStatus(
      'whatsapp',
      'WhatsApp Business',
      env,
      [
        'WHATSAPP_PROVIDER',
        'WHATSAPP_PHONE_NUMBER_ID',
        'WHATSAPP_ACCESS_TOKEN',
        'WHATSAPP_TEMPLATE_NAME_PORTFOLIO',
        'WHATSAPP_APP_SECRET',
        'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
      ],
      ['portfolio messages', 'owner notifications', 'delivery events', 'inbound replies & opt-outs'],
      ['WhatsApp Business account + approved template', 'valid credentials in .env', 'app secret + webhook verify token for callbacks'],
    ),
    // Phase 12: OpenStreetMap/Overpass discovery needs NO API key (public
    // data). Requiring DISCOVERY_API_KEY for it would report a perfectly
    // functional setup as "partial", so the requirement is provider-aware.
    providerStatus(
      'discovery',
      'Lead discovery',
      env,
      (env['DISCOVERY_PROVIDER'] ?? '').trim().toLowerCase() === 'overpass'
        ? ['DISCOVERY_PROVIDER']
        : ['DISCOVERY_PROVIDER', 'DISCOVERY_API_KEY'],
      (env['DISCOVERY_PROVIDER'] ?? '').trim().toLowerCase() === 'overpass'
        ? ['public OpenStreetMap lead search (free, no key)']
        : ['public web/directory lead search'],
      (env['DISCOVERY_PROVIDER'] ?? '').trim().toLowerCase() === 'overpass'
        ? ['OpenStreetMap data via the free Overpass API']
        : ['Approved search or directory API key'],
    ),
    providerStatus(
      'ai',
      'AI conversation',
      env,
      ['AI_PROVIDER', 'AI_API_KEY', 'AI_MODEL'],
      ['conversation turns', 'qualification extraction'],
      ['Model provider API key'],
    ),
    providerStatus(
      'speech',
      'Speech (STT/TTS)',
      env,
      ['STT_PROVIDER', 'STT_API_KEY'],
      ['transcription', 'voice synthesis'],
      ['Speech provider API key'],
    ),
    providerStatus(
      'email',
      'Email (SMTP)',
      env,
      ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'],
      ['owner email notifications', 'daily report email'],
      ['SMTP credentials + sending domain'],
    ),
  ];

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/+$/, ''),
    databasePath: e.DATABASE_PATH,
    sessionSecret,
    sessionTtlHours: e.SESSION_TTL_HOURS,
    operatingModeSeed: e.OPERATING_MODE,
    businessTimezone: e.BUSINESS_TIMEZONE,
    businessName: e.BUSINESS_NAME,
    businessWebsite: e.BUSINESS_WEBSITE,
    hardDailyCallLimit: e.HARD_DAILY_CALL_LIMIT,
    hardDailyBudgetMinor: e.HARD_DAILY_BUDGET_MINOR,
    login: {
      maxAttempts: e.LOGIN_MAX_ATTEMPTS,
      windowMinutes: e.LOGIN_WINDOW_MINUTES,
      lockMinutes: e.LOGIN_LOCK_MINUTES,
    },
    scryptN: e.SCRYPT_N,
    backup: {
      enabled: e.BACKUP_ENABLED,
      dir: e.BACKUP_DIR,
      retentionDays: e.BACKUP_RETENTION_DAYS,
      passphrase: e.BACKUP_PASSPHRASE,
      intervalHours: e.BACKUP_INTERVAL_HOURS,
      restoreTestDays: e.RESTORE_TEST_INTERVAL_DAYS,
    },
    logLevel: e.LOG_LEVEL,
    logRedact: e.LOG_REDACT,
    providers,
    aiBaseUrl: e.AI_BASE_URL.trim(),
    speech: { language: e.SPEECH_LANGUAGE, voice: e.SPEECH_VOICE.trim(), voiceUr: e.SPEECH_VOICE_UR.trim() },
    adapter: { retryAttempts: e.ADAPTER_RETRY_ATTEMPTS, ratePerMinute: e.ADAPTER_RATE_LIMIT_PER_MIN },
    bootstrapOwner: { email: e.OWNER_EMAIL, password: e.OWNER_PASSWORD },
    ephemeralSessionSecret: ephemeral,
  };
}

export type { z };
