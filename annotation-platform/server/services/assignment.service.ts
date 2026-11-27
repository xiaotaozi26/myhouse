import fs from 'node:fs';
import path from 'node:path';
import { getDb, transaction, type AssignmentRow } from '../db.ts';
import { MODES, RESULTS_DIR, TASK_KEYS, TASKS, type Mode, type TaskKey } from '../config.ts';
import { buildSlice } from './batch.service.ts';

// ---------- assignments ----------

const priorities = ['normal', 'high', 'urgent'] as const;
type Priority = typeof priorities[number];
const rank = { normal: 0, high: 1, urgent: 2 };

function validPriority(value: unknown): Priority {
  if (!priorities.includes(value as Priority)) throw new Error('请选择有效的优先级');
  return value as Priority;
}


export function createAssignments(
  batchId: string,
  mode: Mode,
  itemIds: string[],
  allocations: { task: TaskKey; assigneeId: number; reviewerId?: number | null }[],
  priority: unknown = 'normal',
): { created: number } {
  if (typeof batchId !== 'string' || !batchId) throw new Error('请选择批次');
  const priorityValue = validPriority(priority);
  if (mode !== 'primary') throw new Error('每集每项任务只支持分配一份标注');
  if (!Array.isArray(itemIds) || !itemIds.length || itemIds.some((id) => typeof id !== 'string' || !id)) {
    throw new Error('请选择有效条目');
  }
  if (!Array.isArray(allocations) || !allocations.length || allocations.some(
    (entry) => !entry || !TASK_KEYS.includes(entry.task) || !Number.isSafeInteger(entry.assigneeId),
  )) throw new Error('请为至少一项任务选择标注员');
  if (new Set(allocations.map((entry) => entry.task)).size !== allocations.length) {
    throw new Error('每项任务只可选择一名标注员');
  }

  return transaction((db) => {
    if (!db.prepare('SELECT 1 FROM batches WHERE batch_id = ?').get(batchId)) throw new Error('批次不存在');
    const item = db.prepare('SELECT title FROM batch_items WHERE batch_id = ? AND item_id = ?');
    const entries = [...new Set(itemIds)].map((id) => {
      const row = item.get(batchId, id);
      if (!row) throw new Error(`条目不属于该批次：${id}`);
      return { id, title: row.title || id };
    });

    const user = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'annotator' AND work_role = 'legacy'");
    const dispatched = db.prepare('SELECT 1 FROM supplier_jobs WHERE batch_id = ? AND task = ? AND item_id = ?');
    const existing = db.prepare('SELECT mode, assignee_id FROM assignments WHERE batch_id = ? AND task = ? AND item_id = ?');
    const insert = db.prepare(
      `INSERT INTO assignments (batch_id, task, mode, item_id, assignee_id, status, priority, assigned_at)
       VALUES (?, ?, ?, ?, ?, 'assigned', ?, ?)`,
    );
    const review = db.prepare("INSERT INTO assignment_reviews (assignment_id, reviewer_id, state) VALUES (?, ?, 'assigned')");
    const now = new Date().toISOString();
    let created = 0;
    for (const { task, assigneeId, reviewerId } of allocations) {
      if (!user.get(assigneeId)) throw new Error('标注员不存在');
      if (reviewerId != null && (!Number.isSafeInteger(reviewerId) || !user.get(reviewerId))) throw new Error('复核人不存在');
      if (reviewerId === assigneeId) throw new Error('复核人和标注员须由不同人员担任');
      for (const { id, title } of entries) {
        if (dispatched.get(batchId, task, id)) throw new Error('该作业已派发至供应商');
        const rows = existing.all(batchId, task, id);
        const label = `${TASKS[task].title} · ${title}`;
        if (rows.some((row) => row.mode === mode && row.assignee_id !== assigneeId)) {
          throw new Error(`${label} 已分配给其他标注员`);
        }
        if (rows.some((row) => row.mode === mode)) continue;
        const inserted = insert.run(batchId, task, mode, id, assigneeId, priorityValue, now);
        review.run(inserted.lastInsertRowid, reviewerId ?? null);
        created += 1;
      }
    }
    return { created };
  });
}

