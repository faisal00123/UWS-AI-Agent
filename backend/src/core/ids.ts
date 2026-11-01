/** Identifier helpers. Ids are opaque, sortable-by-creation ULID-like strings. */
import { randomBytes, randomUUID } from 'node:crypto';

const B32 = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford-ish, no I/L/O/U

function timePart(now: number): string {
  let t = now;
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = B32[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function randomPart(len: number): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += B32[bytes[i]! % 32];
  return out;
}

/** 26-char lexicographically sortable id with 80 bits of randomness. */
export function newId(prefix?: string): string {
  const id = timePart(Date.now()) + randomPart(16);
  return prefix ? `${prefix}_${id}` : id;
}

export function newUuid(): string {
  return randomUUID();
}

/** Opaque session/token material - 256 bits, URL safe. */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
