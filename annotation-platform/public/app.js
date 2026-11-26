/* Shared frontend helpers for the annotation-platform portal. */

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.status === 401 && path !== '/api/auth/login') {
    window.location.href = '/login.html';
    throw new Error('未登录');
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `请求失败 (${res.status})`);
  }
  return data;
}

async function me() {
  try {
    const r = await api('/api/auth/me');
    return r.user;
  } catch {
    return null;
  }
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } finally {
    window.location.href = '/login.html';
  }
}

function toast(msg, isError = false) {
  const box = document.createElement('div');
  box.className = 'toast' + (isError ? ' toast-error' : '');
  box.textContent = msg;
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 3200);
}

function taskTitle(task) {
  const map = {
    people: '人物与对白',
    assets: '场景道具',
    shots: '镜头',
    story: '剧情',
  };
  return map[task] || task;
}

const reviewStatus = { unassigned: '待管理员指派', review: '待复核', rework: '待返修', approved: '已通过' };
const reviewResult = { submitted: '原始提交', pass: '通过', fixed: '修正后通过', return: '退回返修', reworked: '返修提交' };
const annotationPages = { people: 'people.html', assets: 'assets.html', shots: 'shots.html', story: 'story.html' };

function languageKey(lang) {
  if (/^(zh|cmn|yue)(?:[-_]|$)/i.test(lang || '')) return 'zh';
  if (/^en(?:[-_]|$)/i.test(lang || '')) return 'en';
  return 'other';
}

function languageName(lang) {
  return { zh: '中文', en: '英文', other: '其他' }[languageKey(lang)];
}

function priorityBadge(priority, showNormal = false) {
  if (priority === 'urgent') return '<span class="badge badge-urgent">紧急</span>';
  if (priority === 'high') return '<span class="badge badge-warn">优先</span>';
  return showNormal ? '<span class="badge badge-muted">普通</span>' : '';
}

function formatDramaTitle(value, fallback = '未命名剧集') {
  const title = String(value ?? '').trim();
  if (!title) return fallback;
  return title.startsWith('《') && title.endsWith('》') ? title : '《' + title + '》';
}
