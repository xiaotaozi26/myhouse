import fs from 'node:fs';
import { getDb, transaction } from '../db.ts';
import type { UserRow } from '../db.ts';
import { extractItemIds, resultFilePath } from './assignment.service.ts';
import type { TaskKey } from '../config.ts';

type State = 'assigned' | 'unassigned' | 'review' | 'rework' | 'approved';
type Kind = 'submitted' | 'pass' | 'fixed' | 'return' | 'reworked';

interface ReviewCase {
  id: number;
  batch_id: string;
  task: TaskKey;
  item_id: string;
  title: string | null;
  assignee_id: number;
  priority: 'normal' | 'high' | 'urgent';
  reviewer_id: number | null;
  annotator: string;
  reviewer: string | null;
  state: State;
  version: number;
  note: string | null;
  kind: Kind | null;
  supplier_id: number | null;
  review_started_at: string | null;
}

interface Version {
  version: number;
  kind: Kind;
  note: string;
  result_id: number | null;
  payload: string | null;
  timing_csv: string | null;
  created_at: string;
}

interface ResultEpisode {
  item_id: string;
  prompt_g_review?: {
    round?: { role?: string; operator?: string; started_at?: string };
    verdict?: { verdict?: string; note?: string };
    previous_rounds?: unknown[];
    problems?: Record<string, { note?: string; round?: number }>;
  };
}

interface ReturnFeedback {
  note?: unknown;
  problems?: Record<string, { note?: string; round?: number }>;
  previousRound?: { round?: number };
}

function returnedEpisode(previous: ResultEpisode, feedback: ReturnFeedback, user: UserRow) {
  const review = previous.prompt_g_review;
  const earlier = review?.previous_rounds ?? [];
  const round = earlier.length + 1;
  if (!review || feedback.previousRound?.round !== round - 1) {
    throw new Error('请从当前待办打开本轮作业后再提交');
  }
  const flagged = Object.entries(feedback.problems || {}).filter(([key, flag]) =>
    /^(G1|G2|G3|S)\|.+/.test(key) && flag?.round === round &&
    typeof flag.note === 'string' && flag.note.trim(),
  );
  const explanation = typeof feedback.note === 'string' ? feedback.note.trim() : '';
  const note = [explanation, ...flagged.map(([, flag]) => flag.note!.trim())].filter(Boolean);
  if (!note.length) throw new Error('请填写返修原因，或在对应卡片上标记');
  const at = new Date().toISOString();
  // Return the last submitted material with feedback, without carrying unapproved edits into rework.
  return {
    note: [...new Set(note)].join('；'),
    episode: {
      ...previous,
      prompt_g_review: {
        ...review,
        previous_rounds: [...earlier, feedback.previousRound],
        round: { role: 'qc', operator: user.display_name, started_at: at },
        verdict: { verdict: 'return', note: explanation },
        problems: Object.fromEntries(flagged),
        confirmed: {},
        checks: {},
        submitted_at: null,
        completed_by: '',
        work: null,
      },
    },
  };
}

const cases = `SELECT a.id, a.batch_id, a.task, a.item_id, a.assignee_id, a.priority, i.title,
  writer.display_name AS annotator, reader.display_name AS reviewer, w.reviewer_id,
  j.supplier_id, j.review_started_at, COALESCE(w.state, 'assigned') AS state, COALESCE(w.version, 0) AS version, v.note, v.kind
  FROM assignments a
  JOIN batch_items i ON i.batch_id = a.batch_id AND i.item_id = a.item_id
  JOIN users writer ON writer.id = a.assignee_id
  LEFT JOIN assignment_reviews w ON w.assignment_id = a.id
  LEFT JOIN supplier_jobs j ON j.assignment_id = a.id
  LEFT JOIN users reader ON reader.id = w.reviewer_id
  LEFT JOIN review_versions v ON v.assignment_id = a.id AND v.version = w.version
  WHERE a.mode = 'primary'`;

function getCase(id: number): ReviewCase {
  const row = getDb().prepare(cases + ' AND a.id = ?').get(id) as unknown as ReviewCase | undefined;
  if (!row) throw new Error('找不到该标注任务');
  return row;
}

