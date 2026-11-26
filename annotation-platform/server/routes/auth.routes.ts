import express from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db.ts';
import {
  clearSessionCookie,
  createSession,
  destroySession,
  getSessionUser,
  hashPassword,
  requireAuth,
  setSessionCookie,
  verifyPassword,
  type AuthedRequest,
} from '../auth.ts';

export const authRouter = express.Router();

authRouter.post('/login', (req: Request, res: Response) => {
  const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
  if (!username || !password) {
    res.status(400).json({ error: '缺少用户名或密码' });
    return;
  }
  const user = getDb().prepare('SELECT * FROM users WHERE username = ?').get(username) as
    | { id: number; password_hash: string; username: string; display_name: string; role: string }
    | undefined;
  if (!user || !verifyPassword(password, user.password_hash)) {
    res.status(401).json({ error: '用户名或密码错误' });
    return;
  }
  const { token, expiresAt } = createSession(user.id);
  setSessionCookie(res, token, expiresAt);
  res.json({ user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role } });
});

authRouter.post('/logout', (req: Request, res: Response) => {
  const cookie = (req.headers.cookie ?? '').split(';').map((s) => s.trim());
  const sid = cookie
    .map((c) => c.split('='))
    .find(([k]) => k === 'dap_session');
  if (sid && sid[1]) destroySession(decodeURIComponent(sid[1]));
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get('/me', (req: Request, res: Response) => {
  const user = getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: '未登录' });
    return;
  }
  res.json({ user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role } });
});

authRouter.post('/change-password', requireAuth, (req: Request, res: Response) => {
  const { current, next } = (req.body ?? {}) as { current?: string; next?: string };
  const u = (req as AuthedRequest).user;
  if (!current || !next || next.length < 6) {
    res.status(400).json({ error: '新密码至少 6 位' });
    return;
  }
  if (!verifyPassword(current, u.password_hash)) {
    res.status(401).json({ error: '当前密码错误' });
    return;
  }
  getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), u.id);
  res.json({ ok: true });
});
