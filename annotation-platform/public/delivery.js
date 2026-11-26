const deliveryTitles = { people: '人物与对白', assets: '场景道具', shots: '镜头', story: '剧情' };
const deliveryStates = {
  unallocated: ['待分配', 'muted'],
  annotating: ['标注中', 'info'],
  unassigned: ['待指派审核', 'warn'],
  review: ['待审核', 'info'],
  rework: ['返修中', 'urgent'],
  approved: ['已通过', 'ok'],
};
let deliveryData;
let deliveryRequest = 0;
let deliveryDetailRequest = 0;

function deliveryNext(task) {
  switch (task.state) {
    case 'unallocated': return '管理员分配标注';
    case 'unassigned': return '管理员指派审核';
    case 'annotating': return (task.annotator || '标注员') + '标注';
    case 'review': return (task.reviewer || '审核人') + '审核';
    case 'rework': return (task.annotator || '标注员') + '返修';
    default: return '';
  }
}

function deliveryBadge(task) {
  const [label, color] = deliveryStates[task.state];
  return `<span class="badge badge-${color}">${label}</span>`;
}

function deliveryCell(task, rowIndex, taskIndex) {
  if (task.state === 'out_of_scope') return '<span class="muted" title="不在交付范围" aria-label="不在交付范围">—</span>';
  return `<button class="delivery-state-button" type="button" data-delivery-row="${rowIndex}" data-delivery-task="${taskIndex}" aria-label="${deliveryTitles[task.task]}，${deliveryStates[task.state][0]}">
    ${deliveryBadge(task)}${task.priority === 'urgent' ? priorityBadge(task.priority) : ''}
  </button>`;
}

function renderDeliveryGrid() {
  if (!deliveryData) return;
  const filter = $('delivery-filter').value;
  const search = $('delivery-search').value.trim().replace(/^《|》$/g, '').trim().toLowerCase();
  const rows = deliveryData.rows.map((row, rowIndex) => ({ row, rowIndex })).filter(({ row }) =>
    (!search || resultEpisodeLabel(row).toLowerCase().includes(search)) &&
    (!filter || (filter === 'ready' ? row.ready : row.tasks.some(task =>
      filter === 'urgent' ? task.priority === 'urgent' && task.state !== 'approved' : task.state === filter))),
  );
  rows.sort((a, b) => Number(b.row.tasks.some(task => task.priority === 'urgent' && task.state !== 'approved')) -
    Number(a.row.tasks.some(task => task.priority === 'urgent' && task.state !== 'approved')));
  const columns = Object.entries(deliveryTitles).map(([task, title]) => `<th${deliveryData.requiredTasks.includes(task) ? '' : ' class="muted"'}>${title}</th>`);
  $('delivery-grid').innerHTML = '<thead><tr><th>剧集</th>' + columns.join('') + '<th>下一步</th></tr></thead><tbody>' +
    (rows.map(({ row, rowIndex }) => {
      const next = row.tasks.map(task => ({ task, action: deliveryNext(task) })).filter(({ action }) => action);
      return `<tr><th scope="row">${esc(resultEpisodeLabel(row))}</th>
        ${row.tasks.map((task, taskIndex) => `<td>${deliveryCell(task, rowIndex, taskIndex)}</td>`).join('')}
        <td>${next.length ? next.map(({ task, action }) =>
          `<div>${esc(action)} <span class="muted">· ${deliveryTitles[task.task]}</span></div>`).join('')
          : row.ready ? '<span class="badge badge-ok">可交付</span>' : '—'}</td></tr>`;
    }).join('') || '<tr><td colspan="6" class="muted">没有符合条件的剧集。</td></tr>') + '</tbody>';
}

