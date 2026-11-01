/**
 * Phase 7 unit tests: provider adapters.
 *
 * Every adapter here is exercised through an INJECTED fetch, so these tests
 * verify the real request construction (URL, auth header, body shape) and the
 * real error mapping without any network access — a unit test cannot reach a
 * real provider by accident. The SMTP adapter talks to a fake loopback server
 * (node:net, no TLS) because the SMTP dialogue is socket-based, not HTTP.
 *
 * Safety properties under test:
 *  - credentials never appear in thrown error messages
 *  - plaintext SMTP is refused for non-loopback hosts
 *  - signature verification is exact: tampered bodies/signatures fail
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import net from 'node:net';
import { AdapterError, type FetchLike } from '../../src/adapters/types.ts';
import { createTwilioAdapter, validateTwilioSignature } from '../../src/adapters/telephony/twilio.ts';
import { createWhatsAppCloudAdapter } from '../../src/adapters/whatsapp/cloud.ts';
import { createOpenAIConversationAdapter } from '../../src/adapters/ai/openai.ts';
import { createOpenAISpeechAdapter, multipart } from '../../src/adapters/speech/openai.ts';
import { createSmtpAdapter } from '../../src/adapters/email/smtp.ts';

/** Capturing fake fetch: records every call, replies with a canned response. */
function fakeFetch(
  reply: { status?: number; body?: unknown; headers?: Record<string, string> },
): { fetchImpl: FetchLike; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: reply.headers ?? { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

function authHeader(init: RequestInit): string {
  const h = (init.headers ?? {}) as Record<string, string>;
  return h['authorization'] ?? '';
}

describe('twilio adapter', () => {
  test('createCall posts the documented form-encoded request with basic auth', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: { sid: 'CA123', status: 'queued' } });
    const twilio = createTwilioAdapter({
      accountSid: 'ACtest',
      authToken: 'secret-token',
      fromNumber: '+922111111111',
      fetchImpl,
    });

    const res = await twilio.createCall({
      to: '+923001234567',
      answerUrl: 'https://uws.example/api/webhooks/telephony/twilio/voice',
      statusCallbackUrl: 'https://uws.example/api/webhooks/telephony/twilio',
      metadata: { businessId: 'biz1', attemptId: 'att1' },
    });

    assert.equal(res.providerCallId, 'CA123');
    assert.equal(res.status, 'queued');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Calls.json');
    assert.equal(authHeader(calls[0]!.init), `Basic ${Buffer.from('ACtest:secret-token').toString('base64')}`);
    const body = new URLSearchParams(String(calls[0]!.init.body));
    assert.equal(body.get('To'), '+923001234567');
    assert.equal(body.get('From'), '+922111111111');
    assert.equal(body.get('Url'), 'https://uws.example/api/webhooks/telephony/twilio/voice');
    assert.equal(body.get('StatusCallback'), 'https://uws.example/api/webhooks/telephony/twilio');
    assert.equal(body.get('businessId'), 'biz1');
    assert.equal(body.get('attemptId'), 'att1');
  });

  test('provider auth failures map to provider_error and never leak the token', async () => {
    const { fetchImpl } = fakeFetch({ status: 401, body: { message: 'Authenticate', code: 20003 } });
    const twilio = createTwilioAdapter({ accountSid: 'ACtest', authToken: 'secret-token', fromNumber: '+1', fetchImpl });
    await assert.rejects(
      () => twilio.createCall({ to: '+1', answerUrl: 'https://x/voice', statusCallbackUrl: 'https://x/cb', metadata: { businessId: 'b', attemptId: 'a' } }),
      (err: unknown) => {
        assert.ok(err instanceof AdapterError);
        assert.equal(err.code, 'provider_error');
        assert.ok(!err.message.includes('secret-token'), 'error text must never contain the auth token');
        return true;
      },
    );
  });

  test('invalid-destination codes map to invalid_destination; 429 is retryable', async () => {
    const badNumber = fakeFetch({ status: 400, body: { code: 21211, message: 'The To number is not a valid phone number' } });
    const twilio = createTwilioAdapter({ accountSid: 'AC', authToken: 't', fromNumber: '+1', fetchImpl: badNumber.fetchImpl });
    await assert.rejects(
      () => twilio.createCall({ to: 'x', answerUrl: 'https://x/v', statusCallbackUrl: 'https://x/c', metadata: { businessId: 'b', attemptId: 'a' } }),
      (err: unknown) => err instanceof AdapterError && err.code === 'invalid_destination',
    );

    const limited = fakeFetch({ status: 429, body: { message: 'rate limited' } });
    const twilio2 = createTwilioAdapter({ accountSid: 'AC', authToken: 't', fromNumber: '+1', fetchImpl: limited.fetchImpl });
    await assert.rejects(
      () => twilio2.createCall({ to: 'x', answerUrl: 'https://x/v', statusCallbackUrl: 'https://x/c', metadata: { businessId: 'b', attemptId: 'a' } }),
      (err: unknown) => err instanceof AdapterError && err.code === 'rate_limited' && err.retryable === true,
    );
  });

  test('signature validation is exact: valid passes, tampered fails', () => {
    const token = 'twilio-auth-token';
    const url = 'https://uws.example/api/webhooks/telephony/twilio';
    const params: Record<string, string> = { CallSid: 'CA1', CallStatus: 'completed', Timestamp: '1730000000' };
    const concat = Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join('');
    const sig = createHmac('sha1', token).update(url + concat).digest('base64');

    assert.equal(validateTwilioSignature(token, url, params, sig), true);
    assert.equal(validateTwilioSignature(token, url, { ...params, CallStatus: 'busy' }, sig), false, 'param tampering must fail');
    assert.equal(validateTwilioSignature(token, `${url}/other`, params, sig), false, 'URL tampering must fail');
    assert.equal(validateTwilioSignature(token, url, params, null), false, 'missing signature must fail');
    assert.equal(validateTwilioSignature('', url, params, sig), false, 'no configured token must fail');
  });

  test('status reports unconfigured when credentials are absent', () => {
    const twilio = createTwilioAdapter({ accountSid: '', authToken: '', fromNumber: '' });
    assert.equal(twilio.status().state, 'unconfigured');
  });
});

