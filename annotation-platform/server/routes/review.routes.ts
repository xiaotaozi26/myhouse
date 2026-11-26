import express from 'express';
import { requireAuth, requireAdmin, type AuthedRequest } from '../auth.ts';
import { assignReviewers, finishReviewCase, listCompletedReviews, listReviewCases, openReviewCase, readVersion, reviewHistory } from '../services/review.service.ts';

export const reviewRouter = express.Router();
reviewRouter.use(requireAuth);

reviewRouter.get('/', (req, res) => {
  const { user } = req as unknown as AuthedRequest;
  const cases = listReviewCases(user);
  const completed = req.query.includeCompleted === '1' ? listCompletedReviews(user.id) : undefined;
  res.set('Cache-Control', 'no-store').json({ cases, completed });
});
reviewRouter.get('/:id/work', (req, res) => {
  try {
    res.set('Cache-Control', 'no-store').json(openReviewCase(Number(req.params.id), (req as unknown as AuthedRequest).user));
  } catch (e) { res.status(403).json({ error: (e as Error).message }); }
});
reviewRouter.post('/:id/work', (req, res) => {
  try {
    res.json(finishReviewCase(Number(req.params.id), (req as unknown as AuthedRequest).user, req.body ?? {}));
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
reviewRouter.post('/bulk/reviewer', requireAdmin, (req, res) => {
  try {
    res.json(assignReviewers(req.body?.ids, Number(req.body?.reviewerId)));
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
reviewRouter.post('/:id/reviewer', requireAdmin, (req, res) => {
  try {
    assignReviewers([Number(req.params.id)], Number(req.body?.reviewerId));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
reviewRouter.get('/:id/history', requireAdmin, (req, res) => {
  try {
    res.json({ versions: reviewHistory(Number(req.params.id)) });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
reviewRouter.get('/:id/history/:version', requireAdmin, (req, res) => {
  try {
    const artifact = readVersion(Number(req.params.id), Number(req.params.version), req.query.kind === 'timing');
    if (req.query.kind === 'timing') {
      if (!artifact.timingCsv) { res.status(404).json({ error: '没有工作记录' }); return; }
      res.attachment('work-log.csv').send(artifact.timingCsv);
    } else {
      res.attachment('annotation-result.json').json([artifact.episode]);
    }
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