async function refreshDelivery() {
  const batch = $('rs-batch').value;
  const request = ++deliveryRequest;
  if ($('result-archive').open && batch) loadResults().catch(error => toast(error.message, true));
  deliveryData = undefined;
  $('delivery-grid').innerHTML = '';
  $('delivery-summary').innerHTML = '';
  $('delivery-scope').hidden = true;
  $('delivery-status').textContent = batch ? '正在读取进度…' : '请先导入批次。';
  if (!batch) return;
  try {
    const data = await api('/api/admin/batches/' + encodeURIComponent(batch) + '/delivery');
    if (request !== deliveryRequest) return;
    deliveryData = data;
    const { episodes, ready, waitingReview, rework } = data.summary;
    const metrics = [
      ['剧集总数', episodes, '集'], [data.configured ? '可交付' : '可交付（预估）', ready, '集'],
      ['待审核（含待指派）', waitingReview, '项'], ['返修中', rework, '项'],
    ];
    $('delivery-summary').innerHTML = metrics.map(([label, number, unit]) => `<div>
      <span>${label}</span><strong>${number}</strong> <span>${unit}</span></div>`).join('');
    const scope = data.requiredTasks.map(task => deliveryTitles[task]).join('、');
    $('delivery-scope-label').textContent = data.configured ? '交付范围 · ' + scope
      : scope ? '确认交付范围 · 当前按已派任务预估' : '设置交付范围';
    $('delivery-scope-form').innerHTML = '<p class="muted">勾选本批次每集须审核通过的任务。</p><div class="task-options">' +
      Object.entries(deliveryTitles).map(([key, title]) =>
        `<label><input type="checkbox" name="delivery-task" value="${key}"${data.requiredTasks.includes(key) ? ' checked' : ''}>${title}</label>`).join('') +
      '</div><button type="submit">保存交付范围</button>';
    $('delivery-scope').hidden = false;
    $('delivery-status').textContent = '';
    renderDeliveryGrid();
  } catch (error) {
    if (request === deliveryRequest) $('delivery-status').textContent = error.message;
  }
}

$('rs-batch').addEventListener('change', () => {
  $('delivery-scope').open = false;
  refreshDelivery();
});
$('delivery-search').addEventListener('input', renderDeliveryGrid);
$('delivery-filter').addEventListener('change', renderDeliveryGrid);
$('delivery-scope-form').addEventListener('submit', async event => {
  event.preventDefault();
  const batch = $('rs-batch').value;
  const form = event.currentTarget;
  const tasks = [...form.querySelectorAll('input:checked')].map(input => input.value);
  if (!tasks.length) return toast('请至少选一项交付任务', true);
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    await api('/api/admin/batches/' + encodeURIComponent(batch) + '/delivery', { method: 'PUT', body: { tasks } });
    if ($('rs-batch').value === batch) {
      $('delivery-scope').open = false;
      await refreshDelivery();
    }
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});

$('delivery-grid').addEventListener('click', async event => {
  const button = event.target.closest('[data-delivery-row]');
  if (!button || !deliveryData) return;
  const row = deliveryData.rows[Number(button.dataset.deliveryRow)];
  const task = row.tasks[Number(button.dataset.deliveryTask)];
  const request = ++deliveryDetailRequest;
  const dialog = $('delivery-detail');
  const body = $('delivery-detail-body');
  $('delivery-detail-title').textContent = resultEpisodeLabel(row) + ' · ' + deliveryTitles[task.task];
  const next = deliveryNext(task);
  body.innerHTML = `<p>${deliveryBadge(task)} ${task.required ? '' : '<span class="muted">不计入交付</span>'}</p>
    ${next ? `<p><strong>下一步</strong> ${esc(next)}</p>` : ''}
    ${task.note ? (task.state === 'rework' ? `<div class="rework-reason"><strong>返修原因</strong><span>${esc(task.note)}</span></div>` :
      `<p><strong>审核说明</strong> ${esc(task.note)}</p>`) : ''}
    ${task.version ? `<p class="delivery-current">${previewButton('/api/reviews/' + task.id + '/history/' + task.version, '查看最新结果')}</p><div id="delivery-history">正在读取历史版本…</div>` : ''}`;
  if (!dialog.open) dialog.showModal();
  if (!task.version) return;
  try {
    const { versions } = await api('/api/reviews/' + task.id + '/history');
    if (request !== deliveryDetailRequest || !dialog.open) return;
    $('delivery-history').innerHTML = '<h3>历史版本</h3><ul>' + versions.map(v => {
      const path = '/api/reviews/' + task.id + '/history/' + v.version;
      return `<li>${esc(reviewResult[v.kind])} · ${esc(v.author || '已停用账号')}
        · ${esc(new Date(v.created_at).toLocaleString())}
        ${v.note ? `<p>${esc(v.note)}</p>` : ''}
        ${previewButton(path, '查看结果')}
        ${v.has_timing ? previewButton(path + '?kind=timing', '查看工作记录') : ''}</li>`;
    }).join('') + '</ul>';
  } catch (error) {
    if (request === deliveryDetailRequest && dialog.open) $('delivery-history').textContent = error.message;
  }
});
