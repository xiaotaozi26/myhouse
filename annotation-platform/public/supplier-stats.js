const workflowStates = {
  unallocated: '未派发', unclaimed: '待领取', annotating: '标注中', waiting: '待审核',
  reviewing: '审核中', returned: '返修待处理', reworking: '返修中', approved: '已通过',
};

function workflowState(job) {
  if (job.state === 'unallocated') return 'unallocated';
  if (job.supplier_id && !job.assignment_id) return 'unclaimed';
  if (job.state === 'approved') return 'approved';
  if (job.state === 'rework') return job.rework_started_at ? 'reworking' : 'returned';
  if (job.state === 'review') return job.review_started_at || !job.supplier_id ? 'reviewing' : 'waiting';
  return job.status === 'submitted' ? 'waiting' : 'annotating';
}

function firstPass(jobs) {
  const reviewed = jobs.filter(j => j.first_verdict);
  const pass = reviewed.filter(j => j.first_verdict === 'pass').length;
  return reviewed.length ? `${Math.round(100 * pass / reviewed.length)}%（${pass}/${reviewed.length}）` : '—';
}

const batchOptions = data => data.batches.map(b =>
  `<option value="${esc(b.batch_id)}"${b.batch_id === data.batch ? ' selected' : ''}>${esc(b.batch_id)}</option>`).join('');
const orgOptions = data => '<option value="">全部供应商</option>' + data.suppliers.map(s =>
  `<option value="${s.id}">${esc(s.name)}</option>`).join('');
function orgField(id, data, supplierOnly) {
  return supplierOnly
    ? `<label>所属供应商<input type="text" value="${esc(data.suppliers[0]?.name || '—')}" readonly></label>`
    : `<label>供应商<select id="${id}">${orgOptions(data)}</select></label>`;
}

const taskOptions = () => '<option value="">全部任务</option>' + Object.keys(annotationPages).map(t =>
  `<option value="${t}">${taskTitle(t)}</option>`).join('');

let statsData;
let statsRequest = 0;
async function loadSupplierOperations(batchId = $('stats-batch')?.value || '') {
  const request = ++statsRequest;
  const data = await api('/api/suppliers/stats?' + new URLSearchParams({ batchId }));
  if (request !== statsRequest) return;
  statsData = data;
  const root = $('supplier-operations');
  const supplierOnly = root.hasAttribute('data-supplier-only');
  const saved = Object.fromEntries(['org','task','state','title','person'].map(name => [name, $('stats-' + name)?.value || '']));
  root.innerHTML = `<section class="card">
    <h3>供应商作业管理</h3>
    <div class="row aligned-fields">
      <label>批次<select id="stats-batch">${batchOptions(data)}</select></label>
      ${orgField('stats-org', data, supplierOnly)}
      <label>任务<select id="stats-task">${taskOptions()}</select></label>
      <label>剧集<input id="stats-title" type="search" placeholder="搜索剧名或剧集编号"></label>
      <label>状态<select id="stats-state"><option value="">全部状态</option>${Object.entries(workflowStates).filter(([k]) => !supplierOnly || k !== 'unallocated').map(([k,v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label>人员<select id="stats-person"></select></label>
    </div>
    <div class="review-table"><table id="stats-jobs"></table></div>
  </section>
  <dialog id="transfer-dialog"><form id="transfer-form"><h2>转派作业</h2><p id="transfer-summary"></p>
    <label>接手人<select name="nextId" required></select></label>
    <label>原因<textarea name="reason" required rows="3"></textarea></label>
    <div class="row"><button type="button" id="transfer-cancel">取消</button><button class="primary">确认转派</button></div></form></dialog>
  <dialog id="check-dialog"><form id="check-form"><h2>公司抽查</h2><p id="check-summary"></p>
    <p><a id="check-file" target="_blank" rel="noopener">查看通过稿</a></p><div id="check-history"></div>
    <label>抽查结论<select name="outcome"><option value="pass">通过</option><option value="issue">有问题</option></select></label>
    <label>说明<textarea name="note" rows="2"></textarea></label>
    <div class="row"><button type="button" id="check-cancel">取消</button><button class="primary">保存抽查</button></div></form></dialog>`;
  for (const [name, value] of Object.entries(saved)) {
    const input = $(`stats-${name}`);
    if (name !== 'person' && input) input.value = value;
  }
  $('stats-batch').onchange = () => loadSupplierOperations().catch(e => toast(e.message, true));
  $('stats-org')?.addEventListener('change', () => { updateStatsPeople(); renderSupplierOperations(); });
  for (const name of ['task','person','state','title']) $(`stats-${name}`).oninput = renderSupplierOperations;
  root.onclick = statsAction;
  $('transfer-form').onsubmit = transferJob;
  $('check-form').onsubmit = saveCheck;
  $('check-cancel').onclick = () => $('check-dialog').close();
  $('transfer-cancel').onclick = () => $('transfer-dialog').close();
  updateStatsPeople(saved.person);
  renderSupplierOperations();
}