export function updateAssignments(ids: unknown, action: unknown, priority?: unknown): { changed: number } {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('请选择要操作的分配');
  }
  if (action !== 'remove' && action !== 'priority') throw new Error('批量操作无效');
  const value = action === 'priority' ? validPriority(priority) : null;
  return transaction(db => {
    const remove = db.prepare("DELETE FROM assignments WHERE id = ? AND mode = 'primary' AND status = 'assigned'");
    const prioritize = db.prepare("UPDATE assignments SET priority = ? WHERE id = ? AND mode = 'primary'");
    let changed = 0;
    for (const id of new Set<number>(ids)) {
      const managed = db.prepare('SELECT 1 FROM supplier_jobs WHERE assignment_id = ?').get(id);
      if (managed && !value) throw new Error('供应商作业须通过释放或转派调整');
      if (managed) db.prepare('UPDATE supplier_jobs SET priority = ? WHERE assignment_id = ?').run(value, id);
      const result = value ? prioritize.run(value, id) : remove.run(id);
      if (!result.changes) throw new Error(value ? '部分分配已变更，请刷新后重试' : '部分作业已提交或已移除，本次移除未执行');
      changed++;
    }
    return { changed };
  });
}

export function deleteAssignment(id: number): void {
  updateAssignments([id], 'remove');
}

export interface AssignmentView extends AssignmentRow {
  title: string | null;
  lang: string | null;
  second_review: number;
  username: string;
  display_name: string;
  supplier_job_id: number | null;
  started_at: string | null;
}

export function listAssignments(filter: {
  batchId?: string;
  task?: TaskKey;
  mode?: Mode;
  assigneeId?: number;
}): AssignmentView[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.batchId) {
    clauses.push('a.batch_id = ?');
    params.push(filter.batchId);
  }
  if (filter.task) {
    clauses.push('a.task = ?');
    params.push(filter.task);
  }
  if (filter.mode) {
    clauses.push('a.mode = ?');
    params.push(filter.mode);
  }
  if (filter.assigneeId) {
    clauses.push('a.assignee_id = ?');
    params.push(filter.assigneeId);
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  return getDb()
    .prepare(
      `SELECT a.*, i.title, i.lang, i.second_review, u.username, u.display_name, j.id AS supplier_job_id, j.started_at
       FROM assignments a
       LEFT JOIN supplier_jobs j ON j.assignment_id = a.id
       JOIN batch_items i ON i.batch_id = a.batch_id AND i.item_id = a.item_id
       JOIN users u ON u.id = a.assignee_id
       ${where}
       ORDER BY a.batch_id, a.task, a.mode, CASE a.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, i.title`,
    )
    .all(...params) as unknown as AssignmentView[];
}

// ---------- annotator jobs ----------

export interface JobItem {
  item_id: string;
  title: string | null;
  lang: string | null;
  second_review: number;
  status: 'assigned' | 'submitted';
  priority: Priority;
  submitted_at: string | null;
  supplier_job_id: number | null;
  started_at: string | null;
}

export interface Job {
  batch_id: string;
  task: TaskKey;
  mode: Mode;
  assigned: number;
  submitted: number;
  items: JobItem[];
}

