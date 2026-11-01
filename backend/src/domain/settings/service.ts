/**
 * Owner-configurable settings.
 *
 * Definitions declare schema, default, and whether the value is a hard safety
 * ceiling (cannot be raised above the value supplied by environment config).
 * Every write is validated by zod and audited.
 */
import { z } from 'zod';
import type { DB } from '../../db/index.ts';
import type { Config } from '../../core/config.ts';
import { nowIso } from '../../core/time.ts';
import { AppError } from '../../core/errors.ts';
import { recordAudit } from '../audit/service.ts';

const hhmm = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'must be HH:MM');
const day = z.number().int().min(0).max(6);

export interface SettingDefinition {
  key: string;
  label: string;
  description: string;
  schema: z.ZodType;
  /** Built from env-derived hard ceilings on first read. */
  default: (cfg: Config) => unknown;
  /** True when raising this value increases cost/risk (extra confirmation UI). */
  sensitive?: boolean;
}

const allDays = [0, 1, 2, 3, 4, 5, 6];

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  {
    key: 'calling_schedule',
    label: 'Calling days & hours',
    description:
      'When outbound calls may be placed. Enforced in the backend using the business timezone.',
    schema: z.object({
      days: z.array(day).min(1).max(7),
      startTime: hhmm,
      endTime: hhmm,
      timezone: z.string().min(1),
    }),
    default: (cfg) => ({
      days: [1, 2, 3, 4, 5],
      startTime: '09:00',
      endTime: '18:00',
      timezone: cfg.businessTimezone,
    }),
    sensitive: true,
  },
  {
    key: 'daily_call_limit',
    label: 'Daily outbound call limit',
    description:
      'Hard maximum outbound call attempts per business day (retries included). Cannot exceed the compiled-in ceiling.',
    schema: z.number().int().min(1),
    default: (cfg) => Math.min(100, cfg.hardDailyCallLimit),
    sensitive: true,
  },
  {
    key: 'daily_budget',
    label: 'Daily calling & messaging budget',
    description:
      'Hard cap on paid outbound calling + messaging spend for a business day. At the cap, paid actions stop until the owner approves.',
    schema: z.object({
      limitMinor: z.number().int().min(0),
      currency: z.string().min(3).max(5),
      warningPercent: z.number().int().min(1).max(100),
    }),
    default: (cfg) => ({
      limitMinor: cfg.hardDailyBudgetMinor,
      currency: 'PKR',
      warningPercent: 80,
    }),
    sensitive: true,
  },
  {
    key: 'retry_policy',
    label: 'Retry policy',
    description: 'Retries for temporary failures / no-answer. Every retry counts toward the daily limit.',
    schema: z.object({
      maxRetries: z.number().int().min(0).max(5),
      retryIntervalMinutes: z.number().int().min(1).max(10080),
      retryOn: z.array(z.enum(['no_answer', 'busy', 'technical_failure', 'failed'])).max(4),
    }),
    default: () => ({
      maxRetries: 2,
      retryIntervalMinutes: 60,
      retryOn: ['no_answer', 'busy', 'technical_failure'],
    }),
  },
  {
    key: 'followup_policy',
    label: 'Follow-up policy',
    description:
      'Maximum follow-ups after initial contact, intervals, and permitted follow-up channels.',
    schema: z.object({
      maxFollowups: z.number().int().min(0).max(10),
      intervalsMinutes: z.array(z.number().int().min(1)).max(10),
      channels: z.array(z.enum(['call', 'whatsapp_message', 'whatsapp_call', 'email'])).max(4),
      stopOnOptOut: z.literal(true),
    }),
    default: () => ({
      maxFollowups: 3,
      intervalsMinutes: [1440, 4320, 10080],
      channels: ['call', 'whatsapp_message'],
      stopOnOptOut: true,
    }),
    sensitive: true,
  },
  {
    key: 'eligible_channels',
    label: 'Eligible communication channels',
    description:
      'Channels the business owner permits. A channel with no configured provider can never be used regardless of this setting.',
    schema: z.object({
      call: z.boolean(),
      whatsappMessage: z.boolean(),
      whatsappCall: z.boolean(),
      email: z.boolean(),
      sms: z.literal(false),
    }),
    default: () => ({
      call: false,
      whatsappMessage: false,
      whatsappCall: false,
      email: false,
      sms: false,
    }),
    sensitive: true,
  },
  {
    key: 'recording_policy',
    label: 'Call recording',
    description: 'Recording is optional and off by default; consent is required where applicable law demands it.',
    schema: z.object({ enabled: z.boolean(), requireConsent: z.boolean() }),
    default: () => ({ enabled: false, requireConsent: true }),
    sensitive: true,
  },
  {
    key: 'notification_destinations',
    label: 'Notification destinations',
    description: 'Where dashboard/email/WhatsApp notifications are delivered.',
    schema: z.object({
      dashboard: z.boolean(),
      email: z.string().email().or(z.literal('')),
      whatsapp: z.string().regex(/^$|^\+?\d{7,15}$/, 'must be empty or an international number'),
    }),
    default: () => ({ dashboard: true, email: '', whatsapp: '' }),
  },
  {
    key: 'retention',
    label: 'Data retention (days)',
    description:
      'Retention per data class. Opt-out/suppression records are never deleted automatically.',
    schema: z.object({
      leadsDays: z.number().int().min(30).max(3650),
      recordingsDays: z.number().int().min(7).max(3650),
      transcriptsDays: z.number().int().min(7).max(3650),
      messageLogsDays: z.number().int().min(7).max(3650),
      analyticsDays: z.number().int().min(7).max(3650),
    }),
    default: () => ({
      leadsDays: 730,
      recordingsDays: 90,
      transcriptsDays: 180,
      messageLogsDays: 365,
      analyticsDays: 730,
    }),
  },
  {
    key: 'scoring_weights',
    label: 'Lead scoring weights',
    description:
      'Relative weights of the scoring factors. Scores remain explainable: every factor shows its contribution.',
    schema: z.object({
      websiteGap: z.number().min(0).max(1),
      serviceFit: z.number().min(0).max(1),
      budget: z.number().min(0).max(1),
      timeline: z.number().min(0).max(1),
      contactability: z.number().min(0).max(1),
      engagement: z.number().min(0).max(1),
    }),
    default: () => ({
      websiteGap: 0.3,
      serviceFit: 0.2,
      budget: 0.15,
      timeline: 0.1,
      contactability: 0.15,
      engagement: 0.1,
    }),
  },
  {
    key: 'discovery_policy',
    label: 'Lead discovery policy',
    description: 'Categories, cities and per-run limits for lead discovery.',
    schema: z.object({
      categories: z.array(z.string().min(1)).max(40),
      cities: z.array(z.string().min(1)).max(40),
      maxPerRun: z.number().int().min(1).max(500),
      autoAnalyze: z.boolean(),
      autoScore: z.boolean(),
    }),
    default: () => ({
      categories: ['clinic', 'restaurant', 'school', 'real_estate', 'retail', 'ecommerce', 'professional_services'],
      cities: ['Karachi', 'Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan', 'Peshawar', 'Quetta'],
      maxPerRun: 50,
      autoAnalyze: true,
      autoScore: true,
    }),
  },
  {
    key: 'conversation_policy',
    label: 'AI conversation policy',
    description: 'Languages, AI disclosure, and turn limits for sales conversations.',
    schema: z.object({
      languages: z.array(z.enum(['ur', 'roman_ur', 'en'])).min(1),
      aiDisclosureRequired: z.literal(true),
      maxTurns: z.number().int().min(4).max(60),
      humanHandoffOnRequest: z.literal(true),
    }),
    default: () => ({
      languages: ['ur', 'roman_ur', 'en'],
      aiDisclosureRequired: true,
      maxTurns: 16,
      humanHandoffOnRequest: true,
    }),
  },
  {
    key: 'portfolio_policy',
    label: 'Portfolio sharing policy',
    description:
      'Portfolio link and the number-confirmation workflow used before any WhatsApp portfolio message.',
    schema: z.object({
      websiteUrl: z.string().url(),
      portfolioUrl: z.string().url().or(z.literal('')),
      confirmNumberOnCall: z.literal(true),
      requireProviderAndPermission: z.literal(true),
      meetingOfferEnabled: z.boolean(),
    }),
    default: (cfg) => ({
      websiteUrl: cfg.businessWebsite,
      portfolioUrl: '',
      confirmNumberOnCall: true,
      requireProviderAndPermission: true,
      meetingOfferEnabled: true,
    }),
    sensitive: true,
  },
  {
    key: 'integration_toggles',
    label: 'Integration enable/disable',
    description:
      'Master on/off switch per integration. A disabled integration fails fast and never contacts its provider (no network, no cost).',
    schema: z.object({
      telephony: z.boolean(),
      whatsapp: z.boolean(),
      ai: z.boolean(),
      speech: z.boolean(),
      email: z.boolean(),
      discovery: z.boolean(),
    }),
    default: () => ({
      telephony: true,
      whatsapp: true,
      ai: true,
      speech: true,
      email: true,
      discovery: true,
    }),
    // Toggling off is always safe; toggling ON a configured provider could
    // enable real outreach once mode flips — flagged, not reauth-gated.
    sensitive: false,
  },
];

