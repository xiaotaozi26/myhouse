import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { getDb, type UserRow } from './db.ts';
import { SESSION_COOKIE, SESSION_TTL_MS } from './config.ts';

// ---------- password hashing (node:crypto scrypt, no native deps) ----------

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const i = stored.indexOf(':');
  if (i < 0) return false;
  const salt = stored.slice(0, i);
  const refHex = stored.slice(i + 1);
  try {
    const ref = Buffer.from(refHex, 'hex');
    const test = scryptSync(password, salt, 64);
    return ref.length === test.length && timingSafeEqual(ref, test);
  } catch {
    return false;
  }
}

// ---------- sessions ----------

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function createSession(userId: number): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  getDb()
    .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, new Date().toISOString(), expiresAt);
  return { token, expiresAt };
}

export function destroySession(token: string): void {
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function parseCookies(req: Request): Record<string, string> {
  const raw = req.headers.cookie;
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function getSessionUser(req: Request): UserRow | null {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const row = getDb()
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(sha256(token), new Date().toISOString()) as UserRow | undefined;
  return row ?? null;
}

export function setSessionCookie(res: Response, token: string, expiresAt: string): void {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}`,
  );
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ---------- middleware ----------

export interface AuthedRequest extends Request {
  user: UserRow;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: '未登录' });
    return;
  }
  (req as AuthedRequest).user = user;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: '未登录' });
    return;
  }
  if (user.role !== 'admin') {
    res.status(403).json({ error: '需要管理员权限' });
    return;
  }
  (req as AuthedRequest).user = user;
  next();
}