describe('whatsapp cloud adapter', () => {
  test('sendTemplate posts the documented template payload with a bearer token', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: { messages: [{ id: 'wamid.1' }] } });
    const wa = createWhatsAppCloudAdapter({
      phoneNumberId: '12345',
      accessToken: 'wa-token',
      appSecret: 'app-secret',
      fetchImpl,
    });

    const res = await wa.sendTemplate({
      to: '+923001234567',
      templateName: 'portfolio_v1',
      languageCode: 'en',
      bodyParams: ['Acme Traders'],
    });

    assert.equal(res.providerMessageId, 'wamid.1');
    assert.equal(calls[0]!.url, 'https://graph.facebook.com/v20.0/12345/messages');
    assert.equal(authHeader(calls[0]!.init), 'Bearer wa-token');
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    assert.equal(body['messaging_product'], 'whatsapp');
    assert.equal(body['to'], '+923001234567');
    assert.equal(body['type'], 'template');
    const tpl = body['template'] as { name: string; language: { code: string }; components: { parameters: { text: string }[] }[] };
    assert.equal(tpl.name, 'portfolio_v1');
    assert.equal(tpl.language.code, 'en');
    assert.equal(tpl.components[0]!.parameters[0]!.text, 'Acme Traders');
  });

  test('an empty template name refuses with unconfigured (Meta requires approval)', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: { messages: [{ id: 'x' }] } });
    const wa = createWhatsAppCloudAdapter({ phoneNumberId: '1', accessToken: 't', appSecret: 's', fetchImpl });
    await assert.rejects(
      () => wa.sendTemplate({ to: '+1', templateName: '  ', languageCode: 'en' }),
      (err: unknown) => err instanceof AdapterError && err.code === 'unconfigured',
    );
    assert.equal(calls.length, 0, 'nothing may be sent without an approved template');
  });

  test('X-Hub-Signature-256 verification is over the exact raw bytes', () => {
    const wa = createWhatsAppCloudAdapter({ phoneNumberId: '1', accessToken: 't', appSecret: 'app-secret' });
    const raw = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: {} }] }] }));
    const sig = `sha256=${createHmac('sha256', 'app-secret').update(raw).digest('hex')}`;

    assert.equal(wa.verifySignature(raw, sig), true);
    assert.equal(wa.verifySignature(Buffer.concat([raw, Buffer.from(' ')]), sig), false, 're-serialized body must fail');
    assert.equal(wa.verifySignature(raw, sig.replace('a', 'b')), false, 'tampered signature must fail');
    assert.equal(wa.verifySignature(raw, null), false);
    const noSecret = createWhatsAppCloudAdapter({ phoneNumberId: '1', accessToken: 't', appSecret: '' });
    assert.equal(noSecret.verifySignature(raw, sig), false, 'without an app secret, webhooks are refused');
  });
});

