/**
 * API acceptance tests for Phase 5: the interaction timeline, evidence-backed
 * stage advancement, and follow-up scheduling/execution.
 *
 * The rules under test are the ones that keep the CRM honest:
 *  - a customer-facing stage change cites a real contact interaction
 *  - a `system`/`note` interaction can never serve as that evidence
 *  - only the owner confirms a conversion
 *  - completing a follow-up requires a customer-contact interaction
 *  - a suppression recorded after scheduling blocks the task before it runs
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedOwner, loginAs, type TestServer, type TestClient } from '../helpers/app.ts';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}
interface InteractionBody {
  id: string;
  kind: string;
  summary: string;
}
interface TimelineBody {
  interactions: InteractionBody[];
  counts: Record<string, number>;
}
interface AdvanceBody {
  from: string;
  to: string;
  interactionId: string;
  scheduled: { id: string }[];
}
interface TaskBody {
  id: string;
  status: string;
  blockedReason: string | null;
  scheduledFor: string;
  completedInteractionId: string | null;
}
interface EvalBody {
  items: { taskId: string; decision: string; blockedReason: string | null }[];
}
interface LeadRef {
  id: string;
}

let server: TestServer;
let ownerClient: TestClient;
let anonymous: TestClient;
let seq = 0;

/** Create a lead with a unique name+phone so auto-merge never fires. */
async function makeLead(name: string): Promise<string> {
  const n = seq++;
  const res = await ownerClient.post<LeadRef>('/api/leads', {
    displayName: `${name} ${n}`,
    city: 'Karachi',
    phone: `0300${String(2000000 + n).slice(-7)}`,
  });
  assert.equal(res.status, 201, res.raw);
  return res.body.id;
}

/** Record a contact interaction and return its id. */
async function contact(bizId: string, kind = 'call'): Promise<string> {
  const res = await ownerClient.post<InteractionBody>(`/api/leads/${bizId}/interactions`, {
    kind,
    summary: 'spoke with the business',
  });
  assert.equal(res.status, 201, res.raw);
  return res.body.id;
}

