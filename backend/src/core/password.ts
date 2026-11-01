/**
 * Password hashing - scrypt from Node's standard crypto library.
 *
 * Format: `scrypt$N$r$p$<salt-b64>$<hash-b64>`
 *
 * scrypt is a memory-hard KDF (RFC 7914) and is the platform-standard choice
 * that needs no native build step on Windows (bcrypt/argon2 require compiler
 * toolchains). Parameters are stored per-hash so they can be raised later and
 * old hashes are transparently upgraded on next successful login.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const KEY_LEN = 64;
const R = 8;
const P = 1;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;

const COMMON = new Set([
  'password', 'password123', '123456789012', 'qwertyuiop12', 'universalwebsolutions',
  'letmein12345', 'administrator', 'changeme12345',
]);

export interface PasswordPolicyResult {
  ok: boolean;
  problems: string[];
}

/** Basic strength policy - length first (NIST SP 800-63B). */
export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push(`must be at least ${PASSWORD_MIN_LENGTH} characters long`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    problems.push(`must be at most ${PASSWORD_MAX_LENGTH} characters long`);
  }
  if (COMMON.has(password.toLowerCase())) {
    problems.push('is too common / easily guessed');
  }
  if (/^\s|\s$/.test(password)) {
    problems.push('must not start or end with whitespace');
  }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3 && password.length < 16) {
    problems.push('must use at least three of: lowercase, uppercase, digits, symbols (or be 16+ characters)');
  }
  return { ok: problems.length === 0, problems };
}

function maxmemFor(N: number): number {
  return Math.max(32 * 1024 * 1024, 256 * N * R * 2);
}

export async function hashPassword(password: string, N = 16384): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LEN, { N, r: R, p: P, maxmem: maxmemFor(N) });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export interface VerifyResult {
  valid: boolean;
  /** True when the stored parameters are weaker than the current policy. */
  needsRehash: boolean;
}

export async function verifyPassword(password: string, stored: string): Promise<VerifyResult> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return { valid: false, needsRehash: false };
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return { valid: false, needsRehash: false };
  }
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64');
    expected = Buffer.from(parts[5]!, 'base64');
  } catch {
    return { valid: false, needsRehash: false };
  }
  if (expected.length === 0) return { valid: false, needsRehash: false };

  let actual: Buffer;
  try {
    actual = await scrypt(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: maxmemFor(N),
    });
  } catch {
    return { valid: false, needsRehash: false };
  }
  const valid = actual.length === expected.length && timingSafeEqual(actual, expected);
  return { valid, needsRehash: valid && N < 16384 };
}
