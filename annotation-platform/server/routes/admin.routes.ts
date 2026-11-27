import express from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db.ts';
import { hashPassword, requireAdmin, type AuthedRequest } from '../auth.ts';
import { TASKS, TASK_KEYS, MODES, type Mode, type TaskKey } from '../config.ts';
import { importBatch, listBatches, listIncoming } from '../services/batch.service.ts';
import { confirmDelivery, deliveryProgress, setDeliveryTasks } from '../services/delivery.service.ts';
import {
  createAssignments,
  deleteAssignment,
  updateAssignments,
  listAssignments,
  listResults,
  resultFilePath,
} from '../services/assignment.service.ts';

export const adminRouter = express.Router();
adminRouter.use(requireAdmin);

// ---------- users ----------

adminRouter.get('/users', (_req: Request, res: Response) => {
  const users = getDb()
    .prepare('SELECT id, username, display_name, role, created_at, supplier_id, work_role FROM users ORDER BY id')
    .all();
  res.json({ users });
});

adminRouter.post('/users', (req: Request, res: Response) => {
  const { username, password, display_name, role } = (req.body ?? {}) as Record<string, string>;
  if (!username || !password || !display_name) {
    res.status(400).json({ error: '缺少 username / password / display_name' });
    return;
  }
  if (!/^[\w.\-]{2,32}$/.test(username)) {
    res.status(400).json({ error: '用户名需为 2–32 位字母数字或 . _ -' });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: '密码至少 6 位' });
    return;
  }
  if (role !== 'admin' && role !== 'annotator') {
    res.status(400).json({ error: '角色非法' });
    return;
  }
  const supplierId = Number(req.body.supplierId) || null;
  const workRole = req.body.workRole || 'legacy';
  if (!['legacy', 'annotation', 'review', 'supplier_manager'].includes(workRole) ||
      (workRole === 'legacy' && supplierId !== null) ||
      (workRole !== 'legacy' && (role !== 'annotator' || !supplierId ||
        !getDb().prepare('SELECT 1 FROM suppliers WHERE id = ?').get(supplierId)))) {
    res.status(400).json({ error: '供应商账号须选择有效供应商及岗位' });
    return;
  }
  const exists = getDb().prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) {
    res.status(409).json({ error: '用户名已存在' });
    return;
  }
  const r = getDb()
    .prepare('INSERT INTO users (username, password_hash, display_name, role, created_at, supplier_id, work_role) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(username, hashPassword(password), display_name, role, new Date().toISOString(), supplierId, workRole);
  res.json({ id: Number(r.lastInsertRowid) });
});

adminRouter.delete('/users/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const self = (req as AuthedRequest).user;
  if (id === self.id) {
    res.status(400).json({ error: '不能删除自己' });
    return;
  }
  const target = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as { role: string } | undefined;
  if (!target) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }
  const assignments = getDb().prepare('SELECT COUNT(*) AS n FROM assignments WHERE assignee_id = ?').get(id) as { n: number };
  if (assignments.n > 0) {
    res.status(400).json({ error: `该用户有 ${assignments.n} 条分配，先移除分配再删除` });
    return;
  }
  if (getDb().prepare('SELECT 1 FROM assignment_reviews WHERE reviewer_id = ? UNION ALL SELECT 1 FROM review_versions WHERE author_id = ? LIMIT 1').get(id, id)) {
    res.status(400).json({ error: '此账号已参与复核，须保留账号和历史记录' });
    return;
  }
  if (target.role === 'admin') {
    const admins = getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number };
    if (admins.n <= 1) {
      res.status(400).json({ error: '不能删除最后一个管理员' });
      return;
    }
  }
  getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  res.json({ ok: true });
});

// ---------- batches ----------

adminRouter.get('/incoming', (_req: Request, res: Response) => {
  res.json({ dirs: listIncoming() });
});

