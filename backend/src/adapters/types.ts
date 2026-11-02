/**
 * Provider adapter contracts (Section 7 / Phase 7).
 *
 * These ports are the ONLY way the domain layer may touch an external service.
 * Three rules the interfaces encode:
 *
 *  1. Nothing here performs outreach on its own — the outreach guard decides,
 *     then the orchestration service calls a port. A port never decides
 *     whether an action is allowed.
 *  2. Every adapter reports an `AdapterStatus` (configured/unconfigured/error)
 *     with features and a redacted last error, so the Integrations page can be
 *     honest about what is wired up without ever seeing a secret.
 *  3. Adapters accept an injectable transport (fetch) so tests exercise the
 *     real request construction and error mapping without a network — and so
 *     no test can ever reach a real provider by accident.
 */

export type AdapterState = 'configured' | 'unconfigured' | 'error' | 'disabled';

export interface AdapterStatus {
  key: string;
  label: string;
  /** Which concrete vendor implementation would serve this port right now. */
  implementation: string | null;
  state: AdapterState;
  features: string[];
  /** Redacted: never contains tokens, passwords or full numbers. */
  lastError: string | null;
  /** True for mock/simulated implementations: never any network, ever. */
  simulated?: boolean;
}

/**
 * Lightweight connection probe used by "Test connection" / last health check.
 * Must be FREE (no paid API usage), must never include credentials in the
 * returned detail, and must reject with AdapterError on failure.
 */
export interface PingResult {
  ok: boolean;
  /** Short, redacted human summary — safe to persist and display. */
  detail?: string;
}

export type Pingable = { ping?(): Promise<PingResult> };

/** Transport abstraction so every adapter is testable without a network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type AdapterErrorCode =
  | 'unconfigured'
  | 'provider_error'
  | 'rate_limited'
  | 'invalid_destination'
  | 'network';

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly retryable: boolean;
  readonly providerStatus: number | null;

  constructor(
    code: AdapterErrorCode,
    message: string,
    opts: { retryable?: boolean; providerStatus?: number | null; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'AdapterError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.providerStatus = opts.providerStatus ?? null;
  }
}

// ------------------------------------------------------------- telephony ---

export interface CreateCallRequest {
  to: string; // E.164
  /** Where the provider fetches TwiML when the callee answers. */
  answerUrl: string;
  /** Where the provider POSTs status transitions (signed). */
  statusCallbackUrl: string;
  /** Echoed back on the status callback so an event finds its lead. */
  metadata: { businessId: string; attemptId: string };
  timeoutSeconds?: number;
}

export interface CreateCallResponse {
  providerCallId: string;
  /** Raw provider status at creation (usually 'queued'). */
  status: string;
}

export interface TelephonyPort extends Pingable {
  readonly key: string;
  readonly label: string;
  status(): AdapterStatus;
  createCall(req: CreateCallRequest): Promise<CreateCallResponse>;
}

// -------------------------------------------------------------- whatsapp ---

export interface SendTemplateRequest {
  to: string; // E.164
  templateName: string;
  languageCode: string;
  /** Approved-template variables, in order (e.g. business name, city). */
  bodyParams?: string[];
}

export interface SendTemplateResponse {
  providerMessageId: string;
  status: string;
}

export interface WhatsAppPort extends Pingable {
  readonly key: string;
  readonly label: string;
  status(): AdapterStatus;
  sendTemplate(req: SendTemplateRequest): Promise<SendTemplateResponse>;
  /**
   * Verify Meta's X-Hub-Signature-256 over the RAW request body. Must be a
   * timing-safe comparison; returns false for any malformed header.
   */
  verifySignature(rawBody: Buffer, signatureHeader: string | null): boolean;
}

// ----------------------------------------------------------- conversation ---

export interface ConversationTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ConversationPort extends Pingable {
  readonly key: string;
  readonly label: string;
  status(): AdapterStatus;
  complete(input: {
    messages: ConversationTurn[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ text: string; model: string }>;
}

// ----------------------------------------------------------------- speech ---

/**
 * Language preference for STT (which language to EXPECT) and TTS (which voice
 * to speak). 'ur' = Urdu, 'en' = English; Roman Urdu arrives as TEXT and is
 * handled by the AI conversation layer (the STT providers accept language
 * codes, not transliteration schemes).
 */
export type SpeechLanguage = 'en' | 'ur';

export interface SpeechPort extends Pingable {
  readonly key: string;
  readonly label: string;
  status(): AdapterStatus;
  transcribe(input: {
    audio: Uint8Array;
    mimeType?: string;
    filename?: string;
    /** Language the audio is spoken in (drives STT language hints). */
    language?: SpeechLanguage;
  }): Promise<{ text: string }>;
  synthesize(input: {
    text: string;
    voice?: string;
    /** Language the text is written in (selects a language-appropriate voice). */
    language?: SpeechLanguage;
    /**
     * Requested byte format. 'mp3' (default) for storage/HTTP playback,
     * 'pcm' for raw little-endian s16le mono that a telephony layer can
     * resample. Providers that cannot honour it return their default format
     * and the caller decides (never guesses) what to do with the bytes.
     */
    format?: 'mp3' | 'pcm';
  }): Promise<{ audio: Uint8Array; contentType: string; sampleRate?: number }>;
}

// ------------------------------------------------------------------ email ---

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  from?: string;
}

export interface EmailPort extends Pingable {
  readonly key: string;
  readonly label: string;
  status(): AdapterStatus;
  send(msg: EmailMessage): Promise<{ messageId: string }>;
}

// -------------------------------------------------------------- discovery ---

export interface DiscoveryQuery {
  query: string;
  city?: string;
  country?: 'PK';
  limit?: number;
}

export interface DiscoveryHit {
  name: string;
  city?: string;
  phone?: string;
  website?: string;
  sourceUrl: string;
  source: string;
}

/**
 * No live discovery adapter ships yet: choosing a directory/search vendor is
 * an owner decision (cost + terms). Until then `search()` must throw
 * `unconfigured` — discovery continues through the CSV/Excel import path.
 */
export interface DiscoveryPort extends Pingable {
  readonly key: string;
  readonly label: string;
  status(): AdapterStatus;
  search(q: DiscoveryQuery): Promise<DiscoveryHit[]>;
}
