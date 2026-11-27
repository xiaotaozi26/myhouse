async function openPlatformReview({ id, task, keyPrefix, core, store, setRows, message, workLog, attribute, setOperator, setSubmit }) {
  const $ = id => document.getElementById(id);
  const response = await fetch('/api/reviews/' + encodeURIComponent(id) + '/work', {
    cache: 'no-store', signal: AbortSignal.timeout(20000),
  });
  const work = await response.json();
  if (!response.ok) throw new Error(work.error || '无法打开待办');
  if (work.task !== task) throw new Error('请从工作台打开对应的标注页');
  const key = keyPrefix + ':review:' + JSON.stringify([id, work.version, work.role, work.operatorId]);
  const saved = await store.load(key).catch(() => null);
  const parsed = core.parse(saved ? JSON.stringify(saved) : JSON.stringify([work.episode]),
    work.episode.final_annotation.split_task);
  if (saved && (parsed.rows.length !== 1 || parsed.rows[0].item_id !== work.episode.item_id)) {
    throw new Error('浏览器草稿不属于这一集，请重新打开待办');
  }
  if (!saved) core.beginRound(parsed.rows[0], { role: work.role, operator: work.operator });
  if (work.role === 'qc') {
    document.body.classList.add('review-workspace');
    document.body.dataset.reviewStage = work.version > 1 ? '复审' : '首审';
  }
  setRows(parsed, '当前待办', parsed.ui, key);
  setOperator(work.operator);

  document.body.classList.add('platform-review');
  const button = $('complete');
  const form = $('form-scroll');
  const label = '完成并提交';
  button.textContent = label;
  if (work.role === 'qc' && work.episode.final_annotation?.force_submitted === true) {
    const notice = document.createElement('p');
    notice.className = 'platform-review-note';
    notice.textContent = '本集标注稿通过「强制提交」送审，可能含未核对项或未通过检查的内容。';
    $('message').before(notice);
  }
  if ((work.note && work.role === 'rework') || work.feedback) {
    const note = document.createElement('p');
    note.className = 'platform-review-note';
    note.textContent = (work.feedback ? '上轮返修意见：' : '退回原因：') + (work.feedback || work.note);
    $('message').before(note);
  }
  setSubmit(async ({ returnOnly = false } = {}) => {
    if (button.disabled) return;
    const current = parsed.rows[0];
    if (returnOnly) {
      const [issue] = core.roundIssues(current);
      if (issue) {
        message(issue, true);
        $('qc-note').focus();
        return;
      }
    }
    button.disabled = true;
    button.textContent = '正在提交…';
    form.inert = true;
    try {
      attribute(work.operator);
      const review = current.prompt_g_review;
      const submission = returnOnly
        ? { returnFeedback: { note: review.verdict.note, problems: review.problems, previousRound: review.previous_rounds.at(-1) } }
        : { episode: core.exportRows(parsed.rows)[0] };
      const result = await fetch('/api/reviews/' + encodeURIComponent(id) + '/work', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ version: work.version, ...submission, timingCsv: workLog('annotation-result.json', work.operator) }),
      });
      const reply = await result.json();
      if (!result.ok) throw new Error(reply.error || '提交失败');
      $('saved').textContent = '已提交';
      window.location.replace('/');
    } catch (error) {
      button.disabled = false;
      button.textContent = label;
      form.inert = false;
      message(error.name === 'TimeoutError' ? '提交超时，请返回工作台查看状态。' :
        error instanceof TypeError ? '无法连接平台，请检查网络后重试。' : error.message, true);
    }
  });
}