function updateStatsPeople(selected = '') {
  const org = $('stats-org')?.value;
  $('stats-person').innerHTML = '<option value="">全部人员</option>' + statsData.people
    .filter(p => (!org || p.supplier_id === Number(org)) && p.work_role !== 'supplier_manager')
    .map(p => `<option value="${p.id}">${esc(p.display_name)}</option>`).join('');
  if ([...$('stats-person').options].some(o => o.value === selected)) $('stats-person').value = selected;
}

function renderSupplierOperations() {
  const { jobs, audit = [], delivery } = statsData;
  const org = Number($('stats-org')?.value || 0);
  const task = $('stats-task').value;
  const title = $('stats-title').value.trim().toLowerCase();
  const person = Number($('stats-person').value);
  const selectedState = $('stats-state').value;
  const scoped = jobs.filter(j => (!org || j.supplier_id === org) && (!task || j.task === task) &&
    (!title || [j.title,j.item_id].some(value => String(value || '').toLowerCase().includes(title))));
  const reviews = audit;
  const reviewedByPerson = new Set(reviews.filter(r => r.author_id === person).map(r => r.job_id));
  const detail = scoped.filter(j => j.supplier_id && j.assignment_id && (!selectedState || workflowState(j) === selectedState) &&
    (!person || [j.assignee_id, j.reviewer_id, j.first_author].includes(person) || reviewedByPerson.has(j.id)));
  $('stats-jobs').innerHTML = '<tr><th>剧集</th><th>任务</th><th>状态</th><th>标注员</th><th>审核员</th><th>停留</th><th>操作</th></tr>' + (detail.map(j => {
    const state = workflowState(j);
    const stage = ['annotating','returned','reworking'].includes(state) ? 'annotation' :
      ['waiting','reviewing'].includes(state) ? 'review' : '';
    const since = { unclaimed: j.dispatched_at, annotating: j.started_at || j.assigned_at,
      reviewing: j.review_started_at || j.last_event, reworking: j.rework_started_at }[state] || j.last_event;
    return `<tr><td>${esc(formatDramaTitle(j.title,j.item_id))}</td><td>${esc(taskTitle(j.task))}</td>
      <td>${workflowStates[state]}${j.kind === 'reworked' && state === 'waiting' ? ' · 复审' : ''}</td>
      <td>${esc(j.annotator || '—')}</td><td>${esc(j.reviewer || '—')}</td><td>${age(since)}</td>
      <td>${j.id && stage ? `<button type="button" class="small" data-transfer="${j.id}" data-stage="${stage}">转派</button>` : delivery && j.id && state === 'approved' ? `<button type="button" class="small" data-check="${j.id}">公司抽查</button>` : '—'}</td></tr>`;
  }).join('') || '<tr><td colspan="7" class="muted">没有符合条件的作业</td></tr>');
}

function statsAction(event) {
  const button = event.target.closest('button');
  if (!button) return;
  const { transfer, stage, check } = button.dataset;
  if (check) openCheck(Number(check)).catch(error => toast(error.message, true));
  if (!transfer) return;
  const job = statsData.jobs.find(j => j.id === Number(transfer));
  const form = $('transfer-form');
  form.reset();
  form.dataset.job = transfer;
  form.dataset.stage = stage;
  $('transfer-summary').textContent = formatDramaTitle(job.title, job.item_id) + ' · ' + taskTitle(job.task);
  form.elements.nextId.innerHTML = '<option value="">选择接手人</option>' + statsData.people
    .filter(p => p.supplier_id === job.supplier_id && p.work_role === stage && ![job.assignee_id,job.reviewer_id].includes(p.id))
    .map(p => `<option value="${p.id}">${esc(p.display_name)}</option>`).join('');
  $('transfer-dialog').showModal();
}

