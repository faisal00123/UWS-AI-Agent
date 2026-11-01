/**
 * Authentication: users, sessions, login rate limiting, password changes.
 *
 * Security properties:
 *   - passwords hashed with scrypt (see core/password.ts)
 *   - session cookies carry an opaque random token; only its SHA-256 is stored
 *   - login attempts are rate limited per email AND per IP (both enforced in
 *     the database so a restart does not reset the counter)
 *   - failed logins increment a per-account counter; over the threshold the
 *     account is temporarily locked
 *   - IP addresses are stored only as HMAC hashes (peppered), never in clear
 */
import { createHash, createHmac } from 'node:crypto';
import type { DB } from '../../db/index.ts';
import type { Config } from '../../core/config.ts';
import { AppError } from '../../core/errors.ts';
import { newId, newToken } from '../../core/ids.ts';
import { nowIso } from '../../core/time.ts';
import {
  checkPasswordPolicy,
  hashPassword,
  verifyPassword,
} from '../../core/password.ts';
import { recordAudit } from '../audit/service.ts';

export type Role = 'owner' | 'staff';

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  isActive: boolean;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: Role;
  password_hash: string;
  must_change_password: number;
  is_active: number;
  failed_login_count: number;
  locked_until: string | null;
  last_login_at: string | null;
}

export function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    role: u.role,
    isActive: u.is_active === 1,
    lastLoginAt: u.last_login_at,
    mustChangePassword: u.must_change_password === 1,
  };
}

