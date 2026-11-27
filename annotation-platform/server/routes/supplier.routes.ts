import express from 'express';
import { requireAuth, requireAdmin, type AuthedRequest } from '../auth.ts';
import { getDb, transaction } from '../db.ts';
import { TASK_KEYS } from '../config.ts';
import { deliveryProgress } from '../services/delivery.service.ts';

export const supplierRouter = express.Router();
supplierRouter.use(requireAuth);
const actor = (req: express.Request) => (req as AuthedRequest).user;
const timestamp = () => new Date().toISOString();
const rank = "CASE j.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END";
const fromJobs = `FROM supplier_jobs j JOIN batch_items i USING (batch_id,item_id)
  LEFT JOIN assignments a ON a.id = j.assignment_id
  LEFT JOIN assignment_reviews w ON w.assignment_id = a.id
  LEFT JOIN users writer ON writer.id = a.assignee_id
  LEFT JOIN users reader ON reader.id = w.reviewer_id
  LEFT JOIN review_versions v ON v.assignment_id = a.id AND v.version = w.version`;
const jobFields = `j.*, i.title, a.assignee_id, a.status, a.assigned_at, w.state, w.reviewer_id, w.version,
  writer.display_name AS annotator, reader.display_name AS reviewer, v.created_at AS last_event, v.kind, v.note`;
const annotationLimit = Number(process.env.ANNOTATION_ACTIVE_LIMIT || 3);
const reviewLimit = Number(process.env.REVIEW_ACTIVE_LIMIT || 3);

supplierRouter.get('/', requireAdmin, (_req, res) => {
  res.json({ suppliers: getDb().prepare('SELECT * FROM suppliers ORDER BY name').all() });
});

supplierRouter.post('/', requireAdmin, (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 80) { res.status(400).json({ error: '请输入 1–80 字的供应商名称' }); return; }
  const result = getDb().prepare('INSERT INTO suppliers(name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(name);
  if (!result.changes) { res.status(409).json({ error: '供应商已存在' }); return; }
  res.json({ id: Number(result.lastInsertRowid) });
});