adminRouter.post('/batches/import', async (req: Request, res: Response) => {
  const { dir } = (req.body ?? {}) as { dir?: string };
  if (!dir) {
    res.status(400).json({ error: '缺少目录名' });
    return;
  }
  try {
    const summary = await importBatch(dir);
    res.json(summary);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

adminRouter.get('/batches', (_req: Request, res: Response) => {
  res.json({ batches: listBatches() });
});

adminRouter.get('/batches/:id/items', (req: Request, res: Response) => {
  const batchId = String(req.params.id);
  const items = getDb()
    .prepare('SELECT * FROM batch_items WHERE batch_id = ? ORDER BY lang DESC, title')
    .all(batchId);
  res.json({ items });
});

adminRouter.get('/batches/:id/progress', (req: Request, res: Response) => {
  const batchId = String(req.params.id);
  const items = getDb().prepare('SELECT item_id, second_review FROM batch_items WHERE batch_id = ?').all(batchId) as Array<{
    item_id: string;
    second_review: number;
  }>;
  const totalPrimary = items.length;
  const totalOverlap = items.filter((i) => i.second_review).length;
  const assignments = listAssignments({ batchId });

  const byTask: Record<string, { primary: ProgCell; overlap: ProgCell }> = {};
  for (const t of TASK_KEYS) {
    byTask[t] = {
      primary: { total: totalPrimary, assigned: 0, submitted: 0 },
      overlap: { total: totalOverlap, assigned: 0, submitted: 0 },
    };
  }
  // Older data can contain several assignees for a slot. Count each episode once.
  const eligibleOverlap = new Set(items.filter((item) => item.second_review).map((item) => item.item_id));
  const slots = new Map<string, boolean>();
  for (const a of assignments) {
    if (!TASK_KEYS.includes(a.task as TaskKey) || !MODES.includes(a.mode as Mode)) continue;
    if (a.mode === 'overlap' && !eligibleOverlap.has(a.item_id)) continue;
    const key = JSON.stringify([a.task, a.mode, a.item_id]);
    slots.set(key, slots.get(key) || a.status === 'submitted');
  }
  for (const [key, submitted] of slots) {
    const [task, mode] = JSON.parse(key) as [TaskKey, Mode];
    const cell = byTask[task][mode];
    cell.assigned += 1;
    if (submitted) cell.submitted += 1;
  }
  res.json({ batchId, items: totalPrimary, overlapItems: totalOverlap, byTask });
});

interface ProgCell {
  total: number;
  assigned: number;
  submitted: number;
}

// ---------- assignments ----------

adminRouter.get('/assignments', (req: Request, res: Response) => {
  const q = req.query as { batchId?: string; task?: string; mode?: string; assigneeId?: string };
  res.json({
    assignments: listAssignments({
      batchId: q.batchId,
      task: q.task as TaskKey | undefined,
      mode: q.mode as Mode | undefined,
      assigneeId: q.assigneeId ? Number(q.assigneeId) : undefined,
    }),
  });
});

adminRouter.post('/assignments', (req: Request, res: Response) => {
  const { batchId, task, mode, itemIds, assigneeId, allocations, priority } = (req.body ?? {}) as Record<string, unknown>;
  try {
    const entries = allocations === undefined ? [{ task, assigneeId: Number(assigneeId) }] : allocations;
    const r = createAssignments(
      batchId as string,
      (mode ?? 'primary') as Mode,
      itemIds as string[],
      entries as { task: TaskKey; assigneeId: number; reviewerId?: number }[],
      priority,
    );
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

adminRouter.post('/assignments/bulk', (req: Request, res: Response) => {
  try {
    const { ids, action, priority } = req.body ?? {};
    res.json(updateAssignments(ids, action, priority));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

adminRouter.delete('/assignments/:id', (req: Request, res: Response) => {
  try {
    deleteAssignment(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ---------- results ----------

adminRouter.get('/batches/:id/delivery', (req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'no-store').json(deliveryProgress(String(req.params.id)));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

adminRouter.post('/batches/:id/delivery/confirm', (req, res) => {
  try {
    res.json(confirmDelivery(String(req.params.id), req.body?.itemId, req.body?.manifest, (req as unknown as AuthedRequest).user.id));
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

adminRouter.put('/batches/:id/delivery', (req: Request, res: Response) => {
  try {
    setDeliveryTasks(String(req.params.id), req.body?.tasks);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

adminRouter.get('/results', (req: Request, res: Response) => {
  const batchId = req.query.batchId as string | undefined;
  res.json({ results: listResults(batchId) });
});

adminRouter.get('/results/:id/download', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const kind = (req.query.kind as string) === 'timing' ? 'timing' : 'result';
  const p = resultFilePath(id, kind);
  if (!p) {
    res.status(404).json({ error: '文件不存在' });
    return;
  }
  res.download(p);
});
