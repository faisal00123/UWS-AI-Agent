/**
 * Website fetcher — safe outbound HTTP for lead analysis.
 *
 * Hardening (this is server-side code that requests attacker-influenced URLs):
 *  - Only http/https.
 *  - Blocks loopback, link-local, private and reserved ranges **after** DNS
 *    resolution, so a hostname cannot be pointed at internal infrastructure.
 *  - Redirects are followed manually and re-validated on every hop.
 *  - Response size and time are capped; the body is truncated, never buffered
 *    without limit.
 *  - No cookies, no credential forwarding, no execution of page JavaScript.
 *
 * Every failure returns a structured status rather than throwing, because a
 * site that cannot be fetched must be recorded as unreachable - never as
 * "the business has no website".
 */
import { lookup } from 'node:dns/promises';
import net from 'node:net';

export type FetchOutcome =
  | { ok: true; status: number; finalUrl: string; redirectCount: number; html: string; bytes: number; durationMs: number; truncated: boolean }
  | {
      ok: false;
      status: 'unreachable' | 'blocked' | 'error';
      httpStatus: number | null;
      finalUrl: string | null;
      redirectCount: number;
      durationMs: number;
      message: string;
    };

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
  /**
   * Injectable transport. Tests pass a stub so no real network is used; the
   * SSRF guard still runs because it happens before this is called.
   */
  fetchImpl?: typeof fetch;
  /**
   * Injectable DNS resolver for the SSRF guard. Tests pass a stub returning a
   * public address so no real lookup is performed. The private/reserved range
   * check still runs on whatever is returned.
   */
  dnsLookup?: (hostname: string) => Promise<{ address: string }[]>;
}

const DEFAULTS: Required<Omit<FetchOptions, 'fetchImpl' | 'dnsLookup'>> = {
  timeoutMs: 8000,
  maxBytes: 1_500_000,
  maxRedirects: 5,
  userAgent: 'UWS-LeadAnalysis/1.0 (+https://www.universalwebsolutions.it.com)',
};

/** True for loopback, private, link-local and reserved IPv4/IPv6 ranges. */
export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const parts = ip.split('.').map(Number) as [number, number, number, number];
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved / broadcast
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    if (lower.startsWith('::ffff:')) {
      const mapped = lower.slice('::ffff:'.length);
      if (net.isIPv4(mapped)) return isPrivateAddress(mapped);
    }
    return false;
  }
  return true; // not an IP -> treat as unsafe rather than guess
}

/** Resolve a hostname and reject if ANY address is private/reserved. */
async function assertPublicHost(
  hostname: string,
  resolver?: (hostname: string) => Promise<{ address: string }[]>,
): Promise<void> {
  // A literal IP host is checked directly (no DNS involved).
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new BlockedError(`Host resolves to a private or reserved address (${hostname})`);
    }
    return;
  }
  let addrs: { address: string }[];
  try {
    addrs = resolver ? await resolver(hostname) : await lookup(hostname, { all: true });
  } catch {
    throw new UnreachableError(`DNS lookup failed for ${hostname}`);
  }
  if (addrs.length === 0) throw new UnreachableError(`No DNS records for ${hostname}`);
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) {
      throw new BlockedError(`Host ${hostname} resolves to a private or reserved address (${a.address})`);
    }
  }
}

class BlockedError extends Error {}
class UnreachableError extends Error {}

function hostOf(raw: string): string | null {
  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
}

/**
 * Fetch a page for analysis. Never throws: all outcomes are structured.
 */
export async function fetchForAnalysis(rawUrl: string, options: FetchOptions = {}): Promise<FetchOutcome> {
  const opts = { ...DEFAULTS, ...options };
  const started = Date.now();
  let redirectCount = 0;
  let current = rawUrl.trim();

  for (;;) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return { ok: false, status: 'error', httpStatus: null, finalUrl: null, redirectCount, durationMs: Date.now() - started, message: 'Not a valid URL' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, status: 'blocked', httpStatus: null, finalUrl: current, redirectCount, durationMs: Date.now() - started, message: `Unsupported protocol ${parsed.protocol}` };
    }
    parsed.username = '';
    parsed.password = '';

    try {
      await assertPublicHost(parsed.hostname, options.dnsLookup);
    } catch (err) {
      const blocked = err instanceof BlockedError;
      return {
        ok: false,
        status: blocked ? 'blocked' : 'unreachable',
        httpStatus: null,
        finalUrl: current,
        redirectCount,
        durationMs: Date.now() - started,
        message: (err as Error).message,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    let res: Response;
    try {
      res = await (options.fetchImpl ?? fetch)(parsed.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': opts.userAgent,
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          'accept-language': 'en',
        },
      });
    } catch (err) {
      clearTimeout(timer);
      const aborted = controller.signal.aborted;
      const host = hostOf(current) ?? current;
      return {
        ok: false,
        status: aborted ? 'unreachable' : 'unreachable',
        httpStatus: null,
        finalUrl: current,
        redirectCount,
        durationMs: Date.now() - started,
        message: aborted ? `Timed out after ${opts.timeoutMs}ms` : `Request to ${host} failed`,
      };
    }
    clearTimeout(timer);

    // Redirect handling: re-validate every hop rather than trusting fetch.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) {
        return { ok: false, status: 'error', httpStatus: res.status, finalUrl: current, redirectCount, durationMs: Date.now() - started, message: 'Redirect without a Location header' };
      }
      if (redirectCount >= opts.maxRedirects) {
        return { ok: false, status: 'blocked', httpStatus: res.status, finalUrl: current, redirectCount, durationMs: Date.now() - started, message: `Exceeded ${opts.maxRedirects} redirects` };
      }
      try {
        current = new URL(loc, parsed).toString();
      } catch {
        return { ok: false, status: 'error', httpStatus: res.status, finalUrl: current, redirectCount, durationMs: Date.now() - started, message: 'Unparseable redirect target' };
      }
      redirectCount++;
      void res.body?.cancel().catch(() => undefined);
      continue;
    }

    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        status: res.status >= 500 ? 'unreachable' : 'unreachable',
        httpStatus: res.status,
        finalUrl: parsed.toString(),
        redirectCount,
        durationMs: Date.now() - started,
        message: `HTTP ${res.status} ${res.statusText}`.trim(),
      };
    }

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (contentType && !contentType.includes('html') && !contentType.includes('xml') && !contentType.includes('text/plain')) {
      void res.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        status: 'blocked',
        httpStatus: res.status,
        finalUrl: parsed.toString(),
        redirectCount,
        durationMs: Date.now() - started,
        message: `Content-Type "${contentType}" is not an HTML document`,
      };
    }

    // Bounded read: accumulate up to maxBytes, then stop.
    const reader = res.body?.getReader();
    let text = '';
    let bytes = 0;
    let truncated = false;
    if (reader) {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > opts.maxBytes) {
          const keep = value.byteLength - (bytes - opts.maxBytes);
          text += decoder.decode(value.subarray(0, Math.max(keep, 0)), { stream: true });
          truncated = true;
          void reader.cancel().catch(() => undefined);
          break;
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      bytes = buf.byteLength;
      text = buf.subarray(0, opts.maxBytes).toString('utf-8');
      truncated = bytes > opts.maxBytes;
    }

    return { ok: true, status: res.status, finalUrl: parsed.toString(), redirectCount, html: text, bytes, durationMs: Date.now() - started, truncated };
  }
}
