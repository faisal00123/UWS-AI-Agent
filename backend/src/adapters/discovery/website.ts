/**
 * Website discovery helper (Phase 11A, Task 6; hardened by the H2/M1 audit fixes).
 *
 * Fetches a lead's OWN public homepage (URL the lead already published) and
 * extracts verification signals: page title, phone numbers, email addresses.
 * This is a free, on-demand helper used by lead verification — NOT a paid
 * search API and NOT a crawler of third parties: only the exact URL supplied
 * by the owner/import is fetched, once, with a hard timeout and a size cap.
 *
 * Security — the fetch is DELEGATED to the same hardened fetcher the website
 * analysis path uses (domain/analysis/fetcher.ts), so both paths share one
 * implementation and cannot drift apart:
 *   - only http/https URLs are accepted (no file:, no internal schemes);
 *   - DNS is resolved first and EVERY resolved address is rejected when it is
 *     loopback / private / link-local / CGNAT / cloud-metadata / reserved
 *     (SSRF guard), before any request leaves the process;
 *   - redirects are followed MANUALLY and the destination of every hop is
 *     re-validated the same way — never an automatic unchecked redirect;
 *   - a hard timeout covers the request AND the body read (the body phase is
 *     capped by this module: on expiry the stream is errored and the upstream
 *     body is cancelled, so nothing keeps running);
 *   - the body is read through the fetcher's genuinely BOUNDED streaming
 *     reader (maxBytes, reader.cancel() at the cap) — never res.text() into
 *     memory — and only HTML/XML/text content types are accepted (fail
 *     closed); page JavaScript is never executed.
 *
 * Injectable transport AND DNS resolver for tests: a test can neither reach
 * the network nor leak a real DNS lookup. When a transport is injected
 * WITHOUT a resolver, a fixed public stand-in address is used (an injected
 * transport performs no real I/O, so none may happen at the lookup either);
 * the private-range CHECK still runs on whatever address is returned, and
 * literal-IP hosts are always validated directly. In production no transport
 * is injected, so the real resolver and the full guard apply.
 *
 * Extracted contact data is public information the business itself
 * published; it is returned to the domain for `field_verifications`.
 */
import type { FetchLike } from '../http.ts';
import { AdapterError } from '../types.ts';
import { extractContacts } from '../../core/contacts.ts';
import { fetchForAnalysis, type FetchOptions, type FetchOutcome } from '../../domain/analysis/fetcher.ts';

const MAX_BYTES = 512 * 1024; // 512 KB is far beyond a normal homepage
const TIMEOUT_MS = 8_000;

export interface WebsiteDiscovery {
  title: string | null;
  phones: string[];
  emails: string[];
  finalUrl: string;
}

export interface WebsiteFetchOptions {
  /** Injectable transport (tests never touch the network). */
  fetchImpl?: FetchLike;
  /** Injectable DNS resolver for the SSRF guard (tests never do real I/O). */
  dnsLookup?: FetchOptions['dnsLookup'];
  /** Total deadline: request phase + body read (default 8 s). */
  timeoutMs?: number;
  /** Hard cap on the response body (default 512 KB). */
  maxBytes?: number;
}

function normalisePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  return digits;
}

/**
 * DNS stand-in used ONLY when a transport is injected without a resolver
 * (test doubles): no real lookup may happen from an injected-transport call.
 * The returned address is public, so the private-range guard still passes a
 * healthy host and still rejects a private address handed back by a stub.
 */
const INJECTED_TRANSPORT_DNS: NonNullable<FetchOptions['dnsLookup']> = async () => [
  { address: '93.184.216.34' },
];

/**
 * Cap body consumption with the TOTAL remaining deadline. The shared fetcher's
 * own timer covers the request/response-header phase only; this wrapper covers
 * the read phase too (the pre-fix AbortSignal.timeout semantics). On expiry
 * the upstream body is cancelled and the reader rejects, so the caller sees a
 * timeout and no stream is left running. Normal completion, byte-cap cancel,
 * upstream error and deadline all clear the timer — resources released on
 * every path.
 */
function withBodyDeadline(res: Response, deadlineMs: number): Response {
  const body = res.body;
  if (!body || deadlineMs <= 0) return res;
  const reader = body.getReader();
  let timer: NodeJS.Timeout | undefined;
  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        clear();
        void reader.cancel().catch(() => undefined);
        try {
          controller.error(new Error(`Timed out after ${deadlineMs}ms reading the response body`));
        } catch {
          /* already closed — nothing to do */
        }
      }, deadlineMs);
      // Deliberately NOT unref'd: every normal path (completion, byte-cap
      // cancel, upstream error, caller cancel) clears this timer, so it only
      // ever lives when the body has stalled — exactly when it must fire.
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          clear();
          try {
            controller.close();
          } catch {
            /* the deadline already errored the stream */
          }
        } else {
          try {
            controller.enqueue(value);
          } catch {
            /* the deadline already errored the stream */
          }
        }
      } catch (err) {
        clear();
        try {
          controller.error(err);
        } catch {
          /* already terminal */
        }
      }
    },
    cancel(reason) {
      clear();
      return reader.cancel(reason);
    },
  });
  return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** Translate a structured fetcher outcome into the historic AdapterError contract. */
