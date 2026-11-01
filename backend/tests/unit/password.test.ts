import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPasswordPolicy,
  hashPassword,
  verifyPassword,
  PASSWORD_MIN_LENGTH,
} from '../../src/core/password.ts';

describe('password hashing (scrypt)', () => {
  test('hash verifies and rejects wrong passwords', async () => {
    const hash = await hashPassword('Correct-Horse-9!', 1024);
    assert.ok(hash.startsWith('scrypt$1024$8$1$'), 'hash records parameters');
    const good = await verifyPassword('Correct-Horse-9!', hash);
    assert.equal(good.valid, true);
    const bad = await verifyPassword('correct-horse-9!', hash);
    assert.equal(bad.valid, false);
  });

  test('two hashes of the same password differ (unique salt)', async () => {
    const a = await hashPassword('Same-Password-1!', 1024);
    const b = await hashPassword('Same-Password-1!', 1024);
    assert.notEqual(a, b);
    assert.equal((await verifyPassword('Same-Password-1!', a)).valid, true);
    assert.equal((await verifyPassword('Same-Password-1!', b)).valid, true);
  });

  test('corrupted or malformed stored hashes never validate', async () => {
    for (const stored of ['', 'plaintext', 'scrypt$abc', 'bcrypt$1$2$3$4$5', 'scrypt$1024$8$1$!!!$!!!']) {
      const r = await verifyPassword('whatever', stored);
      assert.equal(r.valid, false, `must reject: ${JSON.stringify(stored)}`);
    }
  });

  test('weak parameters are flagged for rehash on successful login', async () => {
    const weak = await hashPassword('Rehash-Me-99!', 1024);
    const r = await verifyPassword('Rehash-Me-99!', weak);
    assert.equal(r.valid, true);
    assert.equal(r.needsRehash, true, 'N < 16384 must be upgraded');
  });

  test('policy requires adequate length and complexity', () => {
    assert.equal(checkPasswordPolicy('short').ok, false);
    assert.equal(checkPasswordPolicy('a'.repeat(PASSWORD_MIN_LENGTH)).ok, false);
    assert.equal(checkPasswordPolicy('password').ok, false);
    assert.equal(checkPasswordPolicy('Tr0ub4dor&3xyz').ok, true);
    assert.equal(checkPasswordPolicy('correct horse battery staple fact').ok, true, 'long passphrases pass');
    const r = checkPasswordPolicy('abc');
    assert.ok(r.problems.length > 0);
  });
});