export function hashIp(ip: string, pepper: string): string {
  return createHmac('sha256', pepper).update(ip).digest('hex').slice(0, 32);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SessionInfo {
  id: string;
  userId: string;
  csrfSecret: string;
  expiresAt: string;
  /** Short-lived grant set after successful password re-entry. */
  reauthUntil: string | null;
}

export interface CreatedSession {
  token: string;
  csrfToken: string;
  expiresAt: string;
}

const ACCOUNT_LOCK_THRESHOLD = 10;

export async function createSession(
  db: DB,
  cfg: Config,
  userId: string,
  meta: { ipHash: string | null; userAgent: string | null },
): Promise<CreatedSession> {
  const token = newToken(32);
  const id = hashToken(token);
  const csrfSecret = newToken(24);
  const now = new Date();
  const expires = new Date(now.getTime() + cfg.sessionTtlHours * 3600_000);
  db.prepare(
    `INSERT INTO sessions (id, user_id, csrf_secret, created_at, expires_at, last_seen_at, ip_hash, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, csrfSecret, now.toISOString(), expires.toISOString(), now.toISOString(), meta.ipHash, meta.userAgent?.slice(0, 200) ?? null);
  return { token, csrfToken: csrfToken(csrfSecret, id), expiresAt: expires.toISOString() };
}

/** CSRF token is bound to the session so a leaked token from another session is useless. */
export function csrfToken(csrfSecret: string, sessionId: string): string {
  return createHmac('sha256', csrfSecret).update(sessionId).digest('base64url');
}

export function verifyCsrfToken(session: SessionInfo, provided: string | undefined): boolean {
  if (!provided) return false;
  const expected = csrfToken(session.csrfSecret, session.id);
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export interface LoadedSession {
  session: SessionInfo;
  user: PublicUser;
}

export function loadSession(db: DB, token: string): LoadedSession | null {
  const id = hashToken(token);
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
    | {
        id: string;
        user_id: string;
        csrf_secret: string;
        expires_at: string;
        last_seen_at: string;
        reauth_until: string | null;
      }
    | undefined;
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return null;
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id) as UserRow | undefined;
  if (!user || user.is_active !== 1) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return null;
  }
  // Touch at most every 60s to avoid a write per request.
  if (Date.now() - Date.parse(row.last_seen_at) > 60_000) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(nowIso(), id);
  }
  return {
    session: {
      id: row.id,
      userId: row.user_id,
      csrfSecret: row.csrf_secret,
      expiresAt: row.expires_at,
      reauthUntil: row.reauth_until ?? null,
    },
    user: toPublicUser(user),
  };
}

/** Re-authentication window for sensitive actions (Section 3.8). */
export const REAUTH_WINDOW_MS = 5 * 60_000;

export function grantReauth(db: DB, sessionId: string): string {
  const until = new Date(Date.now() + REAUTH_WINDOW_MS).toISOString();
  db.prepare('UPDATE sessions SET reauth_until = ? WHERE id = ?').run(until, sessionId);
  return until;
}

export function hasRecentReauth(session: SessionInfo): boolean {
  return Boolean(session.reauthUntil && Date.parse(session.reauthUntil) > Date.now());
}

export function destroySession(db: DB, token: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(token));
}

export function destroyOtherSessions(db: DB, userId: string, keepSessionId?: string): number {
  const res = keepSessionId
    ? db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(userId, keepSessionId)
    : db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return Number(res.changes);
}

function countRecent(
  db: DB,
  column: 'email' | 'ip_hash',
  value: string,
  sinceIso: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) c FROM login_attempts WHERE ${column} = ? AND succeeded = 0 AND created_at >= ?`,
    )
    .get(value, sinceIso) as { c: number };
  return row.c;
}

export interface LoginInput {
  email: string;
  password: string;
  ipHash: string;
  userAgent: string | null;
}

export interface LoginSuccess {
  user: PublicUser;
  session: CreatedSession;
}

export function recordLoginAttempt(
  db: DB,
  email: string,
  ipHash: string,
  succeeded: boolean,
  reason: string | null,
): void {
  db.prepare(
    'INSERT INTO login_attempts (email, ip_hash, succeeded, reason, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(email, ipHash, succeeded ? 1 : 0, reason, nowIso());
}

export async function login(db: DB, cfg: Config, input: LoginInput): Promise<LoginSuccess> {
  const email = input.email.trim();
  const windowSince = new Date(Date.now() - cfg.login.windowMinutes * 60_000).toISOString();

  const emailFails = countRecent(db, 'email', email, windowSince);
  const ipFails = countRecent(db, 'ip_hash', input.ipHash, windowSince);
  // Per-account lockout is tight; the shared-IP threshold is higher so that
  // many people behind one NAT cannot lock each other out (Section 3.8).
  if (emailFails >= cfg.login.maxAttempts || ipFails >= cfg.login.maxAttempts * 3) {
    recordLoginAttempt(db, email, input.ipHash, false, 'rate_limited');
    throw new AppError(
      'rate_limited',
      `Too many failed sign-in attempts. Try again in ${cfg.login.lockMinutes} minute(s).`,
      { retryAfterMinutes: cfg.login.lockMinutes },
    );
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;

  if (user && user.locked_until && Date.parse(user.locked_until) > Date.now()) {
    recordLoginAttempt(db, email, input.ipHash, false, 'account_locked');
    throw new AppError('rate_limited', 'Account temporarily locked due to failed sign-ins.');
  }

  // Always run a verification to keep timing characteristics similar when the
  // account does not exist.
  const stored = user?.password_hash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA';
  const result = await verifyPassword(input.password, stored);

  if (!user || !result.valid || user.is_active !== 1) {
    recordLoginAttempt(db, email, input.ipHash, false, !user ? 'unknown_email' : 'bad_password');
    if (user && user.is_active === 1) {
      const fails = user.failed_login_count + 1;
      const lock = fails >= ACCOUNT_LOCK_THRESHOLD;
      db.prepare(
        `UPDATE users SET failed_login_count = ?, locked_until = ?, updated_at = ? WHERE id = ?`,
      ).run(fails, lock ? new Date(Date.now() + cfg.login.lockMinutes * 60_000).toISOString() : user.locked_until, nowIso(), user.id);
    }
    throw new AppError('unauthenticated', 'Incorrect email or password.');
  }

  // Successful login: reset counters, upgrade weak hashes, record the event.
  const needsRehash = result.needsRehash;
  const newHash = needsRehash ? await hashPassword(input.password, cfg.scryptN) : null;
  db.prepare(
    `UPDATE users
        SET failed_login_count = 0,
            locked_until = NULL,
            last_login_at = ?,
            password_hash = COALESCE(?, password_hash),
            updated_at = ?
      WHERE id = ?`,
  ).run(nowIso(), newHash, nowIso(), user.id);
  recordLoginAttempt(db, email, input.ipHash, true, null);

  const session = await createSession(db, cfg, user.id, {
    ipHash: input.ipHash,
    userAgent: input.userAgent,
  });
  recordAudit(db, {
    actorUserId: user.id,
    actorLabel: user.role,
    action: 'auth.login',
    entityType: 'user',
    entityId: user.id,
    summary: `User ${user.email} signed in`,
    ipHash: input.ipHash,
  });
  return { user: toPublicUser({ ...user, last_login_at: nowIso() }), session };
}

export interface CreateUserInput {
  email: string;
  password: string;
  displayName: string;
  role: Role;
  mustChangePassword?: boolean;
}

export async function createUser(
  db: DB,
  cfg: Config,
  input: CreateUserInput,
  actor: { userId: string | null; label: 'owner' | 'system' | 'staff' },
): Promise<PublicUser> {
  const email = input.email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AppError('validation_failed', 'A valid email address is required');
  }
  if (input.role !== 'owner' && actor.label !== 'owner') {
    throw new AppError('forbidden', 'Only the owner may create staff accounts');
  }
  const policy = checkPasswordPolicy(input.password);
  if (!policy.ok) {
    throw new AppError('validation_failed', `Password ${policy.problems.join(', ')}`, {
      problems: policy.problems,
    });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) throw new AppError('conflict', 'An account with that email already exists');

  const id = newId('usr');
  const hash = await hashPassword(input.password, cfg.scryptN);
  const at = nowIso();
  db.prepare(
    `INSERT INTO users (id, email, display_name, role, password_hash, must_change_password, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    email,
    input.displayName.trim(),
    input.role,
    hash,
    input.mustChangePassword ? 1 : 0,
    at,
    at,
  );
  recordAudit(db, {
    actorUserId: actor.userId,
    actorLabel: actor.label,
    action: 'user.create',
    entityType: 'user',
    entityId: id,
    summary: `Created ${input.role} account for ${email}`,
  });
  return {
    id,
    email,
    displayName: input.displayName.trim(),
    role: input.role,
    isActive: true,
    lastLoginAt: null,
    mustChangePassword: input.mustChangePassword ?? false,
  };
}

export async function changePassword(
  db: DB,
  cfg: Config,
  userId: string,
  currentPassword: string,
  newPassword: string,
  keepSessionId: string | null,
): Promise<{ revokedSessions: number }> {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
  if (!user) throw new AppError('not_found', 'User not found');
  const check = await verifyPassword(currentPassword, user.password_hash);
  if (!check.valid) throw new AppError('unauthenticated', 'Current password is incorrect');
  const policy = checkPasswordPolicy(newPassword);
  if (!policy.ok) {
    throw new AppError('validation_failed', `Password ${policy.problems.join(', ')}`, {
      problems: policy.problems,
    });
  }
  const hash = await hashPassword(newPassword, cfg.scryptN);
  db.prepare(
    `UPDATE users SET password_hash = ?, password_changed_at = ?, must_change_password = 0, updated_at = ? WHERE id = ?`,
  ).run(hash, nowIso(), nowIso(), userId);
  // Password change invalidates every other session.
  const revoked = destroyOtherSessions(db, userId, keepSessionId ?? undefined);
  recordAudit(db, {
    actorUserId: userId,
    actorLabel: user.role,
    action: 'user.password_change',
    entityType: 'user',
    entityId: userId,
    summary: 'Password changed; other sessions revoked',
    details: { revokedSessions: revoked },
  });
  return { revokedSessions: revoked };
}

export function listUsers(db: DB): PublicUser[] {
  const rows = db
    .prepare('SELECT * FROM users ORDER BY created_at')
    .all() as unknown as UserRow[];
  return rows.map(toPublicUser);
}

export function countOwners(db: DB): number {
  const row = db
    .prepare(`SELECT COUNT(*) c FROM users WHERE role = 'owner' AND is_active = 1`)
    .get() as { c: number };
  return row.c;
}

export function purgeExpiredSessions(db: DB): number {
  const res = db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());
  return Number(res.changes);
}
