/**
 * SMTP email adapter (Phase 7).
 *
 * A deliberately small SMTP client (node:net / node:tls, no dependency): the
 * owner notifications and daily reports of Phase 8 send through this port.
 *
 * Security rules encoded here:
 *  - plaintext SMTP (tlsMode: 'none') is accepted ONLY for loopback hosts, so
 *    a misconfiguration can never ship credentials across a network in the
 *    clear;
 *  - AUTH credentials never appear in thrown errors;
 *  - the socket has a hard idle timeout and every server reply maps to an
 *    AdapterError with the SMTP code preserved.
 *
 * `starttls` (default for port 587) upgrades after EHLO; `tls` is implicit
 * TLS (port 465).
 */
import net from 'node:net';
import tls from 'node:tls';
import { AdapterError, type AdapterStatus, type EmailPort, type EmailMessage } from '../types.ts';

export interface SmtpOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  tlsMode?: 'starttls' | 'tls' | 'none';
  timeoutMs?: number;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

interface Reply {
  code: number;
  text: string;
}

/**
 * Line-oriented reader for SMTP replies. A reply is one or more lines where
 * every line except the last starts with "NNN-" and the last starts with
 * "NNN " (RFC 5321).
 */
class SmtpSession {
  private buffer = '';
  private pending: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  private closed = false;
  private socket: net.Socket;

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.attach(socket);
  }

  private readonly onData = (chunk: string): void => {
    this.buffer += chunk;
    this.drain();
  };
  private readonly onEnd = (): void => this.fail(new Error('connection closed'));

  private attach(socket: net.Socket): void {
    socket.setEncoding('utf8');
    socket.on('data', this.onData);
    socket.on('error', this.onEnd);
    socket.on('close', this.onEnd);
    socket.setTimeout?.(15_000, () => this.fail(new Error('timeout')));
  }

  /** Rebind to an upgraded (STARTTLS) socket, dropping the plain one. */
  upgrade(next: net.Socket): void {
    this.socket.removeListener('data', this.onData);
    this.socket.removeListener('error', this.onEnd);
    this.socket.removeListener('close', this.onEnd);
    this.socket = next;
    this.attach(next);
  }

  private fail(err: Error): void {
    this.closed = true;
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p.reject(err);
    }
  }

  /** Pull as many complete replies off the buffer as are pending. */
  private drain(): void {
    while (this.pending) {
      const reply = this.takeReply();
      if (!reply) return;
      const p = this.pending;
      this.pending = null;
      p.resolve(reply);
    }
  }

  private takeReply(): Reply | null {
    let searchFrom = 0;
    for (;;) {
      const nl = this.buffer.indexOf('\n', searchFrom);
      if (nl === -1) return null;
      const lineEnd = nl + 1;
      // Slice the CURRENT line only (from searchFrom), not the whole prefix —
      // otherwise a continuation line would be re-tested on every iteration
      // and a multiline reply could never terminate.
      const line = this.buffer.slice(searchFrom, nl).replace(/\r$/, '');
      if (/^\d{3}-/.test(line)) {
        searchFrom = lineEnd; // continuation: keep looking for the final line
        continue;
      }
      const raw = this.buffer.slice(0, lineEnd);
      this.buffer = this.buffer.slice(lineEnd);
      if (/^\d{3} /.test(line)) {
        const code = Number.parseInt(line.slice(0, 3), 10);
        return { code, text: raw.split(/\r?\n/).filter((l) => l.length > 0).join('\n') };
      }
      // Protocol noise before the reply — drop it and keep scanning.
      searchFrom = 0;
    }
  }

  readReply(): Promise<Reply> {
    if (this.closed) return Promise.reject(new Error('connection closed'));
    return new Promise<Reply>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.drain(); // a reply may already be buffered
    });
  }

  write(line: string): void {
    this.socket.write(`${line}\r\n`);
  }

  writeRaw(data: string): void {
    this.socket.write(data);
  }

  upgradeSocket(): net.Socket {
    return this.socket;
  }

  destroy(): void {
    this.socket.destroy();
  }
}

async function expect(session: SmtpSession, ok: number[], what: string): Promise<Reply> {
  const reply = await session.readReply().catch((err: Error) => {
    throw new AdapterError('network', `SMTP ${what}: ${err.message}`, { retryable: true, cause: err });
  });
  if (!ok.includes(reply.code)) {
    throw new AdapterError('provider_error', `SMTP ${what} failed (${reply.code})`, {
      providerStatus: reply.code,
      retryable: reply.code >= 400 && reply.code < 500,
    });
  }
  return reply;
}

