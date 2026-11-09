/**
 * Pre-send WhatsApp template approval gate (cloud adapter) — READ-ONLY tests.
 *
 * The gate is a single GET against the WABA's `message_templates` edge. It
 * must return `ok: true` ONLY when the exact template exists, is APPROVED and
 * its language matches what we will send. Everything else — PENDING, REJECTED,
 * missing, language mismatch, a failing/absent verification request — must
 * return `ok: false` so the outreach service BLOCKS the send. No test can
 * reach a real provider: every fetch is injected.
 *
 * Covered (requirement): APPROVED · PENDING · REJECTED · missing ·
 * API failure (HTTP 500 and network throw) · language mismatch.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createWhatsAppCloudAdapter } from '../../src/adapters/whatsapp/cloud.ts';
import type { FetchLike } from '../../src/adapters/types.ts';

const WABA = '403489139520599';

interface FakeCall {
  url: string;
  init: RequestInit;
}

function fakeFetch(reply: { status?: number; body?: unknown; networkError?: boolean }): {
  fetchImpl: FetchLike;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url: String(url), init });
    if (reply.networkError) throw new TypeError('socket hang up');
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

function adapter(fetchImpl: FetchLike, businessAccountId: string | undefined = WABA) {
  return createWhatsAppCloudAdapter({
    phoneNumberId: '123456',
    accessToken: 'unit-test-token',
    appSecret: 'unit-test-secret',
    ...(businessAccountId === undefined ? {} : { businessAccountId }),
    fetchImpl,
  });
}

function approvedList(language = 'en_US'): unknown {
  return { data: [{ name: 'portfolio_intro', status: 'APPROVED', language }] };
}

describe('pre-send template approval gate (whatsapp cloud verifyTemplate)', () => {
  test('APPROVED + matching language -> ok, via a read-only GET with the token only in the header', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: approvedList() });
    const result = await adapter(fetchImpl).verifyTemplate!('portfolio_intro', 'en_US');

    assert.equal(result.ok, true);
    assert.equal(result.status, 'APPROVED');
    assert.match(result.detail, /APPROVED in en_US/);

    // Exactly one call: a GET to the CORRECT WABA's message_templates edge.
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(String(call.init.method ?? '').toUpperCase(), 'GET');
    assert.ok(call.url.includes(`/v20.0/${WABA}/message_templates`), call.url);
    assert.ok(call.url.includes('fields=name,status,language'), 'explicit fields only');
    // The credential travels in the Authorization header, never in the URL.
    const headers = call.init.headers as Record<string, string> | undefined;
    assert.ok(headers?.authorization?.startsWith('Bearer '), 'token in header');
    assert.ok(!call.url.includes('unit-test-token'), 'token must not leak into the URL');
  });

  test('PENDING -> blocked (ok:false, status PENDING)', async () => {
    const { fetchImpl } = fakeFetch({
      body: { data: [{ name: 'portfolio_intro', status: 'PENDING', language: 'en_US' }] },
    });
    const result = await adapter(fetchImpl).verifyTemplate!('portfolio_intro', 'en_US');
    assert.equal(result.ok, false);
    assert.equal(result.status, 'PENDING');
    assert.match(result.detail, /not APPROVED/);
  });

  test('REJECTED -> blocked (ok:false, status REJECTED)', async () => {
    const { fetchImpl } = fakeFetch({
      body: { data: [{ name: 'portfolio_intro', status: 'REJECTED', language: 'en_US' }] },
    });
    const result = await adapter(fetchImpl).verifyTemplate!('portfolio_intro', 'en_US');
    assert.equal(result.ok, false);
    assert.equal(result.status, 'REJECTED');
    assert.match(result.detail, /not APPROVED/);
  });

  test('missing template (absent from the list) -> blocked (ok:false, status MISSING)', async () => {
    // Empty list and a list with only other templates both mean "missing".
    const empty = fakeFetch({ body: { data: [] } });
    const r1 = await adapter(empty.fetchImpl).verifyTemplate!('portfolio_intro', 'en_US');
    assert.equal(r1.ok, false);
    assert.equal(r1.status, 'MISSING');
    assert.match(r1.detail, /not present/);

    const other = fakeFetch({ body: { data: [{ name: 'something_else', status: 'APPROVED', language: 'en_US' }] } });
    const r2 = await adapter(other.fetchImpl).verifyTemplate!('portfolio_intro', 'en_US');
    assert.equal(r2.ok, false);
    assert.equal(r2.status, 'MISSING');
  });

  test('API failure (HTTP 500 and network throw) -> blocked (ok:false, status UNVERIFIABLE)', async () => {
    const httpFail = fakeFetch({ status: 500, body: { error: { message: 'boom' } } });
    const r1 = await adapter(httpFail.fetchImpl).verifyTemplate!('portfolio_intro', 'en_US');
    assert.equal(r1.ok, false);
    assert.equal(r1.status, 'UNVERIFIABLE');
    assert.match(r1.detail, /approval check failed/i);

    const netFail = fakeFetch({ networkError: true });
    const r2 = await adapter(netFail.fetchImpl).verifyTemplate!('portfolio_intro', 'en_US');
    assert.equal(r2.ok, false);
    assert.equal(r2.status, 'UNVERIFIABLE');
    assert.match(r2.detail, /approval check failed/i);

    // No credentials may ever surface in a failure detail.
    assert.ok(!r1.detail.includes('unit-test-token'));
    assert.ok(!r2.detail.includes('unit-test-token'));
  });

  test('language mismatch (APPROVED but not en_US) -> blocked (ok:false, status LANGUAGE_MISMATCH)', async () => {
    const { fetchImpl } = fakeFetch({ body: approvedList('fr_FR') });
    const result = await adapter(fetchImpl).verifyTemplate!('portfolio_intro', 'en_US');
    assert.equal(result.ok, false);
    assert.equal(result.status, 'LANGUAGE_MISMATCH');
    assert.match(result.detail, /fr_FR/);
    assert.match(result.detail, /en_US/);
  });

  test('missing WABA id -> blocked (ok:false, status UNVERIFIABLE), no network call', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: approvedList() });
    const result = await adapter(fetchImpl, '').verifyTemplate!('portfolio_intro', 'en_US');
    assert.equal(result.ok, false);
    assert.equal(result.status, 'UNVERIFIABLE');
    assert.match(result.detail, /WHATSAPP_BUSINESS_ACCOUNT_ID/);
    assert.equal(calls.length, 0, 'no request may be attempted without a WABA id');
  });

  test('blank template name or language -> blocked (ok:false, status UNVERIFIABLE)', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: approvedList() });
    const r1 = await adapter(fetchImpl).verifyTemplate!('  ', 'en_US');
    const r2 = await adapter(fetchImpl).verifyTemplate!('portfolio_intro', '');
    assert.equal(r1.ok, false);
    assert.equal(r1.status, 'UNVERIFIABLE');
    assert.equal(r2.ok, false);
    assert.equal(r2.status, 'UNVERIFIABLE');
    assert.equal(calls.length, 0, 'no request for a blank name/language');
  });
});