const BY_KEY = new Map(SETTING_DEFINITIONS.map((d) => [d.key, d]));

export function settingDefinition(key: string): SettingDefinition {
  const def = BY_KEY.get(key);
  if (!def) throw new AppError('not_found', `Unknown setting: ${key}`);
  return def;
}

interface SettingRow {
  key: string;
  value_json: string;
  version: number;
  updated_by: string | null;
  updated_at: string;
}

export function getSetting<T = unknown>(db: DB, key: string, cfg: Config): T {
  const def = settingDefinition(key);
  const row = db.prepare('SELECT * FROM settings WHERE key = ?').get(key) as SettingRow | undefined;
  if (!row) return def.default(cfg) as T;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    // A corrupt value must never crash a request: fall back to the default.
    return def.default(cfg) as T;
  }
}

export interface SettingView {
  key: string;
  label: string;
  description: string;
  value: unknown;
  source: 'database' | 'default';
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
  sensitive: boolean;
}

export function getAllSettings(db: DB, cfg: Config): SettingView[] {
  return SETTING_DEFINITIONS.map((def) => {
    const row = db.prepare('SELECT * FROM settings WHERE key = ?').get(def.key) as
      | SettingRow
      | undefined;
    let value: unknown;
    if (row) {
      try {
        value = JSON.parse(row.value_json);
      } catch {
        value = def.default(cfg);
      }
    } else {
      value = def.default(cfg);
    }
    return {
      key: def.key,
      label: def.label,
      description: def.description,
      value,
      source: row ? 'database' : 'default',
      version: row?.version ?? 0,
      updatedAt: row?.updated_at ?? null,
      updatedBy: row?.updated_by ?? null,
      sensitive: def.sensitive ?? false,
    };
  });
}

