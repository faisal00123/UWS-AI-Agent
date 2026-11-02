/**
 * Duplex bridge unit tests: stream access token and answer TwiML.
 *
 * The WebSocket upgrade cannot carry a Twilio signature header, so access is
 * gated by a signed, expiring token minted by the answer URL. Its rules are
 * pinned here (bound to the CallSid, time-limited, tamper-proof), together
 * with the TwiML shape: disclosure first, stream second, never <Record/>.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_DISCLOSURE,
  duplexAnswerTwiml,
  GREETING_HANGUP,
  mintStreamToken,
  streamWsUrl,
  verifyStreamToken,
} from '../../src/domain/media/duplex.ts';

const SECRET = 'session-secret-for-duplex-tests-'.padEnd(48, 'x');
const CALL = 'CA11111111111111111111111111111111';

describe('stream token', () => {
  test('a freshly minted token verifies for its own call', () => {
    const token = mintStreamToken(SECRET, CALL, 1_000_000);
    assert.equal(verifyStreamToken(SECRET, CALL, token, 1_000_000), true);
  });

  test('the token is bound to one call', () => {
    const token = mintStreamToken(SECRET, CALL, 1_000_000);
    assert.equal(verifyStreamToken(SECRET, 'CA00000000000000000000000000000000', token, 1_000_000), false);
  });

  test('the token expires', () => {
    const token = mintStreamToken(SECRET, CALL, 1_000_000);
    assert.equal(verifyStreamToken(SECRET, CALL, token, 1_000_000 + 5 * 60_000 + 1), false, 'past the TTL');
    assert.equal(verifyStreamToken(SECRET, CALL, token, 1_000_000 + 60_000), true, 'still inside the TTL');
  });

  test('tampering with signature or expiry fails', () => {
    const token = mintStreamToken(SECRET, CALL, 1_000_000);
    const [expiry, sig] = token.split('.') as [string, string];
    assert.equal(verifyStreamToken(SECRET, CALL, `${expiry}.${sig.slice(0, -1)}x`, 1_000_000), false);
    const later = String(Number(expiry) + 60_000);
    assert.equal(verifyStreamToken(SECRET, CALL, `${later}.${sig}`, 1_000_000), false, 'expiry is inside the MAC');
    assert.equal(verifyStreamToken(SECRET, CALL, 'garbage', 1_000_000), false);
    assert.equal(verifyStreamToken(SECRET, CALL, '', 1_000_000), false);
    assert.equal(verifyStreamToken(SECRET, CALL, `notanumber.${sig}`, 1_000_000), false);
  });

  test('a different session secret cannot mint a usable token', () => {
    const token = mintStreamToken(SECRET, CALL, 1_000_000);
    assert.equal(verifyStreamToken(`${SECRET}other`, CALL, token, 1_000_000), false);
  });
});

describe('stream url', () => {
  test('https becomes wss and carries both parameters', () => {
    const url = streamWsUrl('https://agent.example.com', CALL, '999.abc');
    assert.ok(url.startsWith('wss://agent.example.com/api/media?'), url);
    assert.ok(url.includes(`callSid=${CALL}`));
    assert.ok(url.includes('token=999.abc'));
  });

  test('http stays ws for local development', () => {
    assert.ok(streamWsUrl('http://localhost:3100', CALL, 't').startsWith('ws://localhost:3100/api/media?'));
  });

  test('trailing slashes on the base url do not double up', () => {
    assert.equal(streamWsUrl('https://agent.example.com/', CALL, 't').startsWith('wss://agent.example.com/api'), true);
  });
});

describe('duplex answer TwiML', () => {
  const twiml = duplexAnswerTwiml('wss://agent.example.com/api/media?callSid=CA1&token=999.aa');

  test('opens the media stream right after the mandated disclosure', () => {
    assert.ok(twiml.includes('<Response>'));
    assert.ok(twiml.indexOf('artificial intelligence') < twiml.indexOf('<Connect>'), 'disclosure is spoken first');
    assert.ok(twiml.includes(AI_DISCLOSURE.slice(0, 40)), 'the approved wording is used verbatim');
    assert.ok(twiml.includes('<Connect><Stream url="wss://agent.example.com/api/media?callSid=CA1&amp;token=999.aa"'));
    assert.ok(twiml.includes('</Connect>'));
    assert.ok(twiml.includes('<Hangup/>'), 'the call hangs up when the stream ends');
  });

  test('only the caller audio track is streamed in', () => {
    assert.ok(twiml.includes('track="inbound_track"'));
    assert.ok(twiml.includes('codec="PCMU"'));
    assert.ok(twiml.includes('sampleRate="8000"'));
  });

  test('recording is never requested', () => {
    assert.ok(!twiml.includes('<Record'), 'recording needs explicit consent');
    assert.ok(!twiml.includes('statusCallback'), 'the bridge does not create provider callbacks here');
  });

  test('the fixed fallback greeting still hangs up with the disclosure', () => {
    assert.ok(GREETING_HANGUP.includes('artificial intelligence'));
    assert.ok(GREETING_HANGUP.includes('Goodbye'));
    assert.ok(AI_DISCLOSURE.includes('I am an AI'));
  });
});