describe('openai-compatible adapters', () => {
  test('conversation completion posts model + messages and returns the text', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: { choices: [{ message: { content: 'Hello there' } }], model: 'test-model-1' } });
    const ai = createOpenAIConversationAdapter({ apiKey: 'ai-key', model: 'test-model-1', fetchImpl });
    const res = await ai.complete({ messages: [{ role: 'system', content: 'disclose you are an AI' }] });
    assert.equal(res.text, 'Hello there');
    assert.equal(calls[0]!.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(authHeader(calls[0]!.init), 'Bearer ai-key');
    const body = JSON.parse(String(calls[0]!.init.body)) as { model: string; messages: { role: string }[] };
    assert.equal(body.model, 'test-model-1');
    assert.equal(body.messages[0]!.role, 'system');
  });

  test('speech transcribe sends the audio bytes unmodified inside multipart', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: { text: 'transcribed words' } });
    const speech = createOpenAISpeechAdapter({ apiKey: 'stt-key', fetchImpl });
    const audio = new Uint8Array([0x1a, 0x2b, 0xff, 0x00, 0x7f, 0x03]);
    const res = await speech.transcribe({ audio, mimeType: 'audio/ogg', filename: 'call.ogg' });
    assert.equal(res.text, 'transcribed words');
    assert.equal(calls[0]!.url, 'https://api.openai.com/v1/audio/transcriptions');
    const sent = Buffer.from(calls[0]!.init.body as Uint8Array);
    // The exact audio byte sequence must survive the multipart encoding.
    assert.ok(sent.includes(Buffer.from(audio)), 'audio bytes must pass through unmodified');
    assert.ok(sent.toString('latin1').includes('name="model"'));
    assert.ok(sent.toString('latin1').includes('whisper-1'));
  });

  test('multipart encodes fields and file with a boundary', () => {
    const mp = multipart({ model: 'm1' }, { field: 'file', filename: 'a.wav', contentType: 'audio/wav', data: Uint8Array.from([1, 2, 3]) });
    const text = mp.body.toString('latin1');
    assert.ok(mp.contentType.startsWith('multipart/form-data; boundary='));
    assert.ok(text.includes('name="model"'));
    assert.ok(text.includes('filename="a.wav"'));
    assert.ok(text.includes('Content-Type: audio/wav'));
  });

  test('unconfigured adapters refuse loudly instead of returning silence', async () => {
    const ai = createOpenAIConversationAdapter({ apiKey: '', model: '' });
    assert.equal(ai.status().state, 'unconfigured');
    const speech = createOpenAISpeechAdapter({ apiKey: '' });
    assert.equal(speech.status().state, 'unconfigured');
    await assert.rejects(
      () => speech.transcribe({ audio: new Uint8Array([1]) }),
      (err: unknown) => err instanceof AdapterError && err.code === 'unconfigured',
    );
  });
});

