/**
 * Mock provider adapters (Phase 11A, Task 9).
 *
 * One deterministic, ZERO-NETWORK implementation per port. They serve two
 * purposes:
 *   1. tests exercise the full adapter interface, registry dispatch,
 *      health checks and usage tracking without any provider account;
 *   2. an owner may set `<INTEGRATION>_PROVIDER=mock` to rehearse a flow in
 *      SIMULATION mode end-to-end — every status advertises
 *      `simulated: true` and the label says "(simulated)" so the dashboard
 *      can never pretend a mock result is real.
 *
 * Rules honoured here:
 *   - never performs I/O of any kind (no fetch, no sockets, no timers);
 *   - never contains or emits credentials;
 *   - results are deterministic (counter-based ids) so tests assert exactly.
 */
import { AdapterError } from '../types.ts';
import type {
  AdapterStatus,
  ConversationPort,
  ConversationTurn,
  DiscoveryPort,
  DiscoveryHit,
  EmailMessage,
  EmailPort,
  PingResult,
  SendTemplateRequest,
  SendTemplateResponse,
  SpeechPort,
  TelephonyPort,
  CreateCallRequest,
  CreateCallResponse,
  WhatsAppPort,
} from '../types.ts';

// ------------------------------------------------------------- telephony ---

export interface MockTelephonyAdapter extends TelephonyPort {
  readonly calls: CreateCallRequest[];
}

export function createMockTelephonyAdapter(): MockTelephonyAdapter {
  let seq = 0;
  const calls: CreateCallRequest[] = [];
  return {
    key: 'mock_telephony',
    label: 'Telephony (simulated)',
    calls,
    status(): AdapterStatus {
      return {
        key: 'telephony',
        label: 'Telephony (calls)',
        implementation: 'mock',
        state: 'configured',
        features: ['outbound calls (simulated)', 'status callbacks (simulated)'],
        lastError: null,
        simulated: true,
      };
    },
    async createCall(req: CreateCallRequest): Promise<CreateCallResponse> {
      if (!/^\+?\d{7,15}$/.test(req.to)) {
        throw new AdapterError('invalid_destination', 'Mock telephony rejects a non-E.164-like destination');
      }
      seq += 1;
      calls.push(req);
      return { providerCallId: `mock_call_${seq}`, status: 'queued' };
    },
    async ping(): Promise<PingResult> {
      return { ok: true, detail: 'mock adapter — simulated, no network used' };
    },
  };
}

// -------------------------------------------------------------- whatsapp ---

export interface MockWhatsAppAdapter extends WhatsAppPort {
  readonly sent: SendTemplateRequest[];
}

export function createMockWhatsAppAdapter(): MockWhatsAppAdapter {
  let seq = 0;
  const sent: SendTemplateRequest[] = [];
  return {
    key: 'mock_whatsapp',
    label: 'WhatsApp (simulated)',
    sent,
    status(): AdapterStatus {
      return {
        key: 'whatsapp',
        label: 'WhatsApp Business',
        implementation: 'mock',
        state: 'configured',
        features: ['portfolio messages (simulated)', 'delivery events (simulated)'],
        lastError: null,
        simulated: true,
      };
    },
    async sendTemplate(req: SendTemplateRequest): Promise<SendTemplateResponse> {
      if (!/^\+?\d{7,15}$/.test(req.to)) {
        throw new AdapterError('invalid_destination', 'Mock WhatsApp rejects a non-E.164-like destination');
      }
      if (!req.templateName.trim()) {
        throw new AdapterError('provider_error', 'Mock WhatsApp requires a template name');
      }
      seq += 1;
      sent.push(req);
      return { providerMessageId: `mock_msg_${seq}`, status: 'sent' };
    },
    // A mock has no signing secret, therefore it can never verify a webhook:
    // returning false is the honest behaviour (bad signatures stay refused).
    verifySignature(): boolean {
      return false;
    },
    async ping(): Promise<PingResult> {
      return { ok: true, detail: 'mock adapter — simulated, no network used' };
    },
  };
}

// ------------------------------------------------------------------- ai ----

export interface MockAIAdapter extends ConversationPort {
  readonly completions: ConversationTurn[][];
  /** Test hook: override the generated reply. */
  responder: ((turns: ConversationTurn[]) => string) | null;
}

/**
 * Deterministic AI stand-in. Default replies contain a machine-readable
 * qualification block so engine-level tests can parse it end-to-end.
 */
export function createMockAIAdapter(opts: { reply?: string } = {}): MockAIAdapter {
  const completions: ConversationTurn[][] = [];
  const adapter: MockAIAdapter = {
    key: 'mock_ai',
    label: 'AI conversation (simulated)',
    completions,
    responder: null,
    status(): AdapterStatus {
      return {
        key: 'ai',
        label: 'AI conversation',
        implementation: 'mock',
        state: 'configured',
        features: ['call turns (simulated)', 'qualification extraction (simulated)'],
        lastError: null,
        simulated: true,
      };
    },
    async complete(input): Promise<{ text: string; model: string }> {
      if (input.messages.length === 0) {
        throw new AdapterError('provider_error', 'Mock AI received no messages');
      }
      completions.push([...input.messages]);
      const text =
        adapter.responder?.(input.messages) ??
        opts.reply ??
        [
          'Assalam-o-Alaikum! This is a simulated assistant call (no real call is happening).',
          '```json',
          '{"qualification":"needs_review","interest_level":"neutral","objections":[],"next_step":"callback","notes":"simulated turn"}',
          '```',
        ].join('\n');
      return { text, model: 'mock-model' };
    },
    async ping(): Promise<PingResult> {
      return { ok: true, detail: 'mock adapter — simulated, no network used' };
    },
  };
  return adapter;
}

