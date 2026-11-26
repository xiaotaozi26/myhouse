import { TASK_KEYS, type TaskKey } from '../config.ts';
import { getDb, transaction } from '../db.ts';

type TaskStatus = 'unallocated' | 'annotating' | 'unassigned' | 'review' | 'rework' | 'approved';
type Priority = 'normal' | 'high' | 'urgent';

interface Assignment {
  id: number;
  item_id: string;
  task: TaskKey;
  state: TaskStatus;
  reviewer: string | null;
  annotator: string | null;
  priority: Priority;
  version: number;
  note: string | null;
}

export function deliveryProgress(batchId: string) {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM batches WHERE batch_id = ?').get(batchId)) throw new Error('批次不存在');
  const episodes = db.prepare(
    'SELECT item_id, title, episode_id FROM batch_items WHERE batch_id = ? ORDER BY title, episode_id, item_id',
  ).all(batchId);
  const assigned = db.prepare(`
    SELECT a.id, a.item_id, a.task, a.priority, writer.display_name AS annotator,
      reader.display_name AS reviewer, COALESCE(w.version, 0) AS version, v.note,
      CASE WHEN w.state IN ('unassigned', 'review', 'rework', 'approved') THEN w.state
           WHEN a.status = 'submitted' THEN 'unassigned' ELSE 'annotating' END AS state
    FROM assignments a
    JOIN batch_items i ON i.batch_id = a.batch_id AND i.item_id = a.item_id
    LEFT JOIN users writer ON writer.id = a.assignee_id
    LEFT JOIN assignment_reviews w ON w.assignment_id = a.id
    LEFT JOIN users reader ON reader.id = w.reviewer_id
    LEFT JOIN review_versions v ON v.assignment_id = a.id AND v.version = w.version
    WHERE a.batch_id = ? AND a.mode = 'primary'
    ORDER BY version DESC, (a.status = 'submitted') DESC, a.id DESC
  `).all(batchId) as unknown as Assignment[];
  const configured = new Set(db.prepare(
    'SELECT task FROM batch_delivery_tasks WHERE batch_id = ?',
  ).all(batchId).map(row => row.task));
  const inferred = new Set(assigned.map(row => row.task));
  const requiredTasks = TASK_KEYS.filter(task => (configured.size ? configured : inferred).has(task));
  const byEpisode = new Map<string, Map<TaskKey, Assignment>>();
  for (const assignment of assigned) {
    if (!TASK_KEYS.includes(assignment.task)) continue;
    const existing = byEpisode.get(assignment.item_id) || new Map<TaskKey, Assignment>();
    // Existing databases may contain more than one assignee per task. Prefer the latest review version.
    if (!existing.has(assignment.task)) existing.set(assignment.task, assignment);
    byEpisode.set(assignment.item_id, existing);
  }
  const rows = episodes.map(episode => {
    const assignedTasks = byEpisode.get(String(episode.item_id));
    const tasks = TASK_KEYS.map(task => {
      const required = requiredTasks.includes(task);
      const work = assignedTasks?.get(task);
      if (work) return { ...work, required };
      return { task, required, state: required ? 'unallocated' : 'out_of_scope' };
    });
    return { ...episode, tasks, ready: requiredTasks.length > 0 &&
      requiredTasks.every(task => assignedTasks?.get(task)?.state === 'approved') };
  });
  const states = rows.flatMap(row => row.tasks);
  return {
    requiredTasks,
    configured: configured.size > 0,
    rows,
    summary: {
      episodes: rows.length,
      ready: rows.filter(row => row.ready).length,
      waitingReview: states.filter(task => task.state === 'review' || task.state === 'unassigned').length,
      rework: states.filter(task => task.state === 'rework').length,
    },
  };
}

export function setDeliveryTasks(batchId: string, tasks: unknown) {
  if (!Array.isArray(tasks) || !tasks.length || tasks.some(task => !TASK_KEYS.includes(task))) {
    throw new Error('请至少选一项交付任务');
  }
  transaction(db => {
    if (!db.prepare('SELECT 1 FROM batches WHERE batch_id = ?').get(batchId)) throw new Error('批次不存在');
    db.prepare('DELETE FROM batch_delivery_tasks WHERE batch_id = ?').run(batchId);
    const insert = db.prepare('INSERT INTO batch_delivery_tasks (batch_id, task) VALUES (?, ?)');
    for (const task of new Set(tasks)) insert.run(batchId, task);
  });
}
