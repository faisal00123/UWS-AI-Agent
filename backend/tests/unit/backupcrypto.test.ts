/**
 * Unit tests: backup file encryption (Phase 9).
 *
 * The passphrase protects backup files that contain personal data, so every
 * failure mode must be loud: a wrong passphrase, a flipped bit or a stripped
 * header must ALL fail decryption — never "succeed" with wrong bytes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  encryptBuffer,
  decryptBuffer,
  isEncryptedBuffer,
  BackupDecryptError,
} from '../../src/domain/backup/crypto.ts';

const PASS = 'correct horse battery staple';

test('roundtrip: encrypt then decrypt returns the original bytes', () => {
  const plain = randomBytes(4096);
  const blob = encryptBuffer(plain, PASS);
  assert.ok(!blob.equals(plain), 'ciphertext differs from plaintext');
  assert.ok(isEncryptedBuffer(blob), 'encrypted buffer carries the UWSBK1 magic');
  assert.ok(!isEncryptedBuffer(plain), 'a plaintext SQLite buffer is not detected as encrypted');
  assert.ok(decryptBuffer(blob, PASS).equals(plain));
});

test('roundtrip: a known plaintext marker is absent from the ciphertext', () => {
  const plain = Buffer.from('lead: ALICE KHAN, phone: +923001234567, email: alice@example.pk', 'utf8');
  const blob = encryptBuffer(plain, PASS);
  assert.equal(blob.includes(Buffer.from('ALICE KHAN')), false, 'no name in ciphertext');
  assert.equal(blob.includes(Buffer.from('+923001234567')), false, 'no phone in ciphertext');
  assert.equal(blob.includes(Buffer.from('alice@example.pk')), false, 'no email in ciphertext');
  assert.ok(decryptBuffer(blob, PASS).toString('utf8').includes('alice@example.pk'));
});

test('a wrong passphrase fails decryption with BackupDecryptError', () => {
  const blob = encryptBuffer(randomBytes(2048), PASS);
  assert.throws(() => decryptBuffer(blob, 'wrong passphrase'), BackupDecryptError);
  // An EMPTY passphrase must also fail, not silently produce garbage.
  assert.throws(() => decryptBuffer(blob, ''), BackupDecryptError);
});

test('a single flipped bit anywhere in the file fails decryption', () => {
  const blob = encryptBuffer(randomBytes(2048), PASS);
  for (const pos of [0, 6, 20, Math.floor(blob.length / 2), blob.length - 17, blob.length - 1]) {
    const tampered = Buffer.from(blob);
    tampered[pos] = (tampered[pos] ?? 0) ^ 0x01;
    assert.throws(() => decryptBuffer(tampered, PASS), BackupDecryptError, `tamper at ${pos} must fail`);
  }
});

test('truncation fails decryption', () => {
  const blob = encryptBuffer(randomBytes(2048), PASS);
  assert.throws(() => decryptBuffer(blob.subarray(0, 40), PASS), BackupDecryptError);
});

test('a non-UWSBK1 buffer is rejected as not-encrypted', () => {
  const sqliteHeader = Buffer.concat([Buffer.from('SQLite format 3\0', 'ascii'), randomBytes(64)]);
  assert.throws(() => decryptBuffer(sqliteHeader, PASS), BackupDecryptError);
  assert.equal(isEncryptedBuffer(sqliteHeader), false);
});

test('encryptBuffer refuses an empty passphrase', () => {
  assert.throws(() => encryptBuffer(randomBytes(16), ''), /non-empty passphrase/);
});