export function myJobs(userId: number): Job[] {
  const rows = listAssignments({ assigneeId: userId });
  const byKey = new Map<string, Job>();
  for (const r of rows) {
    const key = `${r.batch_id}|${r.task}|${r.mode}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        batch_id: r.batch_id,
        task: r.task as TaskKey,
        mode: r.mode as Mode,
        assigned: 0,
        submitted: 0,
        items: [],
      });
    }
    const job = byKey.get(key)!;
    job.assigned += 1;
    if (r.status === 'submitted') job.submitted += 1;
    job.items.push({
      item_id: r.item_id,
      title: r.title,
      lang: r.lang,
      second_review: r.second_review,
      status: r.status,
      priority: r.priority,
      submitted_at: r.submitted_at,
      supplier_job_id: r.supplier_job_id, started_at: r.started_at,
    });
  }
  for (const job of byKey.values()) {
    job.items.sort((a, b) => Number(a.status === 'submitted') - Number(b.status === 'submitted'));
  }
  const pendingRank = (job: Job) => Math.max(0, ...job.items.filter(item => item.status === 'assigned').map(item => rank[item.priority]));
  return [...byKey.values()].sort((a, b) => pendingRank(b) - pendingRank(a) || `${a.batch_id}${a.task}${a.mode}`.localeCompare(`${b.batch_id}${b.task}${b.mode}`));
}

export function jobData(batchId: string, task: TaskKey, mode: Mode, userId: number, itemId?: string): { jsonl: string; count: number; draftScope: string } {
  const rows = listAssignments({ batchId, task, mode, assigneeId: userId }).filter(row => !itemId || row.item_id === itemId);
  if (!rows.length) throw new Error('该作业没有分配给你');
  const ids = new Set(rows.map((r) => r.item_id));
  const pendingPriority = new Map(rows.filter(row => row.status === 'assigned').map(row => [row.item_id, rank[row.priority]]));
  const jsonl = buildSlice(batchId, mode, ids, task, pendingPriority);
  const start = getDb().prepare(`UPDATE supplier_jobs SET started_at = ? WHERE assignment_id = ?
    AND started_at IS NULL AND EXISTS (SELECT 1 FROM assignments WHERE id = ? AND assignee_id = ?)`);
  for (const row of rows) start.run(new Date().toISOString(), row.id, row.id, userId);
  const draftScope = rows.some(row => row.supplier_job_id) ? rows.map(row => row.id + ':' + row.assigned_at).sort().join(',') : '';
  return { jsonl, count: rows.length, draftScope };
}

// ---------- result submission ----------

export function extractItemIds(resultJson: string, task: TaskKey): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    throw new Error('结果文件不是有效的 JSON');
  }
  const document = parsed as { draft_only?: boolean; rows?: unknown };
  const rows = Array.isArray(parsed) ? parsed : document?.rows;
  if (document?.draft_only || !Array.isArray(rows) || !rows.length) {
    throw new Error('请上传标注页“导出已完成”生成的结果 JSON');
  }
  const seen = new Set<string>();
  for (const row of rows) {
    const id: unknown = row?.item_id;
    if (typeof id !== 'string' || !id.trim()) throw new Error('结果中存在缺少条目编号的记录');
    if (seen.has(id)) throw new Error(`结果中存在重复条目：${id}`);
    const annotation = row.final_annotation;
    const submittedAt = row.prompt_g_review?.submitted_at;
    if (annotation?.status !== 'locally_completed_not_accepted' ||
        typeof submittedAt !== 'string' || !submittedAt.trim() ||
        annotation.completed_at !== submittedAt) {
      throw new Error(`条目尚未完成：${id}`);
    }
    if (annotation.split_task !== TASKS[task].splitTask) {
      throw new Error(`条目与当前任务不匹配：${id}`);
    }
    seen.add(id);
  }
  return [...seen];
}

export function submitResult(input: {
  batchId: string;
  task: TaskKey;
  mode: Mode;
  userId: number;
  operator: string;
  resultJson: string;
  timingCsv: string | null;
  fileName: string;
  directSubmit?: boolean;
}): { submitted: number; itemIds: string[] } {
  if (!TASK_KEYS.includes(input.task)) throw new Error('非法任务');
  if (!MODES.includes(input.mode)) throw new Error('非法作业类型');
  if (typeof input.batchId !== 'string' || !input.batchId) throw new Error('缺少批次');
  if (typeof input.operator !== 'string' || !input.operator.trim()) throw new Error('缺少作业人员编号');
  if (typeof input.resultJson !== 'string' || !input.resultJson.trim()) throw new Error('缺少结果文件内容');
  if (input.timingCsv !== null && typeof input.timingCsv !== 'string') throw new Error('工作记录文件格式无效');
  if (typeof input.fileName !== 'string') throw new Error('文件名无效');

  const itemIds = extractItemIds(input.resultJson, input.task);
  if (input.directSubmit && (itemIds.length !== 1 || input.mode !== 'primary')) {
    throw new Error('请在标注页逐集提交');
  }
  const now = new Date().toISOString();
  const written: string[] = [];
  try {
    return transaction((db) => {
      const assigned = listAssignments({
        batchId: input.batchId,
        task: input.task,
        mode: input.mode,
        assigneeId: input.userId,
      });
      const myIds = new Set(assigned.map((row) => row.item_id));
      const unassigned = itemIds.find((id) => !myIds.has(id));
      if (unassigned) throw new Error(`该条目未分配到当前作业：${unassigned}`);
      // A retry after a lost response must leave the original review version intact.
      if (input.directSubmit && assigned.some(row => row.item_id === itemIds[0] && row.status === 'submitted')) {
        return { submitted: 0, itemIds };
      }

      const result = db.prepare(
        `INSERT INTO results (batch_id, task, mode, operator, assignee_id, item_ids, file_name, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.batchId, input.task, input.mode, input.operator.trim(), input.userId,
        JSON.stringify(itemIds), input.fileName || null, now,
      );
      const id = Number(result.lastInsertRowid);
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
      const files: [string, string][] = [[`${id}_result.json`, input.resultJson]];
      if (input.timingCsv?.trim()) files.push([`${id}_timing.csv`, input.timingCsv]);
      for (const [name, content] of files) {
        const file = path.join(RESULTS_DIR, name);
        const descriptor = fs.openSync(file, 'w');
        written.push(file);
        try {
          fs.writeFileSync(descriptor, content, 'utf8');
        } finally {
          fs.closeSync(descriptor);
        }
      }

      const update = db.prepare(
        `UPDATE assignments SET status = 'submitted', submitted_at = ?
         WHERE batch_id = ? AND task = ? AND mode = ? AND assignee_id = ? AND item_id = ? AND status = 'assigned'`,
      );
      const startReview = db.prepare(
        `INSERT INTO assignment_reviews (assignment_id, state, version) VALUES (?, 'unassigned', 1)
         ON CONFLICT(assignment_id) DO UPDATE SET
           state = CASE WHEN reviewer_id IS NULL THEN 'unassigned' ELSE 'review' END, version = 1
         WHERE assignment_reviews.version = 0`,
      );
      const firstVersion = db.prepare(
        `INSERT INTO review_versions (assignment_id, version, kind, author_id, result_id, created_at)
         VALUES (?, 1, 'submitted', ?, ?, ?)`,
      );
      let submitted = 0;
      for (const assignment of assigned.filter(row => itemIds.includes(row.item_id))) {
        const changed = update.run(now, input.batchId, input.task, input.mode, input.userId, assignment.item_id).changes;
        submitted += Number(changed);
        if (input.mode === 'primary' && startReview.run(assignment.id).changes) {
          firstVersion.run(assignment.id, input.userId, id, now);
        }
      }
      return { submitted, itemIds };
    });
  } catch (error) {
    for (const file of written) fs.rmSync(file, { force: true });
    throw error;
  }
}