supplierRouter.post('/dispatch', requireAdmin, (req, res) => {
  try {
    const { batchId, itemIds, tasks, supplierId, priority, preview } = req.body ?? {};
    if (typeof batchId !== 'string' || !Array.isArray(itemIds) || !itemIds.length ||
        itemIds.some(id => typeof id !== 'string') || !Array.isArray(tasks) || !tasks.length ||
        tasks.some(task => !TASK_KEYS.includes(task)) || !Number.isSafeInteger(supplierId) ||
        !['normal', 'high', 'urgent'].includes(priority)) throw new Error('请选择供应商、批次、剧集、任务和优先级');
    const result = transaction(db => {
      if (!db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(supplierId)) throw new Error('供应商不存在');
      const item = db.prepare('SELECT title FROM batch_items WHERE batch_id = ? AND item_id = ?');
      const existing = db.prepare("SELECT 1 FROM assignments WHERE batch_id = ? AND item_id = ? AND task = ? AND mode = 'primary'");
      const occupied = db.prepare('SELECT 1 FROM supplier_jobs WHERE batch_id = ? AND item_id = ? AND task = ?');
      const insert = db.prepare(`INSERT INTO supplier_jobs(supplier_id,batch_id,item_id,task,priority,dispatched_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(batch_id,item_id,task) DO NOTHING`);
      let created = 0;
      const skipped = [];
      for (const id of new Set<string>(itemIds)) {
        const episode = item.get(batchId, id);
        if (!episode) throw new Error('所选剧集不属于该批次');
        for (const task of new Set<string>(tasks)) {
          if (existing.get(batchId, id, task) || occupied.get(batchId, id, task)) {
            skipped.push({ itemId: id, title: episode.title, task });
          } else {
            if (preview !== true) insert.run(supplierId, batchId, id, task, priority, timestamp());
            created++;
          }
        }
      }
      return { created, skipped };
    });
    res.json(result);
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

supplierRouter.get('/pool', (req, res) => {
  const user = actor(req);
  if (!user.supplier_id || !['annotation', 'review'].includes(user.work_role)) {
    res.status(403).json({ error: '需要供应商标注或审核账号' }); return;
  }
  const db = getDb();
  const rows = user.work_role === 'annotation'
    ? db.prepare(`SELECT ${jobFields} ${fromJobs} WHERE j.supplier_id = ? AND a.id IS NULL ORDER BY ${rank}, j.dispatched_at, j.id`).all(user.supplier_id)
    : db.prepare(`SELECT ${jobFields} ${fromJobs} WHERE j.supplier_id = ? AND a.assignee_id != ?
        AND (w.state = 'unassigned' OR (w.state = 'review' AND w.reviewer_id = ? AND j.review_started_at IS NULL))
        ORDER BY ${rank}, v.created_at, j.id`).all(user.supplier_id, user.id, user.id);
  res.json({ jobs: rows });
});

supplierRouter.post('/jobs/:id/claim', (req, res) => {
  const user = actor(req);
  try {
    if (!user.supplier_id || !['annotation', 'review'].includes(user.work_role)) throw new Error('当前账号无权领取');
    const result = transaction(db => {
      const job = db.prepare(`SELECT ${jobFields} ${fromJobs} WHERE j.id = ? AND j.supplier_id = ?`)
        .get(Number(req.params.id), user.supplier_id);
      if (!job) throw new Error('找不到本组织的作业');
      const id = Number(job.id);
      if (user.work_role === 'annotation') {
        if (job.assignee_id === user.id && job.status === 'assigned') return { assignmentId: job.assignment_id };
        if (job.assignment_id) throw new Error('作业已被领取');
        const active = db.prepare(`SELECT COUNT(*) AS n FROM assignments a
          LEFT JOIN assignment_reviews w ON w.assignment_id = a.id
          WHERE a.assignee_id = ? AND (a.status = 'assigned' OR w.state = 'rework')`).get(user.id);
        if (Number(active?.n) >= annotationLimit) throw new Error(`在做标注及返修已达 ${annotationLimit} 份，请先处理手上的作业`);
        const a = db.prepare(`INSERT INTO assignments(batch_id,task,mode,item_id,assignee_id,priority,assigned_at)
          VALUES (?,?,'primary',?,?,?,?)`).run(job.batch_id, job.task, job.item_id, user.id, job.priority, timestamp());
        db.prepare('UPDATE supplier_jobs SET assignment_id = ? WHERE id = ?').run(a.lastInsertRowid, id);
        return { assignmentId: Number(a.lastInsertRowid) };
      }
      if (job.assignee_id === user.id) throw new Error('不能审核自己标注的作业');
      if (job.state === 'review' && job.reviewer_id === user.id && job.review_started_at) return { assignmentId: job.assignment_id };
      if (job.state !== 'unassigned' && !(job.state === 'review' && job.reviewer_id === user.id)) throw new Error('审核作业已被领取或已流转');
      const active = db.prepare(`SELECT COUNT(*) AS n FROM assignment_reviews w JOIN supplier_jobs j ON j.assignment_id = w.assignment_id
        WHERE w.state = 'review' AND w.reviewer_id = ? AND j.review_started_at IS NOT NULL`).get(user.id);
      if (Number(active?.n) >= reviewLimit) throw new Error(`在审作业已达 ${reviewLimit} 份，请先完成现有审核`);
      db.prepare("UPDATE assignment_reviews SET reviewer_id = ?, state = 'review' WHERE assignment_id = ?").run(user.id, job.assignment_id);
      db.prepare('UPDATE supplier_jobs SET review_started_at = ? WHERE id = ?').run(timestamp(), id);
      return { assignmentId: job.assignment_id };
    });
    res.json(result);
  } catch (error) { res.status(409).json({ error: (error as Error).message }); }
});

supplierRouter.post('/jobs/:id/release', (req, res) => {
  const user = actor(req);
  try {
    transaction(db => {
      const job = db.prepare(`SELECT ${jobFields} ${fromJobs} WHERE j.id = ? AND j.supplier_id = ?`)
        .get(Number(req.params.id), user.supplier_id);
      if (!job || job.assignee_id !== user.id || job.status !== 'assigned' || job.started_at) {
        throw new Error('仅可释放本人已领取且尚未打开的作业');
      }
      db.prepare('DELETE FROM assignments WHERE id = ?').run(job.assignment_id);
    });
    res.json({ ok: true });
  } catch (error) { res.status(409).json({ error: (error as Error).message }); }
});

supplierRouter.post('/jobs/:id/transfer', (req, res) => {
  const user = actor(req);
  if (user.role !== 'admin' && user.work_role !== 'supplier_manager') { res.sendStatus(403); return; }
  try {
    const nextId = Number(req.body?.nextId);
    const stage = req.body?.stage;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason || !['annotation','review'].includes(stage) || !Number.isSafeInteger(nextId)) throw new Error('请选择接手人并填写原因');
    transaction(db => {
      const job = db.prepare(`SELECT ${jobFields} ${fromJobs} WHERE j.id = ?`).get(Number(req.params.id));
      if (!job || (user.role !== 'admin' && job.supplier_id !== user.supplier_id)) throw new Error('找不到可转派的作业');
      if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND supplier_id = ? AND work_role = ?').get(nextId, job.supplier_id, stage)) {
        throw new Error('接手人须属于本供应商且岗位匹配');
      }
      const previous = stage === 'review' ? job.reviewer_id : job.assignee_id;
      if (previous === nextId) throw new Error('请改选其他人员');
      if (stage === 'review' && ['review','unassigned'].includes(String(job.state)) && job.assignee_id !== nextId) {
        db.prepare("UPDATE assignment_reviews SET reviewer_id = ?, state = 'review' WHERE assignment_id = ?").run(nextId, job.assignment_id);
        db.prepare('UPDATE supplier_jobs SET review_started_at = NULL WHERE id = ?').run(job.id);
      } else if (stage === 'annotation' && (job.status === 'assigned' || job.state === 'rework') && job.reviewer_id !== nextId) {
        db.prepare('UPDATE assignments SET assignee_id = ?, assigned_at = ? WHERE id = ?').run(nextId, timestamp(), job.assignment_id);
        db.prepare('UPDATE supplier_jobs SET started_at = ?, rework_started_at = NULL WHERE id = ?').run(timestamp(), job.id);
      } else throw new Error('当前状态或人员不允许转派');
      db.prepare(`INSERT INTO supplier_transfers(job_id,stage,previous_id,next_id,operator_id,reason,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(job.id, stage, previous, nextId, user.id, reason, timestamp());
    });
    res.json({ ok: true });
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

supplierRouter.get('/jobs/:id/checks', requireAdmin, (req, res) => {
  const rows = getDb().prepare(`SELECT c.*, u.display_name FROM company_checks c
    JOIN supplier_jobs j ON j.assignment_id = c.assignment_id LEFT JOIN users u ON u.id = c.actor_id
    WHERE j.id = ? ORDER BY c.id DESC`).all(Number(req.params.id));
  res.json({ checks: rows });
});

supplierRouter.post('/jobs/:id/checks', requireAdmin, (req, res) => {
  try {
    const { outcome, version } = req.body ?? {};
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!['pass','issue'].includes(outcome) || (outcome === 'issue' && !note)) throw new Error('请选择抽查结果，有问题时填写说明');
    transaction(db => {
      const job = db.prepare(`SELECT j.assignment_id, w.version FROM supplier_jobs j
        JOIN assignment_reviews w ON w.assignment_id = j.assignment_id
        WHERE j.id = ? AND w.state = 'approved'`).get(Number(req.params.id));
      if (!job || job.version !== version) throw new Error('待抽查稿件已变更，请刷新统计');
      db.prepare(`INSERT INTO company_checks(assignment_id, version, actor_id, outcome, note, created_at)
        VALUES (?,?,?,?,?,?)`).run(job.assignment_id, version, actor(req).id, outcome, note, timestamp());
    });
    res.json({ ok: true });
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

supplierRouter.get('/stats', (req, res) => {
  const user = actor(req);
  const org = user.role === 'admin' ? null : user.supplier_id;
  if (user.role !== 'admin' && (!org || user.work_role !== 'supplier_manager')) { res.sendStatus(403); return; }
  const db = getDb();
  const batches = db.prepare(`SELECT b.batch_id FROM batches b WHERE ? IS NULL OR EXISTS
    (SELECT 1 FROM supplier_jobs j WHERE j.batch_id = b.batch_id AND j.supplier_id = ?) ORDER BY b.id DESC`).all(org, org);
  const batch = batches.find(row => row.batch_id === req.query.batchId)?.batch_id ?? batches[0]?.batch_id;
  const suppliers = db.prepare('SELECT * FROM suppliers WHERE ? IS NULL OR id = ? ORDER BY name').all(org, org);
  const people = db.prepare(`SELECT id,display_name,supplier_id,work_role FROM users WHERE supplier_id IS NOT NULL
    AND (? IS NULL OR supplier_id = ?) ORDER BY display_name`).all(org, org);
  if (!batch) { res.json({ batches, suppliers, people, jobs: [], approved: [], episodes: [] }); return; }
  const jobs = db.prepare(`SELECT ${jobFields}, earliest.author_id AS first_author,
    verdict.kind AS first_verdict, verdict.author_id AS first_reviewer
    ${fromJobs}
    LEFT JOIN review_versions earliest ON earliest.assignment_id = a.id AND earliest.version = 1
    LEFT JOIN review_versions verdict ON verdict.assignment_id = a.id AND verdict.version = 2
    WHERE j.batch_id = ? AND (? IS NULL OR j.supplier_id = ?) ORDER BY ${rank}, j.dispatched_at`).all(batch, org, org);
  const audit = db.prepare(`SELECT j.id AS job_id, v.author_id, v.kind, t.elapsed_seconds FROM supplier_jobs j
    JOIN review_versions v ON v.assignment_id = j.assignment_id AND v.kind IN ('pass','fixed','return')
    LEFT JOIN supplier_review_timings t ON t.assignment_id = v.assignment_id AND t.version = v.version
    WHERE j.batch_id = ? AND (? IS NULL OR j.supplier_id = ?)`).all(batch, org, org);
  const delivery = org == null ? deliveryProgress(String(batch)) : null;
  const unallocated = org == null ? db.prepare(`WITH tasks(task) AS (VALUES ('people'),('assets'),('shots'),('story'))
    SELECT i.item_id,i.title,t.task,'unallocated' AS state FROM batch_items i CROSS JOIN tasks t
    WHERE i.batch_id = ? AND NOT EXISTS(SELECT 1 FROM supplier_jobs j WHERE j.batch_id = i.batch_id AND j.item_id = i.item_id AND j.task = t.task)
    AND NOT EXISTS(SELECT 1 FROM assignments a WHERE a.batch_id = i.batch_id AND a.item_id = i.item_id AND a.task = t.task AND a.mode = 'primary')`).all(batch) : [];
  const legacy = org == null ? db.prepare(`SELECT a.item_id, i.title, a.task, a.status, w.state, w.version AS review_version, a.assigned_at, a.priority,
    writer.display_name AS annotator, reader.display_name AS reviewer
    FROM assignments a JOIN batch_items i USING(batch_id,item_id) JOIN users writer ON writer.id = a.assignee_id
    LEFT JOIN assignment_reviews w ON w.assignment_id = a.id LEFT JOIN users reader ON reader.id = w.reviewer_id
    WHERE a.mode = 'primary' AND a.batch_id = ? AND NOT EXISTS(SELECT 1 FROM supplier_jobs j WHERE j.assignment_id = a.id)
    AND a.id = (SELECT MAX(other.id) FROM assignments other WHERE other.batch_id = a.batch_id AND other.item_id = a.item_id AND other.task = a.task AND other.mode = 'primary')`).all(batch) : [];
  res.json({ batch, batches, suppliers, people, jobs: [...jobs, ...unallocated, ...legacy], audit, delivery });
});