describe('smtp adapter', () => {
  interface FakeSmtp {
    port: number;
    close(): Promise<void>;
    transcript: string[];
    authSeen: { user: string; pass: string };
  }

  /** Minimal SMTP dialogue server on loopback (no TLS) for the client to talk to. */
  function startFakeSmtp(): Promise<FakeSmtp> {
    const transcript: string[] = [];
    const authSeen = { user: '', pass: '' };
    let authStep = 0;
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        socket.on('error', () => {
          /* the client may reset on teardown; that is not a test failure */
        });
        socket.write('220 fake.local ESMTP\r\n');
        let inData = false;
        let dataBuf = '';
        socket.on('data', (chunk) => {
          const text = chunk.toString('utf8');
          transcript.push(text);
          if (inData) {
            // Accumulate: the "\r\n.\r\n" terminator can straddle chunks.
            dataBuf += text;
            if (dataBuf.includes('\r\n.\r\n')) {
              inData = false;
              dataBuf = '';
              socket.write('250 2.0.0 Ok: queued as FAKE123\r\n');
            }
            return;
          }
          const line = text.trim();
          if (line.startsWith('EHLO')) socket.write('250-fake.local\r\n250 AUTH LOGIN\r\n');
          else if (line === 'AUTH LOGIN') {
            authStep = 1;
            socket.write('334 VXNlcm5hbWU6\r\n');
          } else if (authStep === 1) {
            authSeen.user = Buffer.from(line, 'base64').toString('utf8');
            authStep = 2;
            socket.write('334 UGFzc3dvcmQ6\r\n');
          } else if (authStep === 2) {
            authSeen.pass = Buffer.from(line, 'base64').toString('utf8');
            authStep = 0;
            socket.write('235 2.7.0 OK\r\n');
          } else if (line.startsWith('MAIL FROM')) socket.write('250 OK\r\n');
          else if (line.startsWith('RCPT TO')) socket.write('250 OK\r\n');
          else if (line === 'DATA') {
            inData = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (line === 'QUIT') {
            socket.write('221 Bye\r\n');
            socket.end();
          } else socket.write('250 OK\r\n');
        });
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        resolve({
          port: (server.address() as net.AddressInfo).port,
          transcript,
          authSeen,
          close: () => new Promise<void>((done) => server.close(() => done())),
        });
      });
    });
  }

  test('a full SMTP conversation over loopback delivers the message', async () => {
    const fake = await startFakeSmtp();
    try {
      const smtp = createSmtpAdapter({
        host: '127.0.0.1',
        port: fake.port,
        user: 'smtp-user',
        pass: 'smtp-pass',
        from: 'reports@universalwebsolutions.it.com',
        tlsMode: 'none', // loopback only; the adapter refuses this off-loopback
        timeoutMs: 5_000,
      });
      const res = await smtp.send({ to: 'owner@universalwebsolutions.it.com', subject: 'Daily report', text: 'All quiet today.' });
      assert.ok(res.messageId.length > 0);
      const all = fake.transcript.join('');
      assert.ok(all.includes('EHLO'));
      assert.ok(all.includes('AUTH LOGIN'));
      assert.ok(all.includes('MAIL FROM:<reports@universalwebsolutions.it.com>'));
      assert.ok(all.includes('RCPT TO:<owner@universalwebsolutions.it.com>'));
      assert.ok(all.includes('DATA'));
      assert.equal(fake.authSeen.user, 'smtp-user');
      assert.equal(fake.authSeen.pass, 'smtp-pass');
      // Body travels base64-encoded.
      const expectedBody = Buffer.from('All quiet today.', 'utf8').toString('base64').slice(0, 20);
      assert.ok(all.includes(expectedBody), 'the message body must be present, base64-encoded');
      assert.ok(!all.includes('All quiet today.'), 'plaintext body must not appear on the wire');
    } finally {
      await fake.close();
    }
  });

  test('plaintext SMTP to a non-loopback host is refused outright', async () => {
    const smtp = createSmtpAdapter({
      host: 'smtp.example.com',
      port: 587,
      user: 'u',
      pass: 'p',
      from: 'x@y.z',
      tlsMode: 'none',
    });
    await assert.rejects(
      () => smtp.send({ to: 'a@b.c', subject: 's', text: 't' }),
      (err: unknown) => err instanceof AdapterError && /loopback/.test(err.message),
      'misconfiguration must never ship credentials in the clear',
    );
  });

  test('a server rejection maps the SMTP code to provider_error', async () => {
    // Server that greets but rejects MAIL FROM.
    const server = net.createServer((socket) => {
      socket.on('error', () => {
        /* ignore teardown resets */
      });
      socket.write('220 fake.local\r\n');
      let authStep = 0;
      socket.on('data', (chunk) => {
        const line = chunk.toString('utf8').trim();
        if (line.startsWith('EHLO')) socket.write('250 fake.local\r\n');
        else if (line === 'AUTH LOGIN') {
          authStep = 1;
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (authStep === 1) {
          authStep = 2;
          socket.write('334 UGFzc3dvcmQ6\r\n');
        } else if (authStep === 2) {
          authStep = 0;
          socket.write('235 OK\r\n');
        } else if (line.startsWith('MAIL FROM')) socket.write('550 5.1.8 sender rejected\r\n');
        else socket.write('250 OK\r\n');
      });
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });
    try {
      const smtp = createSmtpAdapter({ host: '127.0.0.1', port, user: 'u', pass: 'p', from: 'x@y.z', tlsMode: 'none', timeoutMs: 5_000 });
      await assert.rejects(
        () => smtp.send({ to: 'a@b.c', subject: 's', text: 't' }),
        (err: unknown) => err instanceof AdapterError && err.code === 'provider_error' && err.message.includes('550'),
      );
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
