import express from 'express';
import type { Request, Response } from 'express';
import { requireAuth, type AuthedRequest } from '../auth.ts';
import { TASKS, type Mode, type TaskKey } from '../config.ts';
import { jobData, myJobs, submitResult } from '../services/assignment.service.ts';

export const annotatorRouter = express.Router();
annotatorRouter.use(requireAuth);

annotatorRouter.get('/jobs', (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  res.json({ jobs: myJobs(user.id), tasks: TASKS });
});

annotatorRouter.get('/data', (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const { batchId, task, mode, item } = req.query as { batchId?: string; task?: string; mode?: string; item?: string };
  if (!batchId || !task || !mode) {
    res.status(400).json({ error: '缺少 batchId / task / mode' });
    return;
  }
  try {
    const { jsonl, count, draftScope } = jobData(batchId, task as TaskKey, mode as Mode, user.id,
      user.work_role === 'annotation' && typeof item === 'string' ? item : undefined);
    if (draftScope) res.setHeader('X-Annotation-Draft-Scope', draftScope);
    const label = TASKS[task as TaskKey]?.key ?? task;
    const filename = `${batchId}-${label}-${mode}-${count}.jsonl`;
    res.setHeader('Content-Type', 'application/jsonl; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(jsonl);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

annotatorRouter.post('/results', (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const body = (req.body ?? {}) as {
    batchId?: string;
    task?: string;
    mode?: string;
    operator?: string;
    resultJson?: string;
    timingCsv?: string | null;
    fileName?: string;
    directSubmit?: boolean;
  };
  if (!body.batchId || !body.task || !body.mode) {
    res.status(400).json({ error: '缺少 batchId / task / mode' });
    return;
  }
  try {
    const r = submitResult({
      batchId: body.batchId,
      task: body.task as TaskKey,
      mode: body.mode as Mode,
      userId: user.id,
      operator: body.operator ?? '',
      resultJson: body.resultJson ?? '',
      timingCsv: body.timingCsv ?? null,
      fileName: body.fileName ?? '',
      directSubmit: body.directSubmit === true,
    });
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