export interface SettingsUpdateResult {
  applied: string[];
  rejected: { key: string; problem: string }[];
  configVersion: string;
}

export interface SettingsActor {
  userId: string | null;
  label: 'owner' | 'staff' | 'system' | 'scheduler';
  ipHash?: string | null;
}

/** Hard ceilings that individual settings may never exceed. */
function clampAgainstCeiling(key: string, value: unknown, cfg: Config): unknown {
  if (key === 'daily_call_limit' && typeof value === 'number') {
    return Math.min(value, cfg.hardDailyCallLimit);
  }
  if (key === 'daily_budget' && value && typeof value === 'object') {
    const b = value as { limitMinor?: number };
    if (typeof b.limitMinor === 'number') {
      return { ...b, limitMinor: Math.min(b.limitMinor, cfg.hardDailyBudgetMinor) };
    }
  }
  return value;
}

export function updateSettings(
  db: DB,
  cfg: Config,
  updates: Record<string, unknown>,
  actor: SettingsActor,
): SettingsUpdateResult {
  const result: SettingsUpdateResult = { applied: [], rejected: [], configVersion: '' };

  for (const [key, raw] of Object.entries(updates)) {
    let def: SettingDefinition;
    try {
      def = settingDefinition(key);
    } catch {
      result.rejected.push({ key, problem: 'unknown setting' });
      continue;
    }
    const clamped = clampAgainstCeiling(key, raw, cfg);
    const parsed = def.schema.safeParse(clamped);
    if (!parsed.success) {
      result.rejected.push({
        key,
        problem: parsed.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; '),
      });
      continue;
    }
    if (key === 'calling_schedule') {
      const s = parsed.data as { startTime: string; endTime: string; days: number[] };
      if (s.startTime === s.endTime) {
        result.rejected.push({ key, problem: 'start and end times must differ' });
        continue;
      }
    }

    const existing = db.prepare('SELECT value_json, version FROM settings WHERE key = ?').get(key) as
      | { value_json: string; version: number }
      | undefined;

    const serialized = JSON.stringify(parsed.data);
    if (existing && existing.value_json === serialized) {
      continue; // no-op update: do not bump version or write audit noise
    }

    db.prepare(
      `INSERT INTO settings (key, value_json, version, updated_by, updated_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         version = settings.version + 1,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    ).run(key, serialized, actor.userId, nowIso());

    recordAudit(db, {
      actorUserId: actor.userId,
      actorLabel: actor.label,
      action: 'settings.update',
      entityType: 'setting',
      entityId: key,
      summary: `Setting "${def.label}" updated`,
      details: { key, previous: existing ? JSON.parse(existing.value_json) : null, next: parsed.data },
      ipHash: actor.ipHash ?? null,
    });
    result.applied.push(key);
  }

  result.configVersion = configVersion(db);
  return result;
}

/**
 * Remove a stored override so the compiled-in default applies again. This is
 * the "reset" path used by the dashboard; it is audited like any other change.
 */
export function resetSetting(
  db: DB,
  key: string,
  actor: SettingsActor,
): { reset: boolean; configVersion: string } {
  const def = settingDefinition(key); // throws AppError('not_found') for unknown keys
  const existing = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
    | { value_json: string }
    | undefined;
  if (!existing) {
    return { reset: false, configVersion: configVersion(db) };
  }
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  recordAudit(db, {
    actorUserId: actor.userId,
    actorLabel: actor.label,
    action: 'settings.reset',
    entityType: 'setting',
    entityId: key,
    summary: `Setting "${def.label}" reset to its default`,
    details: { key, previous: JSON.parse(existing.value_json) },
    ipHash: actor.ipHash ?? null,
  });
  return { reset: true, configVersion: configVersion(db) };
}

/** Deterministic fingerprint of the current configuration (used in approvals). */
export function configVersion(db: DB): string {
  const rows = db.prepare('SELECT key, version FROM settings ORDER BY key').all() as {
    key: string;
    version: number;
  }[];
  const bare = rows.map((r) => `${r.key}v${r.version}`).join('|');
  // FNV-1a, dependency free - only needs to detect changes, not be secret.
  let h = 0x811c9dc5;
  for (let i = 0; i < bare.length; i++) {
    h ^= bare.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
