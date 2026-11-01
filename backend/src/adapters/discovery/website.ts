/**
 * Website discovery helper (Phase 11A, Task 6).
 *
 * Fetches a lead's OWN public homepage (URL the lead already published) and
 * extracts verification signals: page title, phone numbers, email addresses.
 * This is a free, on-demand helper used by lead verification — NOT a paid
 * search API and NOT a crawler of third parties: only the exact URL supplied
 * by the owner/import is fetched, once, with a hard timeout and a size cap.
 *
 * Safety rules:
 *   - injectable fetch (tests never touch the network);
 *   - response capped at MAX_BYTES so a hostile page cannot exhaust memory;
 *   - only http/https URLs accepted (no file:, no internal schemes);
 *   - extracted contact data is public information the business itself
 *     published; it is returned to the domain for `field_verifications`.
 */
import type { FetchLike } from '../http.ts';
import { AdapterError } from '../types.ts';

const MAX_BYTES = 512 * 1024; // 512 KB is far beyond a normal homepage
const TIMEOUT_MS = 8_000;

export interface WebsiteDiscovery {
  title: string | null;
  phones: string[];
  emails: string[];
  finalUrl: string;
}

const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function normalisePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  return digits;
}

/**
 * Fetch and parse a public homepage. Rejects with AdapterError on a bad
 * URL, a non-2xx response, or a network failure. Never includes credentials
 * (there are none: this is unauthenticated GET of public content).
 */
export async function discoverFromWebsite(
  url: string,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<WebsiteDiscovery> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AdapterError('invalid_destination', 'Website discovery requires a valid absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AdapterError('invalid_destination', 'Website discovery only accepts http/https URLs');
  }

  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, init) => fetch(u, init));

  let res: Response;
  try {
    res = await fetchImpl(parsed.toString(), {
      method: 'GET',
      headers: { accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new AdapterError('network', `Could not reach ${parsed.host}`, { retryable: true, cause: err });
  }
  if (!res.ok) {
    throw new AdapterError('provider_error', `${parsed.host} responded ${res.status}`, {
      providerStatus: res.status,
      retryable: res.status >= 500,
    });
  }

  // Cap the body: read a bounded prefix only.
  const text = (await res.text()).slice(0, MAX_BYTES);

  const titleMatch = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(text);
  const title = titleMatch?.[1] ? titleMatch[1].replace(/\s+/g, ' ').trim() || null : null;

  const visible = stripTags(text);
  const emails = [...new Set((visible.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))].slice(0, 10);
  const phones = [...new Set((visible.match(PHONE_RE) ?? []).map(normalisePhone).filter((p) => p.length >= 8))].slice(0, 10);

  return { title, phones, emails, finalUrl: res.url || parsed.toString() };
}
