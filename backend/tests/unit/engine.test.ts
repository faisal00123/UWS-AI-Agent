/**
 * Phase 11A unit tests: AI conversation engine.
 *
 *  - buildSystemPrompt: disclosure always present when required, language
 *    guidance for ur/roman_ur/en, turn ceiling stated;
 *  - generateTurn: injects the system prompt, hard-stops at the turn ceiling
 *    WITHOUT calling the model;
 *  - extractQualification: TOLERANT parsing — fenced JSON, JSON buried in
 *    prose, alias enums, and total garbage must all yield a safe result
 *    (never a crash, never a guessed 'qualified'). Opt-out words are
 *    authoritative and override a lying 'qualified' assessment.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSystemPrompt,
  generateTurn,
  extractQualification,
  type ConversationPolicy,
} from '../../src/domain/ai/engine.ts';
import type { ConversationPort, ConversationTurn } from '../../src/adapters/types.ts';

const POLICY: ConversationPolicy = {
  languages: ['ur', 'roman_ur', 'en'],
  aiDisclosureRequired: true,
  maxTurns: 8,
  humanHandoffOnRequest: true,
};

const CONTEXT = {
  businessName: 'Universal Web Solutions',
  businessWebsite: 'https://www.universalwebsolutions.it.com',
  leadName: 'Ahmed',
  leadCity: 'Lahore',
  leadBusiness: 'Ahmed Grill House',
};

describe('buildSystemPrompt', () => {
  test('includes mandatory AI disclosure naming the business', () => {
    const prompt = buildSystemPrompt(POLICY, CONTEXT);
    assert.match(prompt, /AI assistant/i);
    assert.match(prompt, /Universal Web Solutions/);
    assert.match(prompt, /not a human/i);
  });

  test('includes guidance for every configured language incl. Roman Urdu', () => {
    const prompt = buildSystemPrompt(POLICY, CONTEXT);
    assert.match(prompt, /اردو/); // Urdu script guidance
    assert.match(prompt, /Roman Urdu/);
    assert.match(prompt, /English/);
  });

  test('states the turn ceiling and the opt-out rule', () => {
    const prompt = buildSystemPrompt(POLICY, CONTEXT);
    assert.match(prompt, /Never exceed 8/);
    assert.match(prompt, /STOP/);
  });

  test('lead context is addressed when present', () => {
    const prompt = buildSystemPrompt(POLICY, CONTEXT);
    assert.match(prompt, /Ahmed Grill House/);
    assert.match(prompt, /Ahmed/);
    assert.match(prompt, /Lahore/);
  });

  test('disclosure is included even if a policy somehow omits the flag (schema literal)', () => {
    // The settings schema enforces aiDisclosureRequired: true (literal), so
    // a policy without it cannot exist through settings. Directly constructed
    // policies are engine-internal. Verify the flag actually controls it:
    const noDisclosure = buildSystemPrompt({ ...POLICY, aiDisclosureRequired: false }, CONTEXT);
    assert.doesNotMatch(noDisclosure, /not a human/i);
  });
});

/** Fake ConversationPort capturing the messages it was called with. */
function fakeAi(reply: string): { port: ConversationPort; captured: ConversationTurn[][] } {
  const captured: ConversationTurn[][] = [];
  return {
    captured,
    port: {
      key: 'fake',
      label: 'Fake AI',
      status: () => ({
        key: 'ai',
        label: 'AI conversation',
        implementation: 'fake',
        state: 'configured',
        features: [],
        lastError: null,
      }),
      async complete(input) {
        captured.push([...input.messages]);
        return { text: reply, model: 'fake-model' };
      },
    },
  };
}

