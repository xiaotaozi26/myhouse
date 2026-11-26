/* Admin preview of the files already available through the protected download routes. */
function previewButton(url, label) {
  return `<button type="button" class="small" data-preview="${esc(url)}">${esc(label)}</button>`;
}

function resultEpisodeLabel(episode) {
  const number = String(episode.episode_id ?? '').match(/^(?:ep)?0*(\d+)$/i);
  const title = formatDramaTitle(episode.title);
  return number ? `${title} 第 ${Number(number[1])} 集` : title;
}

const previewFields = {
  characters: '人物', story_characters: '人物', character_candidates: '人物候选',
  name: '名称', name_candidate: '名称', character_name: '人物名称', character_description: '人物描述',
  episode_summary: '本集概述', story_summary: '剧情概述', uncertain_observations: '待确认事项',
  scene_observations: '场景', prop_observations: '道具', split_on_screen_text: '画面文字',
  sample_dispositions: '采样帧', visual_description: '可见外观', story_function: '剧情作用',
  owner_or_association: '归属', text: '文字', kind: '类别', category: '类别',
  evidence_refs: '证据', evidence: '依据', confidence: '置信度',
  segments: '分段', shots: '镜头', dialogue: '对白', description: '描述', note: '说明',
  local_start: '段内开始时间（秒）', local_end: '段内结束时间（秒）',
  start: '开始时间（秒）', end: '结束时间（秒）', source_audio_interpretation: '对白内容',
  speaker: '说话人', story_beat: '剧情进展', primary_events: '事件', events: '事件',
  core_events: '核心事件', character_bios: '人物小传', opening: '开头', ending: '结尾',
};
const previewModules = { G1: '人物', G2: '场景道具', G3: '镜头与对白', S: '剧情' };

function resultFields(value) {
  if (Array.isArray(value)) {
    const entries = value.map(resultFields).filter(Boolean);
    return entries.length ? '<ol>' + entries.map(entry => '<li>' + entry + '</li>').join('') + '</ol>' : '';
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([key]) => Object.hasOwn(previewFields, key))
      .map(([key, item]) => [previewFields[key], resultFields(item)])
      .filter(([, item]) => item);
    return entries.length ? '<dl>' + entries.map(([label, item]) => `<dt>${label}</dt><dd>${item}</dd>`).join('') + '</dl>' : '';
  }
  return typeof value === 'boolean' ? (value ? '是' : '否') : esc(value);
}

function renderResultPreview(raw) {
  const data = JSON.parse(raw);
  const episodes = Array.isArray(data) ? data : data.rows;
  if (!Array.isArray(episodes) || !episodes.length) throw Error('此文件没有可查看的标注结果');
  return episodes.map(episode => {
    const outputs = episode.final_annotation?.task_outputs || {};
    const sections = Object.entries(outputs).map(([key, output]) => {
      const fields = resultFields(output);
      return fields ? `<h4>${esc(previewModules[key] || '标注内容')}</h4>${fields}` : '';
    }).join('');
    return `<section><h3>${esc(resultEpisodeLabel(episode))}</h3>${sections || '<p class="muted">请展开完整标注数据查看。</p>'}
      <details><summary>完整标注数据</summary><pre>${esc(JSON.stringify(outputs, null, 2))}</pre></details></section>`;
  }).join('');
}

const timingFields = {
  operator: '处理人', started_at: '开始时间', finished_at: '完成时间', active_minutes: '有效用时（分钟）',
  blocked_minutes: '阻塞时长（分钟）', blocker: '备注', round: '轮次', qc_verdict: '审核结论',
  missed_edits: '漏改数', wrong_edits: '改错数',
};

function renderTimingPreview(raw) {
  const rows = [];
  let fields = [];
  const contents = raw.replace(/^\uFEFF/, '').replace(/\r?\n$/, '');
  for (const [, value, delimiter] of contents.matchAll(/("(?:[^"]|"")*"|[^",\r\n]*)(,|\r\n|\n|\r|$)/gy)) {
    fields.push(value.startsWith('"') ? value.slice(1, -1).replace(/""/g, '"') : value);
    if (delimiter !== ',') {
      rows.push(fields);
      fields = [];
      if (!delimiter) break;
    }
  }
  const columns = (rows.shift() || []).map((key, index) => ({ key, index }))
    .filter(({ key }) => Object.hasOwn(timingFields, key));
  if (!rows.length || !columns.length) return `<pre>${esc(raw)}</pre>`;
  const label = ({ key, index }, row) => {
    const value = row[index];
    if (!value) return '—';
    if (key.endsWith('_at')) {
      const date = new Date(value);
      if (!Number.isNaN(date.valueOf())) return date.toLocaleString();
    }
    return value;
  };
  return '<table><thead><tr>' + columns.map(({ key }) => `<th>${timingFields[key]}</th>`).join('') + '</tr></thead><tbody>' +
    rows.map(row => '<tr>' + columns.map(col => `<td>${esc(label(col, row))}</td>`).join('') + '</tr>').join('') +
    '</tbody></table>';
}

const previewDialog = $('result-preview');
let previewRequest;
previewDialog.addEventListener('close', () => previewRequest?.abort());
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-preview]');
  if (!button) return;
  previewRequest?.abort();
  const request = new AbortController();
  previewRequest = request;
  const url = new URL(button.dataset.preview, location.origin);
  const body = $('result-preview-body');
  const download = $('result-preview-download');
  $('result-preview-title').textContent = button.textContent;
  body.textContent = '正在读取…';
  download.hidden = true;
  if (!previewDialog.open) previewDialog.showModal();
  try {
    const response = await fetch(url, { signal: request.signal, cache: 'no-store' });
    if (!response.ok) throw Error('文件暂时无法读取，请关闭后重试');
    const raw = await response.text();
    if (request.signal.aborted) return;
    body.innerHTML = url.searchParams.get('kind') === 'timing' ? renderTimingPreview(raw) : renderResultPreview(raw);
    download.href = url.href;
    download.hidden = false;
  } catch (error) {
    if (!request.signal.aborted) body.textContent = error.message;
  }
});