// -------------------------------------------------------------- speech -----

export interface MockSpeechAdapter extends SpeechPort {
  readonly transcriptions: { language?: string }[];
  readonly syntheses: { text: string; voice?: string; language?: string }[];
}

export function createMockSpeechAdapter(defaults: { language?: 'en' | 'ur'; voice?: string } = {}): MockSpeechAdapter {
  const transcriptions: { language?: string }[] = [];
  const syntheses: { text: string; voice?: string; language?: string }[] = [];
  return {
    key: 'mock_speech',
    label: 'Speech (simulated)',
    transcriptions,
    syntheses,
    status(): AdapterStatus {
      return {
        key: 'speech',
        label: 'Speech (STT/TTS)',
        implementation: 'mock',
        state: 'configured',
        features: ['transcription (simulated)', 'voice synthesis (simulated)', 'ur + en'],
        lastError: null,
        simulated: true,
      };
    },
    async transcribe(input) {
      const language = input.language ?? defaults.language ?? 'en';
      transcriptions.push({ language });
      return { text: `(${language} simulated transcript of ${input.audio.byteLength} bytes)` };
    },
    async synthesize(input) {
      const language = input.language ?? defaults.language ?? 'en';
      const voice = input.voice ?? defaults.voice ?? 'mock-voice';
      syntheses.push({ text: input.text, voice, language });
      // Canonical 44-byte PCM WAV header + deterministic silence sized by text.
      const samples = Math.min(2_000, 8 * input.text.length);
      const header = Buffer.alloc(44);
      header.write('RIFF', 0, 'ascii');
      header.writeUInt32LE(36 + samples, 4); // file size - 8
      header.write('WAVE', 8, 'ascii');
      header.write('fmt ', 12, 'ascii');
      header.writeUInt32LE(16, 16); // fmt chunk size
      header.writeUInt16LE(1, 20); // PCM
      header.writeUInt16LE(1, 22); // mono
      header.writeUInt32LE(8_000, 24); // sample rate
      header.writeUInt32LE(8_000, 28); // byte rate (8kHz * 1ch * 1 byte)
      header.writeUInt16LE(1, 32); // block align
      header.writeUInt16LE(8, 34); // bits per sample
      header.write('data', 36, 'ascii');
      header.writeUInt32LE(samples, 40);
      return {
        audio: new Uint8Array(Buffer.concat([header, Buffer.alloc(samples)])),
        contentType: 'audio/wav',
      };
    },
    async ping(): Promise<PingResult> {
      return { ok: true, detail: 'mock adapter — simulated, no network used' };
    },
  };
}

// ---------------------------------------------------------------- email ----

export interface MockEmailAdapter extends EmailPort {
  readonly sent: EmailMessage[];
  failNext: string | null;
}

export function createMockEmailAdapter(): MockEmailAdapter {
  let seq = 0;
  const sent: EmailMessage[] = [];
  const adapter: MockEmailAdapter = {
    key: 'mock_email',
    label: 'Email (simulated)',
    sent,
    failNext: null,
    status(): AdapterStatus {
      return {
        key: 'email',
        label: 'Email (SMTP)',
        implementation: 'mock',
        state: 'configured',
        features: ['owner notifications (simulated)', 'daily report email (simulated)'],
        lastError: null,
        simulated: true,
      };
    },
    async send(msg) {
      if (adapter.failNext) {
        const code = adapter.failNext;
        adapter.failNext = null;
        throw new AdapterError('provider_error', `Simulated failure: ${code}`);
      }
      if (!msg.to.includes('@')) {
        throw new AdapterError('invalid_destination', 'Mock email requires a valid recipient');
      }
      seq += 1;
      sent.push(msg);
      return { messageId: `mock_email_${seq}` };
    },
    async ping(): Promise<PingResult> {
      return { ok: true, detail: 'mock adapter — simulated, no network used' };
    },
  };
  return adapter;
}

// ------------------------------------------------------------ discovery ----

export interface MockDiscoveryAdapter extends DiscoveryPort {
  readonly queries: string[];
  fixtures: DiscoveryHit[];
}

/**
 * Fixture-backed directory search: hits are the supplied fixtures filtered by
 * query/city, so discovery pipelines run end-to-end with zero network.
 */
export function createMockDiscoveryAdapter(fixtures: DiscoveryHit[] = []): MockDiscoveryAdapter {
  const queries: string[] = [];
  return {
    key: 'mock_discovery',
    label: 'Lead discovery (simulated)',
    queries,
    fixtures,
    status(): AdapterStatus {
      return {
        key: 'discovery',
        label: 'Lead discovery',
        implementation: 'mock',
        state: 'configured',
        features: ['public web/directory lead search (simulated)'],
        lastError: null,
        simulated: true,
      };
    },
    async search(q) {
      queries.push(q.query);
      const term = q.query.trim().toLowerCase();
      const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
      return fixtures
        .filter((f) => {
          const matchesTerm =
            term === '' || f.name.toLowerCase().includes(term) || (f.city ?? '').toLowerCase().includes(term);
          const matchesCity = !q.city || (f.city ?? '').toLowerCase() === q.city.toLowerCase();
          return matchesTerm && matchesCity;
        })
        .slice(0, limit);
    },
    async ping(): Promise<PingResult> {
      return { ok: true, detail: 'mock adapter — simulated, no network used' };
    },
  };
}