function encodeSubject(subject: string): string {
  const ascii = /^[\x20-\x7E]*$/.test(subject);
  if (ascii) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

/** RFC 5322 message: base64 body, headers as ASCII (subject B-encoded). */
export function buildSmtpMessage(msg: EmailMessage, from: string): string {
  const body = Buffer.from(msg.text, 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');
  return [
    `From: ${from}`,
    `To: ${msg.to}`,
    `Subject: ${encodeSubject(msg.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@uws.local>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
    '',
  ].join('\r\n');
}

function connectPlain(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port }, () => {
      s.removeListener('error', reject);
      resolve(s);
    });
    s.once('error', reject);
    s.setTimeout(timeoutMs, () => s.destroy(new Error('timeout')));
  });
}

export function createSmtpAdapter(opts: SmtpOptions): EmailPort {
  const tlsMode = opts.tlsMode ?? (opts.port === 465 ? 'tls' : 'starttls');
  let lastError: string | null = null;

  return {
    key: 'smtp',
    label: 'Email (SMTP)',

    status(): AdapterStatus {
      const configured = Boolean(opts.host && opts.user && opts.pass && opts.from);
      return {
        key: 'email',
        label: 'Email (SMTP)',
        implementation: configured ? 'smtp' : null,
        state: configured ? (lastError ? 'error' : 'configured') : 'unconfigured',
        features: ['owner notifications', 'daily report email'],
        lastError,
      };
    },

    async send(msg: EmailMessage): Promise<{ messageId: string }> {
      if (!opts.host || !opts.user || !opts.pass) {
        throw new AdapterError('unconfigured', 'SMTP is not configured (host/user/pass missing)');
      }
      if (tlsMode === 'none' && !LOOPBACK.has(opts.host)) {
        // Refusing is the whole point: plaintext auth off-loopback is unsafe.
        throw new AdapterError(
          'provider_error',
          'Refusing to send over plaintext SMTP to a non-loopback host; configure TLS (587 STARTTLS or 465 implicit TLS)',
        );
      }
      const from = msg.from ?? opts.from;
      const timeoutMs = opts.timeoutMs ?? 15_000;

      const socket: net.Socket = await (async (): Promise<net.Socket> => {
        if (tlsMode === 'tls') {
          return new Promise((resolve, reject) => {
            const s = tls.connect({ host: opts.host, port: opts.port, servername: opts.host }, () => {
              s.removeListener('error', reject);
              resolve(s);
            });
            s.once('error', reject);
            s.setTimeout(timeoutMs, () => s.destroy(new Error('timeout')));
          });
        }
        return connectPlain(opts.host, opts.port, timeoutMs);
      })().catch((err: Error) => {
        lastError = 'network: could not reach the mail host';
        throw new AdapterError(
          'network',
          `Could not reach the mail host (${err.message === 'timeout' ? 'timeout' : 'connection error'})`,
          { retryable: true, cause: err },
        );
      });

      const session = new SmtpSession(socket);
      try {
        await expect(session, [220], 'greeting');
        const ehloHost = LOOPBACK.has(opts.host) ? 'localhost' : 'uws.local';
        session.write(`EHLO ${ehloHost}`);
        await expect(session, [250], 'EHLO');

        if (tlsMode === 'starttls') {
          session.write('STARTTLS');
          await expect(session, [220], 'STARTTLS');
          const plain = session.upgradeSocket();
          const upgraded = await new Promise<tls.TLSSocket>((resolve, reject) => {
            const s = tls.connect({ socket: plain, servername: opts.host }, () => resolve(s));
            s.once('error', reject);
          }).catch((err: Error) => {
            throw new AdapterError('provider_error', `STARTTLS negotiation failed (${err.name})`, {
              retryable: false,
            });
          });
          session.upgrade(upgraded); // rebind the session to the encrypted socket
          session.write(`EHLO ${ehloHost}`);
          await expect(session, [250], 'EHLO after STARTTLS');
        }

        if (opts.user) {
          session.write('AUTH LOGIN');
          await expect(session, [334], 'AUTH LOGIN start');
          session.write(Buffer.from(opts.user, 'utf8').toString('base64'));
          await expect(session, [334], 'AUTH username');
          session.write(Buffer.from(opts.pass, 'utf8').toString('base64'));
          await expect(session, [235], 'AUTH password');
        }

        session.write(`MAIL FROM:<${from}>`);
        await expect(session, [250], 'MAIL FROM');
        session.write(`RCPT TO:<${msg.to}>`);
        await expect(session, [250, 251], 'RCPT TO');
        session.write('DATA');
        await expect(session, [354], 'DATA');
        // Dot-stuffing: base64 body never starts a line with '.', headers are
        // filtered ASCII, so terminating CRLF.CRLF is the only requirement.
        session.writeRaw(`${buildSmtpMessage(msg, from)}.\r\n`);
        const accepted = await expect(session, [250], 'message acceptance');
        const m = accepted.text.match(/queued as ([A-Za-z0-9@._-]+)/i);
        session.write('QUIT');
        lastError = null;
        return { messageId: m?.[1] ?? `local-${Date.now().toString(36)}` };
      } catch (err) {
        if (err instanceof AdapterError) {
          lastError = `${err.code}: ${err.message}`;
          throw err;
        }
        const detail = err instanceof Error ? err.message : 'unknown failure';
        lastError = `provider_error: ${detail}`;
        throw new AdapterError('provider_error', `SMTP conversation failed (${detail})`, { cause: err });
      } finally {
        session.destroy();
      }
    },

    /**
     * Free connection probe (Phase 11B): connect + EHLO (+STARTTLS) + AUTH,
     * then QUIT — deliberately stops BEFORE `MAIL FROM`/`DATA`, so nothing is
     * sent and nothing can be billed. Validates credentials end to end.
     */
    async ping(): Promise<{ ok: boolean; detail?: string }> {
      if (!opts.host || !opts.user || !opts.pass) {
        return { ok: false, detail: 'SMTP is not configured (host/user/pass missing).' };
      }
      if (tlsMode === 'none' && !LOOPBACK.has(opts.host)) {
        return {
          ok: false,
          detail: 'Refusing plaintext SMTP to a non-loopback host; configure TLS (587 STARTTLS or 465 implicit TLS).',
        };
      }
      const timeoutMs = opts.timeoutMs ?? 15_000;
      const socket: net.Socket | null = await (async (): Promise<net.Socket> => {
        if (tlsMode === 'tls') {
          return new Promise((resolve, reject) => {
            const s = tls.connect({ host: opts.host, port: opts.port, servername: opts.host }, () => {
              s.removeListener('error', reject);
              resolve(s);
            });
            s.once('error', reject);
            s.setTimeout(timeoutMs, () => s.destroy(new Error('timeout')));
          });
        }
        return connectPlain(opts.host, opts.port, timeoutMs);
      })().catch(() => null);

      if (!socket) {
        lastError = 'network: could not reach the mail host';
        return { ok: false, detail: 'Could not reach the mail host (connection error or timeout).' };
      }

      const session = new SmtpSession(socket);
      try {
        await expect(session, [220], 'greeting');
        const ehloHost = LOOPBACK.has(opts.host) ? 'localhost' : 'uws.local';
        session.write(`EHLO ${ehloHost}`);
        await expect(session, [250], 'EHLO');

        if (tlsMode === 'starttls') {
          session.write('STARTTLS');
          await expect(session, [220], 'STARTTLS');
          const plain = session.upgradeSocket();
          const upgraded = await new Promise<tls.TLSSocket>((resolve, reject) => {
            const s = tls.connect({ socket: plain, servername: opts.host }, () => resolve(s));
            s.once('error', reject);
          }).catch(() => null);
          if (!upgraded) {
            return { ok: false, detail: 'STARTTLS negotiation failed.' };
          }
          session.upgrade(upgraded);
          session.write(`EHLO ${ehloHost}`);
          await expect(session, [250], 'EHLO after STARTTLS');
        }

        if (opts.user) {
          session.write('AUTH LOGIN');
          await expect(session, [334], 'AUTH LOGIN start');
          session.write(Buffer.from(opts.user, 'utf8').toString('base64'));
          await expect(session, [334], 'AUTH username');
          session.write(Buffer.from(opts.pass, 'utf8').toString('base64'));
          await expect(session, [235], 'AUTH password');
        }

        session.write('QUIT');
        lastError = null;
        return { ok: true, detail: 'SMTP connect + auth OK — nothing was sent (no MAIL FROM/DATA).' };
      } catch (err) {
        if (err instanceof AdapterError) lastError = `${err.code}: ${err.message}`;
        const detail = err instanceof AdapterError ? `${err.code}: ${err.message}` : 'SMTP probe failed.';
        return { ok: false, detail };
      } finally {
        session.destroy();
      }
    },
  };
}
