/**
 * Backup file encryption (Phase 9).
 *
 * Backups may contain personal data (names, phone numbers, email addresses),
 * so when the owner sets BACKUP_PASSPHRASE the stored file is encrypted with
 * AES-256-GCM using a key derived from the passphrase via scrypt.
 *
 * File format ("UWSBK1"):
 *
 *   magic (6 bytes "UWSBK1") | salt (16) | iv (12) | ciphertext | tag (16)
 *
 *  - the key is scrypt(passphrase, salt, 32) with stored-cost parameters
 *    (N=16384, r=8, p=1) so any future version can still decrypt old files
 *  - the header (magic + salt) is bound as AAD, so stripping or swapping the
 *    header is detected as authentication failure
 *  - GCM authenticates the whole file: a single flipped bit fails decryption
 *
 * Honest limitation: the plaintext is held in memory during encrypt/decrypt.
 * This is acceptable at this deployment's scale (a sales CRM database) and is
 * documented rather than hidden behind a half-tested streaming format.
 */
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';

const MAGIC = Buffer.from('UWSBK1', 'ascii');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Raw (unencrypted) buffer starts with a SQLite header; ours starts with MAGIC. */
export function isEncryptedBuffer(buf: Buffer): boolean {
  return buf.length >= MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, KEY_LEN, SCRYPT);
}

export function encryptBuffer(plain: Buffer, passphrase: string): Buffer {
  if (!passphrase) throw new Error('encryptBuffer requires a non-empty passphrase');
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.concat([MAGIC, salt]));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, ciphertext, tag]);
}

export class BackupDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupDecryptError';
  }
}

/**
 * Decrypts a UWSBK1 file. Throws BackupDecryptError on a wrong passphrase or
 * any tampering — the caller must treat that as "backup unusable", never as
 * "try with relaxed checks".
 */
export function decryptBuffer(blob: Buffer, passphrase: string): Buffer {
  if (!isEncryptedBuffer(blob)) {
    throw new BackupDecryptError('not an encrypted UWSBK1 backup (magic header missing)');
  }
  const headerLen = MAGIC.length + SALT_LEN + IV_LEN;
  if (blob.length < headerLen + TAG_LEN) {
    throw new BackupDecryptError('encrypted backup is truncated');
  }
  const salt = blob.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = blob.subarray(MAGIC.length + SALT_LEN, headerLen);
  const ciphertext = blob.subarray(headerLen, blob.length - TAG_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const key = deriveKey(passphrase, salt);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.concat([MAGIC, salt]));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // Deliberately vague: wrong passphrase and tampering are indistinguishable
    // to the caller, and the error must not leak key material.
    throw new BackupDecryptError('decryption failed: wrong passphrase or corrupted/tampered file');
  }
}
