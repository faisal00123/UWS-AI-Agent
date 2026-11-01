/**
 * Phase 8 integration tests: reconciliation, daily reports, notifications,
 * their HTTP routes and the background jobs.
 *
 * Determinism rules:
 *  - reconciliation/report domain tests pass an explicit `now` (NOW), so the
 *    business-day window and the "stuck" grace period never depend on the
 *    wall clock
 *  - PAST is a fixed date in the past, so its report status is predictably
 *    'final' whenever the suite runs
 *  - row helpers insert with explicit created_at values inside the target
 *    business-day window (Asia/Karachi, UTC+5): 2026-06-15 local =
 *    [2026-06-14T19:00Z, 2026-06-15T19:00Z)
 *
 * Safety: every test uses an in-memory database; jobs run against injected
 * fakes (a fake EmailPort), so nothing can ever reach a real provider.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type DB } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { loadConfig, type Config } from '../../src/core/config.ts';
import { nullLogger } from '../../src/core/logger.ts';
import { newId } from '../../src/core/ids.ts';
import { businessDayKey, nowIso } from '../../src/core/time.ts';
import { createLead } from '../../src/domain/leads/repository.ts';
import { updateSettings } from '../../src/domain/settings/service.ts';
import { emergencyStop, summarise } from '../../src/domain/state/service.ts';
import { createUser } from '../../src/domain/auth/service.ts';
import {
  businessDayUtcRange,
  pastBusinessDayKeys,
  previousBusinessDayKey,
  reconcileDay,
  type Reconciliation,
} from '../../src/domain/reporting/reconcile.ts';
import { generateDailyReport, getReport, listReports } from '../../src/domain/reporting/report.ts';
import {
  deliverPendingNotifications,
  listNotifications,
  markNotificationRead,
  notify,
  unreadCount,
} from '../../src/domain/notifications/service.ts';
import {
  dailyReportJob,
  notificationDeliveryJob,
  safeguardWatchJob,
} from '../../src/jobs/reporting.ts';
import type { JobContext } from '../../src/jobs/scheduler.ts';
import type { AdapterRegistry } from '../../src/adapters/registry.ts';
import type { EmailMessage, EmailPort } from '../../src/adapters/types.ts';
import {
  TEST_ENV,
  loginAs,
  seedOwner,
  startTestServer,
  type TestClient,
  type TestServer,
} from '../helpers/app.ts';

/** 17:00 Asia/Karachi on 2026-10-29 -> business day key 2026-10-29. */
const NOW = new Date('2026-10-29T12:00:00.000Z');
const TZ = 'Asia/Karachi';
const PAST = '2026-06-15'; // always in the past -> status 'final'
const PAST_START = '2026-06-14T19:00:00.000Z';
const PAST_END = '2026-06-15T19:00:00.000Z';
const TODAY = '2026-10-29';

const owner = { userId: null, label: 'owner' as const };

function freshDb(): { db: DB; cfg: Config } {
  const cfg = loadConfig(TEST_ENV);
  const db = openDatabase(':memory:');
  runMigrations(db);
  return { db, cfg };
}

function addLead(db: DB, name: string, phone: string): string {
  return createLead(db, { displayName: name, city: 'Karachi', phone }, owner).id;
}

let phoneSeq = 0;
function nextPhone(): string {
  phoneSeq += 1;
  return `+923001234${String(phoneSeq).padStart(4, '0')}`;
}

interface AttemptOpts {
  decision?: 'allowed' | 'blocked';
  blockedCode?: string | null;
  callId?: string | null;
  messageId?: string | null;
  createdAt?: string;
  mode?: 'simulation' | 'live';
}