async function transferJob(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button.primary');
  button.disabled = true;
  try {
    await api('/api/suppliers/jobs/' + form.dataset.job + '/transfer', {
      method: 'POST', body: { stage: form.dataset.stage, nextId: Number(form.elements.nextId.value), reason: form.elements.reason.value },
    });
    $('transfer-dialog').close();
    toast('已转派');
    await loadSupplierOperations();
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
}


async function openCheck(id) {
  const job = statsData.jobs.find(j => j.id === id);
  const { checks } = await api('/api/suppliers/jobs/' + id + '/checks');
  const form = $('check-form');
  form.reset();
  form.dataset.job = id;
  form.dataset.version = job.version;
  $('check-summary').textContent = formatDramaTitle(job.title, job.item_id) + ' · ' + taskTitle(job.task) + ' · 版本 ' + job.version;
  $('check-file').href = '/api/reviews/' + job.assignment_id + '/history/' + job.version;
  $('check-history').innerHTML = checks.map(c => `<p class="muted">${esc(c.display_name)} · v${c.version} · ${c.outcome === 'pass' ? '通过' : '有问题'} ${esc(c.note)}</p>`).join('');
  $('check-dialog').showModal();
}

async function saveCheck(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button.primary');
  button.disabled = true;
  try {
    await api('/api/suppliers/jobs/' + form.dataset.job + '/checks', { method: 'POST', body: {
      version: Number(form.dataset.version), outcome: form.elements.outcome.value, note: form.elements.note.value,
    } });
    $('check-dialog').close();
    toast('已保存抽查记录');
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
}

let overviewData;
let overviewRequest = 0;
const stateKeys = Object.keys(workflowStates).filter(key => key !== 'unallocated').concat('unallocated');
const formatCount = new Intl.NumberFormat('zh-CN');
const number = value => formatCount.format(value);
const progressPercent = (passed, total) => total ? Math.round(100 * passed / total) + '%' : '—';

function tallyProgress(jobs) {
  const counts = Object.fromEntries(stateKeys.map(key => [key, 0]));
  for (const job of jobs) counts[workflowState(job)]++;
  return counts;
}

function progressBar(counts, total) {
  const label = stateKeys.filter(key => counts[key]).map(key => workflowStates[key] + ' ' + number(counts[key])).join('，');
  return `<div class="progress-track" role="img" aria-label="${label || '暂无作业'}" title="${label || '暂无作业'}">
    ${stateKeys.filter(key => counts[key]).map(key =>
      `<span class="progress-color-${key}" style="flex-grow:${counts[key]}">${counts[key] / total >= .12 ? number(counts[key]) : ''}</span>`).join('')}
  </div>`;
}

function progressLegend(counts, supplierOnly = false) {
  return `<ul class="progress-legend">${stateKeys.filter(key => !supplierOnly || key !== 'unallocated').map(key => `<li>
    <span class="progress-dot progress-color-${key}"></span>${workflowStates[key]}
    ${counts ? `<strong>${number(counts[key])}</strong>` : ''}
  </li>`).join('')}</ul>`;
}

async function loadSupplierStats(batchId = $('overview-batch')?.value || '') {
  const request = ++overviewRequest;
  const data = await api('/api/suppliers/stats?' + new URLSearchParams({ batchId }));
  if (request !== overviewRequest) return;
  overviewData = data;
  const root = $('supplier-stats');
  const supplierOnly = root.hasAttribute('data-supplier-only');
  const org = $('overview-org')?.value || '';
  const task = $('overview-task')?.value || '';
  const sort = $('overview-sort')?.value || 'volume';
  const personnelOpen = $('overview-people-panel')?.open;
  root.innerHTML = `<div class="progress-overview">
    <section class="card progress-section">
      <header class="progress-header"><h2>进度总览</h2><button type="button" id="overview-refresh" class="small">刷新数据</button></header>
      <div class="row aligned-fields">
        <label>批次<select id="overview-batch">${batchOptions(data) || '<option value="">暂无批次</option>'}</select></label>
        ${orgField('overview-org', data, supplierOnly)}
        <label>任务类型<select id="overview-task">${taskOptions()}</select></label>
      </div>
      <div id="overview-kpis" class="progress-kpis"></div>
      <h3>当前作业状态</h3><div id="overview-flow"></div>
    </section>
    <section class="card progress-section">
      <header class="progress-header"><h2>标注作业漏斗</h2></header>
      <div id="overview-funnel"></div>
    </section>
    ${supplierOnly ? '' : `<section class="card progress-section">
      <header class="progress-header"><h2>供应商进度</h2>
        <label>排序<select id="overview-sort"><option value="volume">作业量</option><option value="backlog">审核积压</option><option value="completion">通过比例</option></select></label>
      </header>
      <div id="overview-suppliers"></div>
    </section>`}
    <section class="card progress-section">
      <header class="progress-header"><h2>任务类型进度</h2></header><div id="overview-tasks"></div>
    </section>
    <details class="card progress-section" id="overview-people-panel"${personnelOpen ? ' open' : ''}>
      <summary>人员汇总</summary><div id="overview-people" class="review-table"></div>
    </details>
  </div>`;
  if ($('overview-org') && [...$('overview-org').options].some(option => option.value === org)) $('overview-org').value = org;
  $('overview-task').value = task;
  if ($('overview-sort')) $('overview-sort').value = sort;
  const refresh = async () => {
    const button = $('overview-refresh');
    button.disabled = true;
    try { await loadSupplierStats(); } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  };
  $('overview-batch').onchange = refresh;
  $('overview-refresh').onclick = refresh;
  for (const field of ['org', 'task', 'sort']) $('overview-' + field)?.addEventListener('change', renderProgressOverview);
  renderProgressOverview();
}

function overviewRows(groups) {
  if (!groups.length) return '<p class="muted progress-empty">暂无统计数据。</p>';
  return `<div class="review-table"><table class="progress-table">
    <thead><tr><th scope="col">名称</th><th scope="col">状态分布</th><th scope="col">作业量</th>
    <th scope="col">审核积压</th><th scope="col">已通过</th><th scope="col">首审直接通过率</th></tr></thead>
    <tbody>${groups.map(({ name, jobs, counts }) => `<tr><th scope="row">${esc(name)}</th>
      <td class="progress-bar-cell">${progressBar(counts, jobs.length)}</td><td>${number(jobs.length)}</td>
      <td>${number(counts.waiting + counts.reviewing)}</td>
      <td>${number(counts.approved)} <span class="muted">${progressPercent(counts.approved, jobs.length)}</span></td>
      <td>${firstPass(jobs)}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

function funnelStages(jobs, counts, submitted) {
  const total = jobs.length;
  const dispatched = total - counts.unallocated;
  const claimed = dispatched - counts.unclaimed;
  const firstReviewed = jobs.filter(job => job.first_verdict || job.review_version >= 2 ||
    job.state === 'approved' || job.state === 'rework').length;
  return [
    { label: '标注作业总量', count: total, gap: '' },
    { label: '已派发', count: dispatched, gap: '未派发' },
    { label: '已领取或指派到人', count: claimed, gap: '待领取' },
    { label: '已提交标注', count: submitted, gap: '已领未提交' },
    { label: '已完成首审', count: firstReviewed, gap: '待完成首审' },
    { label: '已审核通过', count: counts.approved, gap: '首审后尚未通过' },
  ];
}

function progressFunnel(stages, supplierScoped) {
  const total = stages[0].count;
  if (!total) return '<p class="muted progress-empty">当前筛选范围内暂无标注作业。</p>';
  return `<p class="muted funnel-note">一集的一类任务计为一份作业。同一份作业每层计一次，返修和复审按原作业计。
      ${supplierScoped ? '当前总量为所选供应商收到的作业。' : '总量包含当前范围内尚未派发的作业。'}</p>
    <div class="review-table"><table class="funnel-table">
      <thead><tr><th scope="col">环节</th><th scope="col">占作业总量</th><th scope="col">作业数</th>
        <th scope="col">环节转化率</th><th scope="col">与上一步相差</th></tr></thead>
      <tbody>${stages.map((stage,index) => {
        const previous = stages[index-1]?.count;
        const gap = previous == null ? 0 : previous - stage.count;
        return `<tr><th scope="row">${stage.label}</th><td class="funnel-bar-cell"><div class="funnel-track">
          <span aria-hidden="true" class="funnel-band funnel-band-${index}" style="width:${100 * stage.count / total}%"></span>
          <span class="funnel-share">${progressPercent(stage.count,total)}</span></div></td>
          <td><strong>${number(stage.count)}</strong></td>
          <td>${index ? progressPercent(stage.count,previous) : '—'}</td>
          <td class="funnel-gap">${index ? stage.gap + ' ' + number(gap) + ' 份' : '—'}</td></tr>`;
      }).join('')}</tbody></table></div>`;
}

function renderProgressOverview() {
  const { suppliers, people, jobs, audit = [], delivery } = overviewData;
  const org = Number($('overview-org')?.value || 0);
  const task = $('overview-task').value;
  const scoped = jobs.filter(j => (!task || j.task === task) && (!org || j.supplier_id === org));
  const counts = tallyProgress(scoped);
  const submitted = scoped.filter(job => job.status === 'submitted').length;
  const metrics = [
    ['作业总量', number(scoped.length), '份'],
    ['已提交标注', number(submitted), progressPercent(submitted, scoped.length)],
    ['审核积压', number(counts.waiting + counts.reviewing), '份'],
    ['已通过', number(counts.approved), progressPercent(counts.approved, scoped.length)],
    ['首审直接通过率', firstPass(scoped), ''],
  ];
  if (delivery && !org && !task) metrics.push([
    delivery.configured ? '可交付集数' : '可交付集数（预估）',
    `${number(delivery.summary.ready)} / ${number(delivery.summary.episodes)}`, '集',
  ]);
  $('overview-kpis').innerHTML = metrics.map(([label,value,unit]) => `<div class="progress-kpi"><span>${label}</span>
    <strong>${value}</strong>${unit && unit !== '—' ? `<small>${unit}</small>` : ''}</div>`).join('');
  const supplierOnly = $('supplier-stats').hasAttribute('data-supplier-only');
  $('overview-flow').innerHTML = progressBar(counts, scoped.length) + progressLegend(counts, supplierOnly);
  $('overview-funnel').innerHTML = progressFunnel(funnelStages(scoped, counts, submitted), supplierOnly || Boolean(org));
  const group = (name, rows) => ({ name, jobs: rows, counts: tallyProgress(rows) });
  const supplierRows = suppliers.filter(s => !org || s.id === org)
    .map(s => group(s.name, scoped.filter(j => j.supplier_id === s.id)));
  const sort = $('overview-sort')?.value;
  const rank = row => sort === 'backlog' ? row.counts.waiting + row.counts.reviewing :
    sort === 'completion' ? row.counts.approved / Math.max(1,row.jobs.length) : row.jobs.length;
  supplierRows.sort((a,b) => rank(b) - rank(a));
  if ($('overview-suppliers')) $('overview-suppliers').innerHTML = overviewRows(supplierRows);
  const taskRows = Object.keys(annotationPages).filter(key => !task || key === task)
    .map(key => group(taskTitle(key), scoped.filter(j => j.task === key)));
  $('overview-tasks').innerHTML = overviewRows(taskRows);
  const ids = new Set(scoped.filter(j => j.supplier_id).map(j => j.id));
  const reviews = audit.filter(row => ids.has(row.job_id));
  const workers = people.filter(p => (!org || p.supplier_id === org) && p.work_role !== 'supplier_manager');
  $('overview-people').innerHTML = workers.length ? `<table class="progress-table">
    <thead><tr><th scope="col">人员</th><th scope="col">岗位</th><th scope="col">进行中</th>
    <th scope="col">已提交 / 已审轮次</th><th scope="col">待返修</th><th scope="col">首审直接通过率 / 平均审核耗时</th></tr></thead>
    <tbody>${workers.map(p => {
      const reviewer = p.work_role === 'review';
      const own = scoped.filter(j => (reviewer ? j.reviewer_id : j.assignee_id) === p.id);
      const current = tallyProgress(own);
      const first = scoped.filter(j => j.first_author === p.id);
      const done = reviews.filter(r => r.author_id === p.id);
      const timings = done.filter(r => r.elapsed_seconds != null);
      const average = timings.length ? Math.round(timings.reduce((sum,r) => sum + r.elapsed_seconds,0) / timings.length / 60) + ' 分钟' : '—';
      return `<tr><th scope="row">${esc(p.display_name)}</th><td>${reviewer ? '审核' : '标注'}</td>
        <td>${reviewer ? current.reviewing : current.annotating + current.reworking}</td>
        <td>${reviewer ? done.length : first.length}</td><td>${reviewer ? '—' : current.returned}</td>
        <td>${reviewer ? average : firstPass(first)}</td></tr>`;
    }).join('')}</tbody></table>` : '<p class="muted progress-empty">暂无人员数据。</p>';
}