export interface ResultView {
  id: number;
  batch_id: string;
  task: string;
  mode: string;
  operator: string;
  username: string;
  display_name: string;
  item_ids: string[];
  episodes: { title: string | null; episode_id: string | null }[];
  has_timing: boolean;
  file_name: string | null;
  uploaded_at: string;
}

export function listResults(batchId?: string): ResultView[] {
  const params: (string | number)[] = [];
  const where = batchId ? 'WHERE r.batch_id = ?' : '';
  if (batchId) params.push(batchId);
  const rows = getDb()
    .prepare(
      `SELECT r.*, u.username, u.display_name,
        (SELECT json_group_array(json_object('title', i.title, 'episode_id', i.episode_id))
         FROM json_each(r.item_ids) AS item
         LEFT JOIN batch_items i ON i.batch_id = r.batch_id AND i.item_id = item.value) AS episodes
       FROM results r JOIN users u ON u.id = r.assignee_id ${where} ORDER BY r.id DESC`,
    )
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as number,
    batch_id: r.batch_id as string,
    task: r.task as string,
    mode: r.mode as string,
    operator: r.operator as string,
    username: r.username as string,
    display_name: r.display_name as string,
    item_ids: JSON.parse((r.item_ids as string) || '[]') as string[],
    episodes: JSON.parse(r.episodes as string) as ResultView['episodes'],
    has_timing: fs.existsSync(path.join(RESULTS_DIR, `${r.id}_timing.csv`)),
    file_name: (r.file_name as string | null) ?? null,
    uploaded_at: r.uploaded_at as string,
  }));
}

export function resultFilePath(id: number, kind: 'result' | 'timing'): string | null {
  if (!Number.isSafeInteger(id) || !getDb().prepare('SELECT 1 FROM results WHERE id = ?').get(id)) return null;
  const p = path.join(RESULTS_DIR, kind === 'result' ? `${id}_result.json` : `${id}_timing.csv`);
  return fs.existsSync(p) ? p : null;
}