export function listReviewCases(user: UserRow): ReviewCase[] {
  const byPriority = "CASE a.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, i.title";
  const all = cases + " AND w.version > 0 ORDER BY CASE w.state WHEN 'unassigned' THEN 0 WHEN 'review' THEN 1 WHEN 'rework' THEN 2 ELSE 3 END, " + byPriority;
  const mine = cases + " AND ((w.state = 'review' AND w.reviewer_id = ? AND (j.id IS NULL OR j.review_started_at IS NOT NULL)) OR (w.state = 'rework' AND a.assignee_id = ?)) ORDER BY " + byPriority;
  return (user.role === 'admin' ? getDb().prepare(all).all() : getDb().prepare(mine).all(user.id, user.id)) as unknown as ReviewCase[];
}

export function listCompletedReviews(userId: number): ReviewCase[] {
  return getDb().prepare(cases + `
    AND v.author_id = ? AND w.reviewer_id = ?
    AND ((w.state = 'approved' AND v.kind IN ('pass', 'fixed')) OR
         (w.state = 'rework' AND v.kind = 'return'))
    ORDER BY v.created_at DESC, a.id DESC
  `).all(userId, userId) as unknown as ReviewCase[];
}

export function assignReviewers(ids: unknown, reviewerId: number): { changed: number } {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('请选择要指派复核的任务');
  }
  return transaction(db => {
    if (!Number.isSafeInteger(reviewerId) || !db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'annotator' AND work_role = 'legacy'").get(reviewerId)) {
      throw new Error('请选择有效的复核人');
    }
    const update = db.prepare("UPDATE assignment_reviews SET reviewer_id = ?, state = 'review' WHERE assignment_id = ?");
    const unique = new Set<number>(ids);
    for (const id of unique) {
      const row = getCase(id);
      if (row.supplier_id) throw new Error('供应商任务请通过任务池领取或统计明细转派');
      if (row.state !== 'unassigned' && row.state !== 'review') throw new Error('部分任务已变更，本次未指派');
      if (row.assignee_id === reviewerId) throw new Error('所选复核人也负责其中的标注，请调整人员或选择范围');
      update.run(reviewerId, id);
    }
    return { changed: unique.size };
  });
}

function activeRole(row: ReviewCase, userId: number): 'qc' | 'rework' {
  if (row.state === 'review' && row.reviewer_id === userId && (!row.supplier_id || row.review_started_at)) return 'qc';
  if (row.state === 'rework' && row.assignee_id === userId) return 'rework';
  throw new Error('当前待办已变更或尚未分配给你，请返回工作台刷新');
}

export function readVersion(id: number, version: number, includeOriginalTiming = false): { episode: ResultEpisode; timingCsv: string | null } {
  const row = getCase(id);
  const record = getDb().prepare('SELECT * FROM review_versions WHERE assignment_id = ? AND version = ?')
    .get(id, version) as unknown as Version | undefined;
  if (!record) throw new Error('找不到该轮结果');
  if (record.payload) return { episode: JSON.parse(record.payload) as ResultEpisode, timingCsv: record.timing_csv };
  const source = record.result_id && resultFilePath(record.result_id, 'result');
  if (!source) throw new Error('找不到原始提交的结果文件');
  const raw = JSON.parse(fs.readFileSync(source, 'utf8'));
  const episode = (Array.isArray(raw) ? raw : raw.rows)?.find((item: ResultEpisode) => item?.item_id === row.item_id);
  if (!episode) throw new Error('原始结果文件缺少这集');
  const timingFile = includeOriginalTiming && record.result_id && resultFilePath(record.result_id, 'timing');
  return { episode, timingCsv: timingFile ? fs.readFileSync(timingFile, 'utf8') : null };
}

export function reviewHistory(id: number) {
  getCase(id);
  return getDb().prepare(
    `SELECT v.version, v.kind, v.note, v.created_at, v.result_id, v.timing_csv IS NOT NULL AS has_timing, u.display_name AS author
     FROM review_versions v LEFT JOIN users u ON u.id = v.author_id WHERE v.assignment_id = ? ORDER BY v.version DESC`,
  ).all(id).map(({ result_id, has_timing, ...version }) => ({
    ...version,
    has_timing: Boolean(has_timing || (typeof result_id === 'number' && resultFilePath(result_id, 'timing'))),
  }));
}