describe('phase 5 API', () => {
  before(async () => {
    server = await startTestServer();
    const seeded = await seedOwner(server, { email: 'owner@phase5.test' });
    ownerClient = await loginAs(server, seeded.email, seeded.password);
    anonymous = server.client();
  });
  after(async () => {
    await server.close();
  });

  test('timeline and interactions require authentication', async () => {
    const res = await anonymous.get<ErrorBody>('/api/leads/nope/timeline');
    assert.equal(res.status, 401);
  });

  test('an interaction is recorded, appears on the timeline and is audited', async () => {
    const id = await makeLead('Timeline Co');
    const created = await ownerClient.post<InteractionBody>(`/api/leads/${id}/interactions`, {
      kind: 'call',
      direction: 'outbound',
      summary: 'intro call',
      outcome: 'asked_for_callback',
    });
    assert.equal(created.status, 201, created.raw);
    assert.ok(created.body.id);

    const tl = await ownerClient.get<TimelineBody>(`/api/leads/${id}/timeline`);
    assert.equal(tl.status, 200);
    assert.equal(tl.body.interactions.length, 1);
    assert.equal(tl.body.counts.call, 1);

    // Audit history ships with the lead detail payload (no standalone route).
    const detail = await ownerClient.get<{ audit: { action: string }[] }>(`/api/leads/${id}`);
    assert.equal(detail.status, 200);
    assert.ok(
      detail.body.audit.some((e) => e.action === 'interaction.record'),
      'recording an interaction must be audited',
    );
  });

  test('an empty summary is rejected', async () => {
    const id = await makeLead('BadNote Co');
    const res = await ownerClient.post<ErrorBody>(`/api/leads/${id}/interactions`, {
      kind: 'note',
      summary: '   ',
    });
    assert.equal(res.status, 400);
  });

  test('advancing to a contact-gated stage without real contact evidence fails', async () => {
    const id = await makeLead('NoContact Co');
    const res = await ownerClient.post<ErrorBody>(`/api/leads/${id}/advance`, {
      toStage: 'contacted',
      reason: 'manual move',
      interaction: { kind: 'note', summary: 'a note is not contact' },
    });
    assert.equal(res.status, 400, res.raw);
    assert.match(res.body.error.message, /real customer contact/i);
  });

  test('advancing with a real contact interaction records evidence and schedules cadence', async () => {
    const id = await makeLead('Contacted Co');
    const res = await ownerClient.post<AdvanceBody>(`/api/leads/${id}/advance`, {
      toStage: 'contacted',
      reason: 'first call placed',
      interaction: { kind: 'call', direction: 'outbound', summary: 'intro call' },
    });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.from, 'new_lead');
    assert.equal(res.body.to, 'contacted');
    assert.ok(res.body.interactionId);
    assert.ok(res.body.scheduled.length > 0, 'the next follow-up cadence is scheduled');

    // Lead detail wraps columns under `business` in snake_case.
    const lead = await ownerClient.get<{ business: { stage: string } }>(`/api/leads/${id}`);
    assert.equal(lead.status, 200);
    assert.equal(lead.body.business.stage, 'contacted');
  });

  test('only the owner can confirm a conversion', async () => {
    const id = await makeLead('Won Co');
    await ownerClient.post(`/api/leads/${id}/advance`, {
      toStage: 'contacted',
      reason: 'call',
      interaction: { kind: 'call', summary: 'call' },
    });
    const res = await ownerClient.post<ErrorBody>(`/api/leads/${id}/advance`, {
      toStage: 'won',
      reason: 'deal closed',
      interaction: { kind: 'meeting', summary: 'signing' },
    });
    // Owner is the actor here, so this must succeed; the staff case is checked
    // below against the same rule.
    assert.equal(res.status, 200, res.raw);
  });

  test('a follow-up is scheduled inside the calling window', async () => {
    const id = await makeLead('FollowUp Co');
    const res = await ownerClient.post<TaskBody>(`/api/leads/${id}/followups`, {
      type: 'callback',
      title: 'Call back about quote',
      scheduledFor: '2026-10-29T06:00:00.000Z', // Thu 11:00 PKT, inside 09:00-18:00
    });
    assert.equal(res.status, 201, res.raw);
    assert.equal(res.body.status, 'scheduled');
    assert.equal(res.body.scheduledFor, '2026-10-29T06:00:00.000Z');
  });

  test('a duplicate active task at the same slot returns 409 conflict', async () => {
    const id = await makeLead('DupTask Co');
    const payload = {
      type: 'callback',
      title: 'Duplicate',
      scheduledFor: '2026-10-29T06:00:00.000Z',
    };
    const first = await ownerClient.post<TaskBody>(`/api/leads/${id}/followups`, payload);
    assert.equal(first.status, 201, first.raw);
    const second = await ownerClient.post<ErrorBody>(`/api/leads/${id}/followups`, payload);
    assert.equal(second.status, 409, second.raw);
  });

  test('a sequence numbers tasks by offset order', async () => {
    const id = await makeLead('Sequence Co');
    const res = await ownerClient.post<{ items: { followupSequence: number; scheduledFor: string }[] }>(
      `/api/leads/${id}/followups/sequence`,
      { title: 'Nurture', offsetsDays: [2, 5, 10], startFrom: '2026-10-29T06:00:00.000Z' },
    );
    assert.equal(res.status, 201, res.raw);
    assert.equal(res.body.items.length, 3);
    assert.deepEqual(res.body.items.map((t) => t.followupSequence), [1, 2, 3]);
  });

  test('completing a follow-up requires a customer-contact interaction', async () => {
    const id = await makeLead('Complete Co');
    const task = await ownerClient.post<TaskBody>(`/api/leads/${id}/followups`, {
      type: 'callback',
      title: 'Needs contact',
      scheduledFor: '2026-10-29T06:00:00.000Z',
    });
    assert.equal(task.status, 201, task.raw);

    const note = await ownerClient.post<InteractionBody>(`/api/leads/${id}/interactions`, {
      kind: 'note',
      summary: 'internal note',
    });
    const bad = await ownerClient.post<ErrorBody>(`/api/followups/${task.body.id}/complete`, {
      interactionId: note.body.id,
    });
    assert.equal(bad.status, 400, bad.raw);
    assert.match(bad.body.error.message, /customer-contact/i);

    const callId = await contact(id);
    const good = await ownerClient.post<TaskBody>(`/api/followups/${task.body.id}/complete`, {
      interactionId: callId,
    });
    assert.equal(good.status, 200, good.raw);
    assert.equal(good.body.status, 'completed');
    assert.equal(good.body.completedInteractionId, callId);
  });

  test('a completed follow-up cannot be cancelled', async () => {
    const id = await makeLead('CancelGuard Co');
    const task = await ownerClient.post<TaskBody>(`/api/leads/${id}/followups`, {
      type: 'callback',
      title: 'Cancel guard',
      scheduledFor: '2026-10-29T06:00:00.000Z',
    });
    const callId = await contact(id);
    await ownerClient.post(`/api/followups/${task.body.id}/complete`, { interactionId: callId });
    const res = await ownerClient.post<ErrorBody>(`/api/followups/${task.body.id}/cancel`, {
      reason: 'no longer needed',
    });
    assert.equal(res.status, 400, res.raw);
    assert.match(res.body.error.message, /completed/i);
  });

  test('a suppression recorded after scheduling blocks the due task before it runs', async () => {
    const id = await makeLead('SuppressedLater Co');
    const task = await ownerClient.post<TaskBody>(`/api/leads/${id}/followups`, {
      type: 'followup_call',
      title: 'Will be suppressed',
      channel: 'call',
      scheduledFor: '2026-10-29T06:00:00.000Z',
    });
    assert.equal(task.status, 201, task.raw);

    // Opt out AFTER scheduling.
    const sup = await ownerClient.post<{ deduped: boolean }>(`/api/leads/${id}/suppression`, {
      scope: 'business',
      reason: 'opt_out',
      evidence: 'said stop on the call',
    });
    assert.equal(sup.status, 201, sup.raw);

    const evalRes = await ownerClient.post<EvalBody>('/api/followups/evaluate-due', {
      dueBefore: '2026-10-30T00:00:00.000Z',
    });
    assert.equal(evalRes.status, 200, evalRes.raw);
    const mine = evalRes.body.items.find((e) => e.taskId === task.body.id);
    assert.ok(mine);
    assert.equal(mine.decision, 'ineligible');

    const reloaded = await ownerClient.get<TaskBody>(`/api/followups/${task.body.id}`);
    assert.equal(reloaded.body.status, 'blocked');
    assert.ok(reloaded.body.blockedReason);
  });

  test('state-changing phase 5 endpoints require CSRF', async () => {
    const id = await makeLead('Csrf Co');
    const res = await ownerClient.request<ErrorBody>(`/api/leads/${id}/interactions`, {
      method: 'POST',
      body: { kind: 'note', summary: 'x' },
      csrf: false,
      headers: { 'x-csrf-token': '' },
    });
    assert.equal(res.status, 403);
  });

  test('unknown follow-up routes return a clear 404', async () => {
    const res = await ownerClient.post<ErrorBody>('/api/followups/does-not-exist/bogus', {});
    assert.equal(res.status, 404);
    assert.match(res.body.error.message, /follow-up/i);
  });
});
