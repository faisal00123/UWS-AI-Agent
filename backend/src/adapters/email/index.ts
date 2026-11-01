/**
 * Email provider dispatch (Phase 11A, Task 5).
 *
 * `EMAIL_PROVIDER` selects the concrete adapter:
 *   smtp - direct SMTP submission (STARTTLS/implicit TLS, loopback-only plain)
 *   mock - simulation (records the message in memory, sends nothing)
 *
 * Unknown/missing -> null. SMTP credentials come from SMTP_* / MAIL_FROM.
 */
import type { EmailPort } from '../types.ts';
import { createSmtpAdapter } from './smtp.ts';
import { createMockEmailAdapter } from '../mock/index.ts';

type Env = Record<string, string | undefined>;

export function createEmailAdapter(env: Env): EmailPort | null {
  const provider = (env['EMAIL_PROVIDER'] ?? 'smtp').trim().toLowerCase() || 'smtp';
  if (provider === 'mock') return createMockEmailAdapter();

  if (provider === 'smtp') {
    const host = (env['SMTP_HOST'] ?? '').trim();
    const user = (env['SMTP_USER'] ?? '').trim();
    const pass = (env['SMTP_PASS'] ?? '').trim();
    const from = (env['MAIL_FROM'] ?? '').trim();
    if (!host || !user || !pass || !from) return null;
    return createSmtpAdapter({
      host,
      port: Number(env['SMTP_PORT'] ?? '587'),
      user,
      pass,
      from,
    });
  }

  return null;
}

export const SUPPORTED_EMAIL_PROVIDERS = ['smtp', 'mock'] as const;