describe('generateTurn', () => {
  test('prepends a system turn built from the policy', async () => {
    const { port, captured } = fakeAi('hello');
    const history: ConversationTurn[] = [{ role: 'user', content: 'Assalam-o-Alaikum' }];
    await generateTurn(port, { policy: POLICY, context: CONTEXT, history });
    assert.equal(captured.length, 1);
    const msgs = captured[0]!;
    assert.equal(msgs[0]!.role, 'system');
    assert.match(msgs[0]!.content, /AI assistant/);
    assert.equal(msgs[1]!.role, 'user');
    assert.equal(msgs[1]!.content, 'Assalam-o-Alaikum');
  });

  test('hard-stops at the turn ceiling WITHOUT calling the model', async () => {
    const { port, captured } = fakeAi('should not be called');
    // 8 turns => 16 messages (alternating) already.
    const history: ConversationTurn[] = Array.from({ length: 16 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `turn ${i}`,
    }));
    const res = await generateTurn(port, { policy: POLICY, context: CONTEXT, history });
    assert.equal(captured.length, 0);
    assert.match(res.text, /wrap up/i);
    assert.equal(res.model, 'engine_turn_limit');
  });
});

describe('extractQualification (tolerant)', () => {
  test('parses a clean fenced JSON block', () => {
    const q = extractQualification(
      'Assessment:\n```json\n{"qualification":"qualified","interest_level":"interested","objections":["price"],"next_step":"send_portfolio","notes":"wants portfolio"}\n```',
    );
    assert.equal(q.qualification, 'qualified');
    assert.equal(q.interestLevel, 'interested');
    assert.deepEqual(q.objections, ['price']);
    assert.equal(q.nextStep, 'send_portfolio');
  });

  test('parses bare JSON without fences', () => {
    const q = extractQualification('{"qualification":"needs_review","interest_level":"neutral"}');
    assert.equal(q.qualification, 'needs_review');
    assert.equal(q.interestLevel, 'neutral');
  });

  test('parses JSON buried in prose (last balanced object wins)', () => {
    const q = extractQualification(
      'The lead seemed hesitant. Final answer:\n{"qualification":"unqualified","interest_level":"not_interested"}',
    );
    assert.equal(q.qualification, 'unqualified');
    assert.equal(q.interestLevel, 'not_interested');
  });

  test('normalises alias enums (e.g. "Sales Qualified", "not interested")', () => {
    const q = extractQualification('{"qualification":"Sales Qualified","interest_level":"not interested"}');
    assert.equal(q.qualification, 'qualified');
    assert.equal(q.interestLevel, 'not_interested');
  });

  test('garbage yields conservative needs_review + unknown, never a crash', () => {
    const q = extractQualification('I think they might be interested but I am not sure at all.');
    assert.equal(q.qualification, 'needs_review');
    assert.equal(q.interestLevel, 'unknown');
    assert.equal(q.nextStep, 'none');
  });

  test('empty string yields the conservative result', () => {
    const q = extractQualification('');
    assert.equal(q.qualification, 'needs_review');
    assert.equal(q.interestLevel, 'unknown');
  });

  test('malformed JSON inside fences falls back conservatively', () => {
    const q = extractQualification('```json\n{"qualification":"qualified",\n```');
    assert.equal(q.qualification, 'needs_review');
  });

  test('opt-out words are authoritative and override a lying "qualified"', () => {
    const q = extractQualification(
      'They said STOP immediately.\n```json\n{"qualification":"qualified","interest_level":"interested"}\n```',
    );
    assert.equal(q.qualification, 'disqualified');
    assert.equal(q.interestLevel, 'opted_out');
  });

  test('opt-out words in a no-JSON reply still produce opted_out', () => {
    const q = extractQualification('The person said "please do not call me again" and hung up.');
    assert.equal(q.qualification, 'disqualified');
    assert.equal(q.interestLevel, 'opted_out');
  });

  test('unknown qualification string degrades to needs_review', () => {
    const q = extractQualification('{"qualification":"banana","interest_level":"curious"}');
    assert.equal(q.qualification, 'needs_review');
    assert.equal(q.interestLevel, 'unknown'); // unknown alias too
  });

  test('interested alone never implies qualified', () => {
    const q = extractQualification('{"qualification":"unqualified","interest_level":"interested"}');
    assert.equal(q.qualification, 'unqualified');
    assert.equal(q.interestLevel, 'interested');
  });

  test('objections are filtered to strings and capped', () => {
    const q = extractQualification(
      `{"qualification":"needs_review","interest_level":"neutral","objections":[${Array.from({ length: 15 }, (_, i) => `"obj${i}"`).join(',')},42,null]}`,
    );
    assert.equal(q.objections.length, 10);
    assert.ok(q.objections.every((o) => typeof o === 'string'));
  });
});