function insertAttempt(db: DB, bizId: string, channel: string, opts: AttemptOpts = {}): string {
  const id = newId('att');
  const decision = opts.decision ?? 'allowed';
  db.prepare(
    `INSERT INTO outreach_attempts (id, business_id, channel, purpose, decision, blocked_code,
       guard_results_json, idempotency_key, mode, provider, call_id, message_id, created_by, created_at)
     VALUES (?, ?, ?, 'initial_outreach', ?, ?, '{}', ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    id,
    bizId,
    channel,
    decision,
    decision === 'blocked' ? (opts.blockedCode ?? 'paused') : null,
    newId('idem'),
    opts.mode ?? 'simulation',
    opts.mode === 'live' ? 'twilio' : 'simulation',
    opts.callId ?? null,
    opts.messageId ?? null,
    opts.createdAt ?? nowIso(),
  );
  return id;
}

interface CallOpts {
  status: string;
  simulation: 0 | 1;
  createdAt: string;
  outcome?: string;
  duration?: number | null;
  providerCallId?: string | null;
}

function insertCall(db: DB, bizId: string, opts: CallOpts): string {
  const id = newId('cal');
  db.prepare(
    `INSERT INTO calls (id, attempt_id, business_id, direction, channel, provider, provider_call_id,
       status, outcome, to_number_e164, recording_enabled, recording_consent, duration_seconds,
       started_at, simulation, counts_against_daily_limit, daily_bucket, cost_state, created_at, updated_at)
     VALUES (?, NULL, ?, 'outbound', 'call', ?, ?, ?, ?, '+923000000000', 0, 0, ?, ?, ?, 1, ?, 'unavailable', ?, ?)`,
  ).run(
    id,
    bizId,
    opts.simulation === 1 ? 'simulation' : 'twilio',
    opts.providerCallId ?? null,
    opts.status,
    opts.outcome ?? 'unknown',
    opts.duration ?? null,
    opts.createdAt,
    opts.simulation,
    opts.createdAt.slice(0, 10),
    opts.createdAt,
    opts.createdAt,
  );
  return id;
}

interface MsgOpts {
  status: string;
  simulation: 0 | 1;
  createdAt: string;
}

function insertMessage(db: DB, bizId: string, opts: MsgOpts): string {
  const id = newId('msg');
  db.prepare(
    `INSERT INTO messages (id, attempt_id, business_id, channel, provider, provider_message_id, template_key,
       purpose, number_used, number_source, body_preview, status, status_source, error_code, error_detail,
       simulation, counts_against_daily_limit, daily_bucket, cost_minor, cost_currency, cost_state,
       sent_at, last_status_at, created_at, updated_at)
     VALUES (?, NULL, ?, 'whatsapp_message', ?, ?, ?, 'portfolio_share', '+923000000000', 'owner_configured',
       'preview', ?, ?, NULL, NULL, ?, 1, ?, NULL, NULL, 'unavailable', ?, ?, ?, ?)`,
  ).run(
    id,
    bizId,
    opts.simulation === 1 ? 'simulation' : 'whatsapp_cloud_api',
    opts.simulation === 1 ? null : `wamid.FAKE${id.slice(-6)}`,
    'portfolio_v1',
    opts.status,
    opts.simulation === 1 ? 'simulation' : 'provider_event',
    opts.simulation,
    opts.createdAt.slice(0, 10),
    opts.createdAt,
    opts.createdAt,
    opts.createdAt,
    opts.createdAt,
  );
  return id;
}

function setUsage(
  db: DB,
  usageDate: string,
  metric: string,
  used: number,
  limit: number,
  state: 'ok' | 'warning' | 'exhausted' = 'ok',
): void {
  db.prepare(
    `INSERT INTO budget_usage (usage_date, metric, used_value, limit_value, state, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(usage_date, metric) DO UPDATE SET
       used_value = excluded.used_value, limit_value = excluded.limit_value,
       state = excluded.state, updated_at = excluded.updated_at`,
  ).run(usageDate, metric, used, limit, state, nowIso());
}

function disc(recon: Reconciliation, code: string): { severity: string; count: number; detail: string; refs: string[] } | undefined {
  return recon.discrepancies.find((d) => d.code === code);
}

function fakeEmailPort(
  opts: { fail?: boolean; failFor?: string } = {},
): { port: EmailPort; sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  const port: EmailPort = {
    key: 'email',
    label: 'Fake SMTP',
    status: () => ({
      key: 'email',
      label: 'Fake SMTP',
      implementation: 'fake',
      state: 'configured',
      features: [],
      lastError: null,
    }),
    send: async (msg: EmailMessage) => {
      if (opts.fail || (opts.failFor && msg.subject === opts.failFor)) {
        throw new Error('connection refused');
      }
      sent.push(msg);
      return { messageId: `eml_${sent.length}` };
    },
  };
  return { port, sent };
}

// ===================================================================== 1. ===
describe('reconciliation', () => {
  test('a quiet day passes every check with no discrepancies', () => {
    const { db, cfg } = freshDb();
    const recon = reconcileDay(db, cfg, PAST, NOW);
    assert.equal(recon.discrepancies.length, 0);
    assert.ok(recon.checks.every((c) => c.passed));
    assert.deepEqual(recon.missingData, []);
    assert.equal(recon.windowStartUtc, PAST_START);
    assert.equal(recon.windowEndUtc, PAST_END);
  });

  test('an allowed attempt with no execution row is a critical discrepancy', () => {
    const { db, cfg } = freshDb();
    const biz = addLead(db, 'Missing Exec Traders', nextPhone());
    const attId = insertAttempt(db, biz, 'call', { createdAt: `${PAST}T10:00:00.000Z` });
    const recon = reconcileDay(db, cfg, PAST, NOW);
    const d = disc(recon, 'missing_execution');
    assert.ok(d, 'missing_execution discrepancy expected');
    assert.equal(d.severity, 'critical');
    assert.equal(d.count, 1);
    assert.deepEqual(d.refs, [attId]);
    assert.equal(recon.checks.find((c) => c.code === 'missing_execution')?.passed, false);
  });

  test('counter drift between ledger and budget counters is critical', () => {
    const { db, cfg } = freshDb();
    const biz = addLead(db, 'Drift Traders', nextPhone());
    const at = `${PAST}T09:00:00.000Z`;
    insertAttempt(db, biz, 'call', { createdAt: at });
    setUsage(db, PAST, 'calls', 3, 100); // counter says 3, ledger says 1
    const recon = reconcileDay(db, cfg, PAST, NOW);
    const d = disc(recon, 'counter_drift');
    assert.ok(d, 'counter_drift discrepancy expected');
    assert.equal(d.severity, 'critical');
    assert.equal(d.count, 1);
    assert.ok(d.detail.includes('counter=3'));
    assert.ok(d.detail.includes('allowed attempts=1'));
  });

  test('a live call stuck beyond the grace period is flagged; a fresh one is not', () => {
    const { db, cfg } = freshDb();
    const oldBiz = addLead(db, 'Stuck Call Traders', nextPhone());
    const freshBiz = addLead(db, 'Fresh Call Traders', nextPhone());
    const oldCall = insertCall(db, oldBiz, {
      status: 'ringing',
      simulation: 0,
      providerCallId: 'CA_stuck1',
      createdAt: new Date(NOW.getTime() - 120 * 60_000).toISOString(), // 2h ago, inside today's window
    });
    insertCall(db, freshBiz, {
      status: 'queued',
      simulation: 0,
      providerCallId: 'CA_fresh1',
      createdAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), // still in flight: normal
    });
    const recon = reconcileDay(db, cfg, TODAY, NOW);
    const d = disc(recon, 'call_without_provider_callback');
    assert.ok(d, 'stuck call discrepancy expected');
    assert.equal(d.severity, 'warning');
    assert.equal(d.count, 1);
    assert.deepEqual(d.refs, [oldCall]);
  });

  test('a live message stuck beyond the grace period is flagged', () => {
    const { db, cfg } = freshDb();
    const biz = addLead(db, 'Stuck Msg Traders', nextPhone());
    const msg = insertMessage(db, biz, {
      status: 'accepted',
      simulation: 0,
      createdAt: new Date(NOW.getTime() - 90 * 60_000).toISOString(),
    });
    const recon = reconcileDay(db, cfg, TODAY, NOW);
    const d = disc(recon, 'message_without_provider_callback');
    assert.ok(d, 'stuck message discrepancy expected');
    assert.equal(d.severity, 'warning');
    assert.equal(d.count, 1);
    assert.deepEqual(d.refs, [msg]);
  });

  test('missing cost data is reported as missing, never estimated', () => {
    const { db, cfg } = freshDb();
    const biz = addLead(db, 'Costly Traders', nextPhone());
    insertAttempt(db, biz, 'call', { createdAt: `${PAST}T10:00:00.000Z` });
    const recon = reconcileDay(db, cfg, PAST, NOW);
    const d = disc(recon, 'cost_data_unavailable');
    assert.ok(d, 'cost_data_unavailable expected when activity exists');
    assert.equal(d.severity, 'info');
    assert.equal(recon.missingData.length, 1);
    assert.ok(recon.missingData[0]!.includes('cost'));
  });
});

// ===================================================================== 2. ===
describe('daily reports', () => {
  test('a past day report is final with correct totals', () => {
    const { db, cfg } = freshDb();
    const biz = addLead(db, 'Report Traders', nextPhone());
    db.prepare('UPDATE businesses SET created_at = ? WHERE id = ?').run(`${PAST}T08:00:00.000Z`, biz);

    const att = insertAttempt(db, biz, 'call', { createdAt: `${PAST}T10:00:00.000Z` });
    insertCall(db, biz, {
      status: 'completed',
      simulation: 1,
      outcome: 'answered',
      duration: 42,
      createdAt: `${PAST}T10:00:05.000Z`,
    });
    db.prepare('UPDATE outreach_attempts SET call_id = ? WHERE id = ?').run(biz, att); // link execution
    insertAttempt(db, biz, 'call', {
      decision: 'blocked',
      blockedCode: 'paused',
      createdAt: `${PAST}T11:00:00.000Z`,
    });
    insertMessage(db, biz, { status: 'sent', simulation: 1, createdAt: `${PAST}T12:00:00.000Z` });
    setUsage(db, PAST, 'calls', 1, 100);

    const report = generateDailyReport(db, cfg, { reportDate: PAST, now: NOW });
    assert.equal(report.status, 'final');
    assert.equal(report.totals.leads.created, 1);
    assert.equal(report.totals.attempts.total, 2);
    assert.equal(report.totals.attempts.allowed, 1);
    assert.equal(report.totals.attempts.blocked, 1);
    assert.equal(report.totals.attempts.blockedByCode['paused'], 1);
    assert.equal(report.totals.calls.total, 1);
    assert.equal(report.totals.calls.simulated, 1);
    assert.equal(report.totals.calls.live, 0);
    assert.equal(report.totals.calls.byOutcome['answered'], 1);
    assert.equal(report.totals.calls.totalDurationSeconds, 42);
    assert.equal(report.totals.messages.total, 1);
    assert.equal(report.totals.messages.simulated, 1);
    assert.equal(report.totals.budget.usage[0]?.metric, 'calls');
    assert.equal(report.totals.budget.usage[0]?.used, 1);
    assert.equal(report.totals.mode, 'simulation');
    // cost feed absent: only an INFO note, so the discrepancy count stays 0
    assert.equal(report.discrepanciesCount, 0);
    assert.equal(report.reconciliation.discrepancies.length, 1);
    assert.equal(report.reconciliation.discrepancies[0]?.code, 'cost_data_unavailable');
    assert.equal(report.missingData.length, 1);
  });

  test('regeneration is idempotent and the owner is notified once', () => {
    const { db, cfg } = freshDb();
    const first = generateDailyReport(db, cfg, { reportDate: PAST, now: NOW });
    const second = generateDailyReport(db, cfg, { reportDate: PAST, now: NOW });
    assert.equal(first.id, second.id, 'stored id reused across regenerations');

    const row = db.prepare('SELECT COUNT(*) c FROM daily_reports WHERE report_date = ?').get(PAST) as { c: number };
    assert.equal(row.c, 1);

    const notifs = listNotifications(db, { limit: 50 }).filter((n) => n.title.includes(PAST));
    assert.equal(notifs.length, 1);
    assert.equal(notifs[0]?.kind, 'daily_report');
    assert.ok(notifs[0]?.body.includes('Attempts: 0 requested'));
  });

  test("today's report is a draft and future dates are rejected", () => {
    const { db, cfg } = freshDb();
    const report = generateDailyReport(db, cfg, { reportDate: TODAY, now: NOW });
    assert.equal(report.status, 'draft');
    const notifs = listNotifications(db, { limit: 50 }).filter((n) => n.kind === 'daily_report');
    assert.equal(notifs.length, 0, 'drafts never notify the owner');

    assert.throws(
      () => generateDailyReport(db, cfg, { reportDate: '2099-01-01', now: NOW }),
      /future/,
    );
  });

  test('listReports returns newest-first summaries', () => {
    const { db, cfg } = freshDb();
    generateDailyReport(db, cfg, { reportDate: '2026-06-10', now: NOW, notifyOwner: false });
    generateDailyReport(db, cfg, { reportDate: PAST, now: NOW, notifyOwner: false });
    const items = listReports(db);
    assert.equal(items.length, 2);
    assert.equal(items[0]?.reportDate, PAST);
    assert.equal(items[0]?.status, 'final');
    const stored = getReport(db, PAST);
    assert.equal(stored?.totals.window.start, PAST_START);
  });
});

// ===================================================================== 3. ===
describe('notifications', () => {
  test('fan-out follows the destinations setting and dedupes per channel', () => {
    const { db, cfg } = freshDb();
    // Default destinations: dashboard only.
    const first = notify(db, cfg, {
      kind: 'test',
      title: 'Hello',
      body: 'World',
      dedupeKey: 'evt:1',
    });
    assert.equal(first.created.length, 1);
    const again = notify(db, cfg, { kind: 'test', title: 'Hello', body: 'World', dedupeKey: 'evt:1' });
    assert.equal(again.created.length, 0);
    assert.equal(again.skipped.length, 1);
    assert.equal(listNotifications(db).length, 1);

    // Owner adds an email destination -> same event reaches both channels.
    updateSettings(
      db,
      cfg,
      { notification_destinations: { dashboard: true, email: 'owner@uws.test', whatsapp: '' } },
      owner,
    );
    const both = notify(db, cfg, { kind: 'test', title: 'Both', body: 'x', dedupeKey: 'evt:2' });
    assert.equal(both.created.length, 2);
    const channels = listNotifications(db).filter((n) => n.title === 'Both').map((n) => n.channel).sort();
    assert.deepEqual(channels, ['email', 'in_app']);
  });

  test('delivery sends email, records failures and skips WhatsApp with the honest reason', async () => {
    const { db, cfg } = freshDb();
    updateSettings(
      db,
      cfg,
      { notification_destinations: { dashboard: true, email: 'owner@uws.test', whatsapp: '+923001110000' } },
      owner,
    );
    notify(db, cfg, { kind: 'test', title: 'Send me', body: 'body-1', dedupeKey: 'del:1' });
    notify(db, cfg, { kind: 'test', title: 'Fail me', body: 'body-2', dedupeKey: 'del:2' });

    // Two notifies -> two email rows + two WhatsApp rows (plus two in_app).
    const fake = fakeEmailPort({ failFor: 'Fail me' });
    const result = await deliverPendingNotifications(db, cfg, { email: fake.port });
    assert.deepEqual(result, { sent: 1, failed: 1, skipped: 2 });
    assert.equal(fake.sent.length, 1);
    assert.equal(fake.sent[0]?.to, 'owner@uws.test');
    assert.equal(fake.sent[0]?.subject, 'Send me');

    // Rows share titles across channels, so look them up per channel.
    const byTitle = (t: string, channel: 'email' | 'whatsapp' | 'in_app') =>
      listNotifications(db, { channel }).find((n) => n.title === t);
    assert.equal(byTitle('Send me', 'email')?.status, 'sent');
    assert.ok(byTitle('Send me', 'email')?.errorDetail === null);
    const failed = byTitle('Fail me', 'email');
    assert.equal(failed?.status, 'failed');
    assert.ok(failed?.errorDetail?.includes('connection refused'));

    const wa = listNotifications(db, { channel: 'whatsapp' })[0];
    assert.equal(wa?.status, 'skipped');
    assert.ok(wa?.errorDetail?.includes('template'));

    // Queue drained: a second delivery run is a silent no-op.
    const idle = await deliverPendingNotifications(db, cfg, { email: fake.port });
    assert.deepEqual(idle, { sent: 0, failed: 0, skipped: 0 });
  });

  test('email delivery is skipped honestly when SMTP is unconfigured', async () => {
    const { db, cfg } = freshDb();
    updateSettings(
      db,
      cfg,
      { notification_destinations: { dashboard: true, email: 'owner@uws.test', whatsapp: '' } },
      owner,
    );
    notify(db, cfg, { kind: 'test', title: 'No port', body: 'x', dedupeKey: 'del:noport' });
    const res = await deliverPendingNotifications(db, cfg, { email: null });
    assert.equal(res.skipped, 1);
    const row = listNotifications(db).find((n) => n.title === 'No port');
    assert.equal(row?.status, 'skipped');
    assert.ok(row?.errorDetail?.includes('SMTP is not configured'));
  });

  test('marking read preserves delivery state and tracks unread counts', () => {
    const { db, cfg } = freshDb();
    updateSettings(
      db,
      cfg,
      { notification_destinations: { dashboard: true, email: 'owner@uws.test', whatsapp: '' } },
      owner,
    );
    notify(db, cfg, { kind: 'test', title: 'InApp', body: 'a', dedupeKey: 'r:1' });
    notify(db, cfg, { kind: 'test', title: 'Mail', body: 'b', dedupeKey: 'r:2' });
    assert.equal(unreadCount(db), 4, 'each notify fans out to in_app + email');

    const inApp = listNotifications(db, { channel: 'in_app' })[0]!;
    const read = markNotificationRead(db, inApp.id);
    assert.equal(read.status, 'read');
    assert.ok(read.readAt);
    assert.equal(unreadCount(db), 3);

    // An undelivered email row keeps its delivery status; read_at carries the
    // read (a delivered row would similarly keep 'sent').
    const mail = listNotifications(db, { channel: 'email' })[0]!;
    const readMail = markNotificationRead(db, mail.id);
    assert.equal(readMail.status, 'pending');
    assert.ok(readMail.readAt);
    assert.equal(unreadCount(db), 2);

    assert.throws(() => markNotificationRead(db, 'ntf_missing'), /not found|Notification/i);
  });
});

// ===================================================================== 4. ===
describe('routes: notifications & reports', () => {
  let server: TestServer;
  let ownerClient: TestClient;
  let ownerUserId: string;

  before(async () => {
    server = await startTestServer();
    const seeded = await seedOwner(server);
    ownerUserId = seeded.user.id;
    ownerClient = await loginAs(server, seeded.email, seeded.password);
  });
  after(async () => {
    await server.close();
  });

  test('owner sees notifications and can mark them read', async () => {
    notify(server.db, server.config, { kind: 'test', title: 'Route notif', body: 'x', dedupeKey: 'route:1' });
    const list = await ownerClient.get<{ items: { id: string; title: string }[]; unread: number }>('/api/notifications');
    assert.equal(list.status, 200);
    assert.ok(list.body.items.some((n) => n.title === 'Route notif'));
    assert.ok(list.body.unread >= 1);

    const target = list.body.items.find((n) => n.title === 'Route notif')!;
    const read = await ownerClient.post<{ notification: { readAt: string | null }; unread: number }>(
      `/api/notifications/${target.id}/read`,
    );
    assert.equal(read.status, 200);
    assert.ok(read.body.notification.readAt);
  });

  test('reports are owner-only; notifications are visible to staff', async () => {
    // Anonymous: 401.
    const anon = server.client();
    assert.equal((await anon.get('/api/reports')).status, 401);
    assert.equal((await anon.get('/api/notifications')).status, 401);

    // Staff: notifications yes, reports no.
    const staffEmail = `staff-${Date.now()}@uws.test`;
    await createUser(
      server.db,
      server.config,
      { email: staffEmail, password: 'Staff-Password-123!', displayName: 'Staff Member', role: 'staff' },
      { userId: ownerUserId, label: 'owner' },
    );
    const staff = await loginAs(server, staffEmail, 'Staff-Password-123!');
    assert.equal((await staff.get('/api/notifications')).status, 200);
    const forbidden = await staff.get<{ error: { code: string } }>('/api/reports');
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'forbidden');

    // Owner: 200 on both.
    assert.equal((await ownerClient.get('/api/reports')).status, 200);
  });

  test('owner can generate a report on demand, exactly once per date', async () => {
    const gen1 = await ownerClient.post<{ report: { status: string; reportDate: string } }>(
      `/api/reports/${PAST}/generate`,
    );
    assert.equal(gen1.status, 201);
    assert.equal(gen1.body.report.status, 'final');

    const gen2 = await ownerClient.post<{ report: { reportDate: string } }>(`/api/reports/${PAST}/generate`);
    assert.equal(gen2.status, 201);

    const count = server.db
      .prepare('SELECT COUNT(*) c FROM daily_reports WHERE report_date = ?')
      .get(PAST) as { c: number };
    assert.equal(count.c, 1);

    const audits = server.db
      .prepare(`SELECT COUNT(*) c FROM audit_events WHERE action = 'report.generate' AND entity_id = ?`)
      .get(PAST) as { c: number };
    assert.equal(audits.c, 2);

    const get = await ownerClient.get<{ report: { totals: { attempts: { total: number } } } }>(
      `/api/reports/${PAST}`,
    );
    assert.equal(get.status, 200);
    assert.ok(get.body.report.totals);
  });

  test('bad dates are rejected', async () => {
    assert.equal((await ownerClient.get('/api/reports/not-a-date')).status, 400);
    const future = await ownerClient.post('/api/reports/2099-01-01/generate');
    assert.equal(future.status, 400);
    const missing = await ownerClient.get('/api/reports/2020-01-01');
    assert.equal(missing.status, 404);
  });
});

// ===================================================================== 5. ===
describe('jobs', () => {
  function ctxFor(db: DB, cfg: Config, now: Date, adapters?: AdapterRegistry): JobContext {
    return { db, config: cfg, logger: nullLogger, guard: summarise(db), now, adapters };
  }

  test('daily_report finalizes yesterday and self-heals active past days only', async () => {
    const { db, cfg } = freshDb();
    const yesterday = previousBusinessDayKey(NOW, TZ);
    assert.equal(yesterday, '2026-10-28');

    // Activity yesterday and three days ago; nothing on 2026-10-25.
    for (const [date, name] of [
      [yesterday, 'Yesterday Traders'],
      ['2026-10-26', 'Longback Traders'],
    ] as const) {
      const biz = addLead(db, name, nextPhone());
      const { start } = businessDayUtcRange(cfg, date);
      const at = new Date(start.getTime() + 10 * 3_600_000).toISOString(); // 10:00 local
      const att = insertAttempt(db, biz, 'call', { createdAt: at });
      insertCall(db, biz, { status: 'completed', simulation: 1, outcome: 'answered', duration: 30, createdAt: at });
      db.prepare('UPDATE outreach_attempts SET call_id = ? WHERE id = ?').run(biz, att);
      setUsage(db, date, 'calls', 1, 100);
    }

    const result = await dailyReportJob.run(ctxFor(db, cfg, NOW));
    assert.equal(result?.detail, 'generated/refreshed 2 report(s)');

    const dates = (db.prepare('SELECT report_date FROM daily_reports ORDER BY report_date').all() as { report_date: string }[]).map(
      (r) => r.report_date,
    );
    assert.deepEqual(dates, ['2026-10-26', '2026-10-28']);
    assert.equal(getReport(db, yesterday)?.status, 'final');

    // One report_ready notification per date, no duplicates on re-run.
    const notifs = listNotifications(db, { limit: 50 }).filter((n) => n.kind === 'daily_report');
    assert.equal(notifs.length, 2);

    const rerun = await dailyReportJob.run(ctxFor(db, cfg, NOW));
    assert.equal(rerun?.detail, 'generated/refreshed 1 report(s)', 'finalized past days are skipped on re-run');
    const after = db.prepare('SELECT COUNT(*) c FROM daily_reports').get() as { c: number };
    assert.equal(after.c, 2);
    const notifsAfter = listNotifications(db, { limit: 50 }).filter((n) => n.kind === 'daily_report');
    assert.equal(notifsAfter.length, 2, 'report_ready notifications never re-fire');
  });

  test('notification_delivery sends email via the registry and skips queue when idle', async () => {
    const { db, cfg } = freshDb();
    updateSettings(
      db,
      cfg,
      { notification_destinations: { dashboard: true, email: 'owner@uws.test', whatsapp: '+923001110000' } },
      owner,
    );
    notify(db, cfg, { kind: 'test', title: 'Job mail', body: 'x', dedupeKey: 'job:mail' });

    const fake = fakeEmailPort();
    const adapters = { email: fake.port } as unknown as AdapterRegistry;
    const result = await notificationDeliveryJob.run(ctxFor(db, cfg, NOW, adapters));
    assert.equal(result?.detail, 'sent 1, failed 0, skipped 1');
    assert.equal(fake.sent.length, 1);
    const mail = listNotifications(db, { channel: 'email' })[0];
    assert.equal(mail?.status, 'sent');

    // Nothing pending: the job returns no detail (silent no-op, no job_runs churn).
    const idle = await notificationDeliveryJob.run(ctxFor(db, cfg, NOW, adapters));
    assert.equal(idle, undefined);
  });

  test('notification_delivery records provider failures per row', async () => {
    const { db, cfg } = freshDb();
    updateSettings(
      db,
      cfg,
      { notification_destinations: { dashboard: true, email: 'owner@uws.test', whatsapp: '' } },
      owner,
    );
    notify(db, cfg, { kind: 'test', title: 'Doomed', body: 'x', dedupeKey: 'job:doomed' });
    const failing = fakeEmailPort({ fail: true });
    const adapters = { email: failing.port } as unknown as AdapterRegistry;
    const result = await notificationDeliveryJob.run(ctxFor(db, cfg, NOW, adapters));
    assert.equal(result?.detail, 'sent 0, failed 1, skipped 0');
    assert.equal(listNotifications(db)[0]?.status, 'failed');
  });

  test('safeguard watch raises deduplicated emergency-stop and budget notifications', async () => {
    const { db, cfg } = freshDb();
    const date = businessDayKey(NOW, TZ);

    assert.equal(await safeguardWatchJob.run(ctxFor(db, cfg, NOW)), undefined, 'quiet when nothing is active');

    emergencyStop(db, 'test: stopping everything', owner);
    const first = await safeguardWatchJob.run(ctxFor(db, cfg, NOW));
    assert.equal(first?.detail, 'raised 1 notification(s)');
    const stop = listNotifications(db, { limit: 50 }).find((n) => n.kind === 'emergency_stop');
    assert.equal(stop?.severity, 'critical');
    assert.ok(stop?.body.includes('Resuming requires the owner'));

    setUsage(db, date, 'calls', 100, 100, 'exhausted');
    assert.equal((await safeguardWatchJob.run(ctxFor(db, cfg, NOW)))?.detail, 'raised 1 notification(s)');
    const budget = listNotifications(db, { limit: 50 }).find((n) => n.kind === 'budget');
    assert.equal(budget?.severity, 'critical');
    assert.ok(budget?.body.includes('100/100'));

    // Re-running never repeats itself.
    assert.equal(await safeguardWatchJob.run(ctxFor(db, cfg, NOW)), undefined);
    assert.equal(listNotifications(db, { limit: 50 }).filter((n) => n.kind === 'emergency_stop').length, 1);
    assert.equal(listNotifications(db, { limit: 50 }).filter((n) => n.kind === 'budget').length, 1);
  });
});