export function openReviewCase(id: number, user: UserRow) {
  const row = getCase(id);
  const role = activeRole(row, user.id);
  if (role === 'rework') getDb().prepare('UPDATE supplier_jobs SET rework_started_at = COALESCE(rework_started_at, ?) WHERE assignment_id = ?')
    .run(new Date().toISOString(), id);
  const feedback = row.kind === 'reworked' ? getDb().prepare(`SELECT note FROM review_versions
    WHERE assignment_id = ? AND version < ? AND kind = 'return' ORDER BY version DESC LIMIT 1`).get(id, row.version)?.note : null;
  return { version: row.version, task: row.task, role, feedback, operator: user.display_name, operatorId: user.id,
    note: row.note, episode: readVersion(id, row.version).episode };
}

export function finishReviewCase(id: number, user: UserRow, body: {
  version?: number;
  episode?: unknown;
  returnFeedback?: ReturnFeedback;
  timingCsv?: string;
}) {
  return transaction(db => {
    const row = getCase(id);
    if (Number.isSafeInteger(body.version) && row.version === Number(body.version) + 1 &&
        db.prepare('SELECT 1 FROM review_versions WHERE assignment_id = ? AND version = ? AND author_id = ?')
          .get(id, row.version, user.id)) return { state: row.state };
    const role = activeRole(row, user.id);
    if (row.version !== body.version) throw new Error('当前结果已有更新，请刷新后重新打开');
    if (body.timingCsv != null && typeof body.timingCsv !== 'string') throw new Error('工作记录格式无效');
    const previous = readVersion(id, row.version).episode;
    const version = row.version + 1;
    const finish = (episode: ResultEpisode, kind: Kind, next: State, note: string) => {
      db.prepare(
        'INSERT INTO review_versions (assignment_id, version, kind, author_id, note, payload, timing_csv, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, version, kind, user.id, note, JSON.stringify(episode), body.timingCsv || null, new Date().toISOString());
      db.prepare('UPDATE assignment_reviews SET state = ?, version = ? WHERE assignment_id = ?').run(next, version, id);
      if (row.review_started_at && role === 'qc') {
        const elapsed = Math.max(0, Math.round((Date.now() - Date.parse(row.review_started_at)) / 1000));
        db.prepare('INSERT INTO supplier_review_timings VALUES (?, ?, ?)').run(id, version, elapsed);
      }
      db.prepare('UPDATE supplier_jobs SET review_started_at = NULL, rework_started_at = NULL WHERE assignment_id = ?').run(id);
      return { state: next };
    };
    if (body.returnFeedback != null) {
      if (role !== 'qc') throw new Error('当前任务无权退回返修');
      const { episode, note } = returnedEpisode(previous, body.returnFeedback, user);
      return finish(episode, 'return', 'rework', note);
    }
    const result = JSON.stringify([body.episode]);
    const [itemId] = extractItemIds(result, row.task);
    if (itemId !== row.item_id) throw new Error('提交的剧集与待办不一致');

    const episode = body.episode as ResultEpisode;
    const review = episode.prompt_g_review;
    const previousCount = previous.prompt_g_review?.previous_rounds?.length ?? 0;
    if (review?.round?.role !== role || review.previous_rounds?.length !== previousCount + 1) {
      throw new Error('请从当前待办打开本轮作业后再提交');
    }

    let kind: Kind = 'reworked';
    let next: State = 'review';
    let note = '';
    if (role === 'qc') {
      const verdict = review.verdict?.verdict;
      if (verdict !== 'pass' && verdict !== 'fixed' && verdict !== 'return') throw new Error('请选择本集复核结论');
      kind = verdict;
      next = verdict === 'return' ? 'rework' : 'approved';
      note = typeof review.verdict?.note === 'string' ? review.verdict.note.trim() : '';
      if (!note && kind === 'return') {
        note = Object.values(review.problems || {}).filter(flag => flag?.round === previousCount + 1)
          .map(flag => typeof flag.note === 'string' ? flag.note.trim() : '').filter(Boolean).join('；');
      }
      if (kind === 'return' && !note) throw new Error('请填写退回原因');
    }
    return finish(episode, kind, next, note);
  });
}
