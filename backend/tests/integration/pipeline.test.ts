/**
 * Phase 5 integration tests: pipeline stage transitions, interaction evidence,
 * and the follow-up scheduling engine.
 *
 * These exercise the integrity rules that make the CRM trustworthy:
 *  - contact-gated stages need real customer contact, not bookkeeping
 *  - only the owner can confirm a conversion
 *  - follow-ups respect the owner's calling window
 *  - a suppression that lands after scheduling blocks the task
 *  - a completed follow-up must cite a real contact interaction
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type DB } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { loadConfig, type Config } from '../../src/core/config.ts';
import { createLead } from '../../src/domain/leads/repository.ts';
import {
  recordInteraction,
  listInteractions,
  hasContactEvidence,
} from '../../src/domain/pipeline/interactions.ts';
import {
  scheduleFollowup,
  scheduleSequence,
  listTasks,
  markDue,
  completeTask,
  cancelTask,
  evaluateDueTasks,
  callingWindowFor,
  nextAllowedSlot,
  inCallingWindow,
} from '../../src/domain/pipeline/followups.ts';
import { advanceStage, interactionCounts } from '../../src/domain/pipeline/service.ts';
import { suppress } from '../../src/domain/eligibility/service.ts';
import { updateSettings } from '../../src/domain/settings/service.ts';

let db: DB;
let cfg: Config;

const owner = { userId: null, label: 'owner' as const };
const staff = { userId: null, label: 'staff' as const };

// Each lead must be genuinely distinct: createLead auto-merges on an exact
// phone match (1.0) OR a name+city match (0.92), and a merged lead is correctly
// ineligible via is_live_record. Counter makes both unique while keeping every
// number a valid PK mobile shape (0300 + 7 digits).
let leadSeq = 0;
function makeLead(name = 'Pipeline Co'): string {
  const seq = leadSeq++;
  const phone = `0300${String(1000000 + seq).slice(-7)}`;
  const res = createLead(db, { displayName: `${name} ${seq}`, city: 'Karachi', phone }, owner);
  return res.id;
}

describe('pipeline interactions', () => {
  before(() => {
    cfg = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'test'.padEnd(48, '0'), DATABASE_PATH: ':memory:' });
    db = openDatabase(':memory:');
    runMigrations(db);
  });
  after(() => db.close());

  test('records an interaction with direction and evidence', () => {
    const id = makeLead();
    const inter = recordInteraction(db, {
      businessId: id,
      kind: 'call',
      direction: 'outbound',
      summary: 'Introduced UWS services',
      outcome: 'asked_for_callback',
      evidence: { durationSeconds: 42 },
    });
    assert.ok(inter.id);
    assert.equal(inter.kind, 'call');
    assert.deepEqual(inter.evidence, { durationSeconds: 42 });
    assert.equal(listInteractions(db, { businessId: id }).length, 1);
  });

  test('system and score interactions do NOT count as contact evidence', () => {
    const id = makeLead();
    recordInteraction(db, { businessId: id, kind: 'system', summary: 'auto-scored' });
    recordInteraction(db, { businessId: id, kind: 'score', summary: 'score 72' });
    recordInteraction(db, { businessId: id, kind: 'import', summary: 'imported from csv' });
    assert.equal(hasContactEvidence(db, id), false, 'bookkeeping is not customer contact');
  });

  test('real contact kinds count as evidence', () => {
    const id = makeLead();
    recordInteraction(db, { businessId: id, kind: 'whatsapp_message', summary: 'sent portfolio' });
    assert.equal(hasContactEvidence(db, id), true);
  });

  test('empty summary is refused', () => {
    const id = makeLead();
    assert.throws(() => recordInteraction(db, { businessId: id, kind: 'note', summary: '   ' }));
  });
});

describe('follow-up scheduling', () => {
  before(() => {
    cfg = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'test'.padEnd(48, '0'), DATABASE_PATH: ':memory:' });
    db = openDatabase(':memory:');
    runMigrations(db);
    // Enable voice so the call channel is available; without this the
    // channel_enabled check hard-fails and masks the consent decision these
    // tests are actually about.
    const res = updateSettings(
      db,
      cfg,
      { eligible_channels: { call: true, whatsappMessage: false, whatsappCall: false, email: false, sms: false } },
      { userId: null, label: 'owner' },
    );
    if (res.rejected.length > 0) throw new Error(`setting rejected: ${JSON.stringify(res.rejected)}`);
  });
  after(() => db.close());

  test('calling window predicate honours days and hours', () => {
    // 2026-10-29 is a Thursday (day 4). Default window 09:00-18:00 Asia/Karachi.
    const w = { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5], offsetMinutes: 300 };
    assert.equal(inCallingWindow('2026-10-29T06:00:00.000Z', w), true); // 11:00 PKT Thu
    assert.equal(inCallingWindow('2026-10-29T02:00:00.000Z', w), false); // 07:00 PKT, too early
    assert.equal(inCallingWindow('2026-10-25T06:00:00.000Z', w), false); // Sunday, day off
  });

  test('nextAllowedSlot pushes an out-of-window time to the window start', () => {
    const w = { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5], offsetMinutes: 300 };
    // 02:00 UTC Thu = 07:00 PKT, before the window -> pushed to 09:00 PKT (04:00 UTC).
    const next = nextAllowedSlot('2026-10-29T02:00:00.000Z', w);
    assert.equal(inCallingWindow(next, w), true);
    assert.equal(new Date(next).toISOString(), '2026-10-29T04:00:00.000Z');
  });

  test('scheduling a follow-up inside the window keeps the time', () => {
    const id = makeLead();
    const t = scheduleFollowup(db, cfg, {
      businessId: id,
      type: 'callback',
      title: 'Call back about quote',
      scheduledFor: '2026-10-29T06:00:00.000Z', // Thu 11:00 PKT, inside window
    });
    assert.equal(t.status, 'scheduled');
    assert.equal(t.scheduledFor, '2026-10-29T06:00:00.000Z');
  });

  test('a duplicate active task at the same slot is a clean conflict', () => {
    const id = makeLead();
    const args = {
      businessId: id,
      type: 'callback' as const,
      title: 'Duplicate',
      scheduledFor: '2026-10-29T06:00:00.000Z',
    };
    scheduleFollowup(db, cfg, args);
    assert.throws(() => scheduleFollowup(db, cfg, args), /active follow-up/i);
  });

  test('scheduleSequence numbers tasks by offset order', () => {
    const id = makeLead();
    const tasks = scheduleSequence(db, cfg, {
      businessId: id,
      title: 'Nurture',
      offsetsDays: [2, 5, 10],
      startFrom: '2026-10-29T06:00:00.000Z',
    });
    assert.equal(tasks.length, 3);
    assert.deepEqual(tasks.map((t) => t.followupSequence), [1, 2, 3]);
    // strictly increasing scheduled times
    const times = tasks.map((t) => Date.parse(t.scheduledFor));
    assert.ok(times[0]! < times[1]! && times[1]! < times[2]!);
  });

  test('completing a task requires a customer-contact interaction', () => {
    const id = makeLead();
    const task = scheduleFollowup(db, cfg, {
      businessId: id,
      type: 'callback',
      title: 'Needs contact',
      scheduledFor: '2026-10-29T06:00:00.000Z',
    });
    markDue(db, task.id);

    const bookkeeping = recordInteraction(db, { businessId: id, kind: 'note', summary: 'internal note' });
    assert.throws(
      () => completeTask(db, { taskId: task.id, interactionId: bookkeeping.id, actor: owner }),
      /customer-contact/i,
    );

    const call = recordInteraction(db, { businessId: id, kind: 'call', summary: 'placed the call' });
    const done = completeTask(db, { taskId: task.id, interactionId: call.id, actor: owner });
    assert.equal(done.status, 'completed');
    assert.equal(done.completedInteractionId, call.id);
  });

  test('a completed task cannot be cancelled', () => {
    const id = makeLead();
    const task = scheduleFollowup(db, cfg, {
      businessId: id,
      type: 'callback',
      title: 'Cancel guard',
      scheduledFor: '2026-10-29T06:00:00.000Z',
    });
    const call = recordInteraction(db, { businessId: id, kind: 'call', summary: 'call' });
    completeTask(db, { taskId: task.id, interactionId: call.id, actor: owner });
    assert.throws(() => cancelTask(db, task.id, 'no longer needed'), /completed/i);
  });

  test('a suppression added AFTER scheduling blocks the due task', () => {
    const id = makeLead();
    const task = scheduleFollowup(db, cfg, {
      businessId: id,
      type: 'followup_call',
      title: 'Will be suppressed',
      channel: 'call',
      scheduledFor: '2026-10-29T06:00:00.000Z',
    });
    markDue(db, task.id);

    // Opt out after the task was scheduled.
    suppress(db, { businessId: id, scope: 'business', reason: 'opt_out', source: 'call', evidence: 'said stop' });

    const evals = evaluateDueTasks(db, cfg, '2026-10-30T00:00:00.000Z');
    const mine = evals.find((e) => e.taskId === task.id);
    assert.ok(mine);
    assert.equal(mine.decision, 'ineligible');

    const reloaded = listTasks(db, { businessId: id }).find((t) => t.id === task.id);
    assert.equal(reloaded?.status, 'blocked');
    assert.ok(reloaded?.blockedReason && /opt_out|ineligible/i.test(reloaded.blockedReason));
  });

  test('a due task with unconfirmed consent is flagged for review, NOT blocked', () => {
    const id = makeLead();
    const task = scheduleFollowup(db, cfg, {
      businessId: id,
      type: 'followup_call',
      title: 'Needs consent',
      channel: 'call',
      scheduledFor: '2026-10-29T06:00:00.000Z',
    });
    markDue(db, task.id);

    // No consent recorded -> needs_review. The task must stay pending so a
    // human can record consent; it must not be flipped to 'blocked'.
    const evals = evaluateDueTasks(db, cfg, '2026-10-30T00:00:00.000Z');
    const mine = evals.find((e) => e.taskId === task.id);
    assert.ok(mine);
    assert.equal(mine.decision, 'needs_review');
    assert.ok(mine.blockedReason && /needs_review/i.test(mine.blockedReason));

    const reloaded = listTasks(db, { businessId: id }).find((t) => t.id === task.id);
    assert.equal(reloaded?.status, 'due', 'review is a pause, not a cancellation of the pending work');
  });

  test('recording consent makes a flagged task eligible', () => {
    const id = makeLead();
    const task = scheduleFollowup(db, cfg, {
      businessId: id,
      type: 'followup_call',
      title: 'Consent then proceed',
      channel: 'call',
      scheduledFor: '2026-10-29T06:00:00.000Z',
    });
    markDue(db, task.id);
    const before = evaluateDueTasks(db, cfg, '2026-10-30T00:00:00.000Z').find((e) => e.taskId === task.id);
    assert.equal(before?.decision, 'needs_review');

    // Owner records explicit consent (an auditable interaction of kind 'consent').
    recordInteraction(db, { businessId: id, kind: 'consent', summary: 'agreed to be contacted' });

    const after = evaluateDueTasks(db, cfg, '2026-10-30T00:00:00.000Z').find((e) => e.taskId === task.id);
    assert.equal(after?.decision, 'eligible');
  });

  test('the calling window is read from the real calling_schedule setting', () => {
    const w = callingWindowFor(db, cfg, 'call');
    assert.equal(w.start, '09:00');
    assert.equal(w.end, '18:00');
    assert.deepEqual(w.days, [1, 2, 3, 4, 5]);
    assert.equal(w.offsetMinutes, 300); // Asia/Karachi is UTC+5, no DST
  });
});

describe('pipeline stage transitions', () => {
  before(() => {
    cfg = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'test'.padEnd(48, '0'), DATABASE_PATH: ':memory:' });
    db = openDatabase(':memory:');
    runMigrations(db);
  });
  after(() => db.close());

  test('a contact-gated stage is refused without real contact evidence', () => {
    const id = makeLead();
    assert.throws(
      () => advanceStage(db, cfg, {
        businessId: id,
        toStage: 'contacted',
        reason: 'manual move',
        interaction: { businessId: id, kind: 'note', summary: 'a note, not a contact' },
        actor: owner,
      }),
      /requires at least one real customer contact/i,
    );
  });

  test('advanceStage records the interaction, moves the stage and schedules cadence', () => {
    const id = makeLead();
    const res = advanceStage(db, cfg, {
      businessId: id,
      toStage: 'contacted',
      reason: 'first call placed',
      interaction: { businessId: id, kind: 'call', direction: 'outbound', summary: 'intro call' },
      actor: owner,
    });
    assert.equal(res.from, 'new_lead');
    assert.equal(res.to, 'contacted');
    assert.ok(res.interactionId);
    assert.equal(res.scheduled.length, 3, 'contacted cadence is 3 steps');

    const stage = db.prepare('SELECT stage FROM businesses WHERE id = ?').get(id) as { stage: string };
    assert.equal(stage.stage, 'contacted');
    assert.equal(interactionCounts(db, id).call, 1);
  });

  test('only the owner can confirm a conversion (won)', () => {
    const id = makeLead();
    advanceStage(db, cfg, {
      businessId: id,
      toStage: 'contacted',
      reason: 'call',
      interaction: { businessId: id, kind: 'call', summary: 'call' },
      actor: owner,
    });
    assert.throws(
      () => advanceStage(db, cfg, {
        businessId: id,
        toStage: 'won',
        reason: 'deal closed',
        interaction: { businessId: id, kind: 'meeting', summary: 'signing' },
        actor: staff,
      }),
      /only the owner can confirm a conversion/i,
    );
  });

  test('the owner can confirm a conversion, and it schedules no new cadence', () => {
    const id = makeLead();
    advanceStage(db, cfg, {
      businessId: id,
      toStage: 'contacted',
      reason: 'call',
      interaction: { businessId: id, kind: 'call', summary: 'call' },
      actor: owner,
    });
    const res = advanceStage(db, cfg, {
      businessId: id,
      toStage: 'won',
      reason: 'agreed on package',
      interaction: { businessId: id, kind: 'meeting', summary: 'signed' },
      actor: owner,
      autoSchedule: false,
    });
    assert.equal(res.to, 'won');
    assert.equal(res.scheduled.length, 0);
  });

  test('an existing evidence interaction id can back a move', () => {
    const id = makeLead();
    const call = recordInteraction(db, { businessId: id, kind: 'call', summary: 'earlier call' });
    const res = advanceStage(db, cfg, {
      businessId: id,
      toStage: 'contacted',
      reason: 'referencing earlier call',
      evidenceInteractionId: call.id,
      actor: owner,
    });
    assert.equal(res.interactionId, call.id);
  });
});
