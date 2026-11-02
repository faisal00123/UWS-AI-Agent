/**
 * Test harness: boots the real Express app on an ephemeral port with an
 * in-memory database, and provides a tiny cookie/CSRF-aware HTTP client.
 *
 * Tests therefore exercise the same middleware stack as production
 * (security headers, session, CSRF, RBAC, rate limits, error mapping).
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig, type Config } from '../../src/core/config.ts';
import { nullLogger, type Logger } from '../../src/core/logger.ts';
import { openDatabase, type DB } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { createApp } from '../../src/server/app.ts';
import { attachDuplexBridge, type DuplexBridge } from '../../src/server/duplex.ts';
import { createUser, login, type PublicUser } from '../../src/domain/auth/service.ts';
import { buildRegistry, type AdapterRegistry, type AdapterUsageEvent } from '../../src/adapters/registry.ts';
import { isIntegrationEnabled, recordAdapterUsage } from '../../src/domain/integrations/service.ts';
import type { FetchLike } from '../../src/adapters/types.ts';

export interface TestEnv {
  [key: string]: string | undefined;
}

export const TEST_ENV: TestEnv = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'test-session-secret-'.padEnd(64, '0'),
  DATABASE_PATH: ':memory:',
  LOG_LEVEL: 'silent',
  SCRYPT_N: '1024', // fast KDF for tests only
  LOGIN_MAX_ATTEMPTS: '5',
  LOGIN_WINDOW_MINUTES: '15',
};

export interface TestServer {
  config: Config;
  db: DB;
  logger: Logger;
  url: string;
  server: Server;
  /** The adapter registry the app was built with (for webhook signing, etc.). */
  adapters: AdapterRegistry;
  /** The duplex media bridge attached to `server` (Twilio Media Streams). */
  duplex: DuplexBridge;
  close(): Promise<void>;
  client(): TestClient;
}

export interface TestServerOptions {
  /**
   * Transport injected into every live adapter. Tests MUST pass a fake here
   * when provider env vars are set — no test may ever reach a real network.
   */
  fetchImpl?: FetchLike;
  /** Prebuilt registry overriding the env-derived one (rarely needed). */
  adapters?: AdapterRegistry;
}

export async function startTestServer(env: TestEnv = {}, opts: TestServerOptions = {}): Promise<TestServer> {
  const mergedEnv = { ...TEST_ENV, ...env };
  const config = loadConfig(mergedEnv);
  const db = openDatabase(config.databasePath);
  runMigrations(db);
  const logger = nullLogger;
  // Built from the SAME env map as the config so credential presence and
  // adapter availability always agree; fetchImpl keeps tests off the network.
  // The db-backed toggle + usage hooks are wired exactly as server/index.ts
  // does in production, so API tests exercise the real integration path.
  const adapters =
    opts.adapters ??
    buildRegistry(config, mergedEnv, {
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      isEnabled: (key) => isIntegrationEnabled(db, config, key),
      onUsage: (event: AdapterUsageEvent) =>
        recordAdapterUsage(db, {
          integration: event.integration,
          operation: event.operation,
          outcome: event.outcome,
          errorCode: event.errorCode ?? null,
          durationMs: event.durationMs,
          retries: event.retries,
          occurredAt: event.occurredAt,
        }),
    });
  const app = createApp({ config, db, logger, adapters });

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, () => resolve(s));
    s.on('error', reject);
  });
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  // Same bridge production uses, so API tests can exercise a real WebSocket
  // media session end to end (with mock adapters — never a real network).
  const duplex = attachDuplexBridge(server, { config, db, logger, adapters });

  return {
    config,
    db,
    logger,
    url,
    server,
    adapters,
    duplex,
    async close() {
      await duplex.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
    client() {
      return new TestClient(url);
    },
  };
}

export interface TestResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
  raw: string;
}

export class TestClient {
  private cookies = new Map<string, string>();
  csrfToken: string | null = null;
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  get cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
  }

  private absorbCookies(res: Response): void {
    const list =
      typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const raw of list) {
      const [pair] = raw.split(';');
      if (!pair) continue;
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      const name = pair.slice(0, idx).trim();
      const value = decodeURIComponent(pair.slice(idx + 1).trim());
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
      if (name === 'uws_csrf') this.csrfToken = value;
    }
  }

  async request<T = unknown>(
    path: string,
    opts: {
      method?: string;
      body?: unknown;
      /** Raw body string (bypasses JSON encoding) - used by CSV import. */
      rawBody?: string;
      headers?: Record<string, string>;
      csrf?: boolean;
    } = {},
  ): Promise<TestResponse<T>> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(opts.headers ?? {}),
    };
    const cookie = this.cookieHeader;
    if (cookie) headers.cookie = cookie;
    if (opts.rawBody !== undefined) {
      if (!headers['content-type']) headers['content-type'] = 'text/csv';
    } else if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (opts.csrf !== false && this.csrfToken && (opts.method ?? 'GET') !== 'GET') {
      headers['x-csrf-token'] = this.csrfToken;
    }

    const res = await fetch(this.baseUrl + path, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.rawBody !== undefined ? opts.rawBody : opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    this.absorbCookies(res);
    const raw = await res.text();
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      /* keep text */
    }
    return { status: res.status, body: body as T, headers: res.headers, raw };
  }

  get<T = unknown>(path: string): Promise<TestResponse<T>> {
    return this.request<T>(path);
  }
  post<T = unknown>(path: string, body?: unknown): Promise<TestResponse<T>> {
    return this.request<T>(path, { method: 'POST', body });
  }
  put<T = unknown>(path: string, body?: unknown): Promise<TestResponse<T>> {
    return this.request<T>(path, { method: 'PUT', body });
  }
  patch<T = unknown>(path: string, body?: unknown): Promise<TestResponse<T>> {
    return this.request<T>(path, { method: 'PATCH', body });
  }
  /** Send a raw text body (used by the CSV import endpoints). */
  send<T = unknown>(path: string, rawBody: string, contentType = 'text/csv'): Promise<TestResponse<T>> {
    return this.request<T>(path, {
      method: 'POST',
      headers: { 'content-type': contentType },
      rawBody,
    });
  }

  /** Sign in and keep session + CSRF cookies for subsequent calls. */
  async login(email: string, password: string): Promise<TestResponse<{ user: PublicUser }>> {
    return this.post<{ user: PublicUser }>('/api/auth/login', { email, password });
  }
}

export interface SeededOwner {
  user: PublicUser;
  email: string;
  password: string;
}

let counter = 0;

/** Creates an owner account directly in the test database. */
export async function seedOwner(
  server: TestServer,
  overrides: { email?: string; password?: string } = {},
): Promise<SeededOwner> {
  counter += 1;
  const email = overrides.email ?? `owner${counter}@uws.test`;
  const password = overrides.password ?? 'Owner-Password-123!';
  const user = await createUser(
    server.db,
    server.config,
    { email, password, displayName: 'Test Owner', role: 'owner' },
    { userId: null, label: 'system' },
  );
  return { user, email, password };
}

/** Signs in through the real login endpoint (rate limits included). */
export async function loginAs(
  server: TestServer,
  email: string,
  password: string,
): Promise<TestClient> {
  const client = server.client();
  const res = await client.login(email, password);
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${res.raw}`);
  }
  return client;
}