function mapOutcome(outcome: Extract<FetchOutcome, { ok: false }>, parsed: URL): AdapterError {
  if (outcome.status === 'blocked') {
    // Protocol refusals (a redirect to file:// etc.) are destination problems.
    if (outcome.message.startsWith('Unsupported protocol')) {
      return new AdapterError('invalid_destination', 'Website discovery only accepts http/https URLs');
    }
    // SSRF refusals name the private/reserved address: the DESTINATION is
    // wrong, so it is never retried. The other blocks (redirect cap,
    // non-HTML content type) are provider-side failures — also never retried.
    if (/private or reserved/i.test(outcome.message)) {
      return new AdapterError('invalid_destination', outcome.message);
    }
    return new AdapterError('provider_error', outcome.message);
  }
  if (outcome.message === 'Not a valid URL') {
    return new AdapterError('invalid_destination', 'Website discovery requires a valid absolute URL');
  }
  if (outcome.status === 'error') {
    return new AdapterError('provider_error', outcome.message);
  }
  if (outcome.httpStatus !== null) {
    let host = parsed.host;
    if (outcome.finalUrl) {
      try {
        host = new URL(outcome.finalUrl).host;
      } catch {
        /* keep the original host */
      }
    }
    return new AdapterError('provider_error', `${host} responded ${outcome.httpStatus}`, {
      providerStatus: outcome.httpStatus,
      retryable: outcome.httpStatus >= 500,
    });
  }
  // DNS failure, timeout or transport error — transient, worth retrying.
  return new AdapterError('network', outcome.message, { retryable: true });
}

/**
 * Fetch and parse a public homepage. Rejects with AdapterError on a bad URL,
 * a blocked destination (SSRF guard), a non-2xx response, or a network
 * failure. Never includes credentials (there are none: this is unauthenticated
 * GET of public content).
 */
export async function discoverFromWebsite(
  url: string,
  opts: WebsiteFetchOptions = {},
): Promise<WebsiteDiscovery> {
  // Up-front validation (no I/O): preserves the historic error contract.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AdapterError('invalid_destination', 'Website discovery requires a valid absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AdapterError('invalid_destination', 'Website discovery only accepts http/https URLs');
  }

  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_BYTES;

  // Bridge FetchLike (string URL) to the fetcher's `typeof fetch` transport
  // and wrap the body so the deadline covers the read phase as well.
  const innerFetch: FetchLike = opts.fetchImpl ?? ((u, init) => fetch(u, init));
  const fetchImpl: typeof fetch = async (input, init) => {
    const began = Date.now();
    const res = await innerFetch(String(input), init ?? {});
    return withBodyDeadline(res, Math.max(1, timeoutMs - (Date.now() - began)));
  };
  const dnsLookup = opts.dnsLookup ?? (opts.fetchImpl ? INJECTED_TRANSPORT_DNS : undefined);

  let outcome: FetchOutcome;
  try {
    outcome = await fetchForAnalysis(parsed.toString(), {
      timeoutMs,
      maxBytes,
      fetchImpl,
      ...(dnsLookup ? { dnsLookup } : {}),
    });
  } catch (err) {
    // A body-read failure (connection dropped mid-stream, deadline) escapes
    // the fetcher's structured outcomes. The stream is already terminal —
    // nothing is left running — so surface it as a retryable network error.
    throw new AdapterError(
      'network',
      `Could not read ${parsed.host}: ${err instanceof Error ? err.message : String(err)}`,
      { retryable: true, cause: err },
    );
  }
  if (!outcome.ok) throw mapOutcome(outcome, parsed);

  const titleMatch = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(outcome.html);
  const title = titleMatch?.[1] ? titleMatch[1].replace(/\s+/g, ' ').trim() || null : null;

  // Shared extractor (same one website analysis uses): mailto/tel hrefs and
  // visible text, scripts/styles skipped, deduped and capped. Phones keep
  // this helper's historic digit-normalised shape for its callers.
  const contacts = extractContacts(outcome.html);
  const emails = [...new Set(contacts.emails.map((e) => e.toLowerCase()))].slice(0, 10);
  const phones = [...new Set(contacts.phones.map(normalisePhone).filter((p) => p.length >= 8))].slice(0, 10);

  return { title, phones, emails, finalUrl: outcome.finalUrl || parsed.toString() };
}
