// popup.js - 弹出层：UID 输入 / 列表渲染 / 排序过滤 / 进度 / 多选批量操作
// 版本号以 manifest.json 为准

// 默认 UID 留空，由用户首次使用时自行填写
const DEFAULT_UID = '';
const UID_KEY = 'bili_uid';
// 注意：此键必须与 background.js 中的 CACHE_KEY 保持一致
const CACHE_KEY = 'bili_follow_cache';
// 用户偏好（排序方向 / 异常过滤）
const PREFS_KEY = 'bili_prefs';
// 数据超过该时长未更新则提示时效性
const UPDATED_WARN_MS = 24 * 60 * 60 * 1000;
const SEARCH_DEBOUNCE = 120;
// 查询完成后进度条补满停留的时长，避免进度条"凭空消失"
const FINISH_HOLD_MS = 420;
const FINISH_FADE_MS = 220;

// 停更时长分组：数组顺序即列表中的渲染顺序，maxDays 为该组的天数上界
const GROUPS = [
  { key: 'fresh',   label: '活跃 · 7 天内',          maxDays: 7 },
  { key: 'stale',   label: '偷懒 · 7 天 ~ 1 个月',    maxDays: 30 },
  { key: 'idle',    label: '久未更新 · 1 ~ 3 个月',   maxDays: 90 },
  { key: 'dormant', label: '长期断更 · 3 ~ 6 个月',   maxDays: 182 },
  { key: 'silent',  label: '疑似退圈 · 6 个月 ~ 1 年', maxDays: 365 },
  { key: 'retired', label: '基本退圈 · 1 年以上',      maxDays: Infinity },
  { key: 'error',   label: '查询失败',                maxDays: null }
];

const GROUP_LABEL = new Map(GROUPS.map(g => [g.key, g.label.split(' · ')[0]]));

// ---- 内联图标（统一 currentColor，避免 emoji 跨平台渲染不一致）----
const ICON = {
  reload: '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>',
  eye: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>',
  eyeOff: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>',
  warn: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
  info: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>',
  inbox: '<svg class="icon icon-lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path></svg>'
};

// ---- DOM ----
const $list = document.getElementById('list');
const $stats = document.getElementById('stats');
const $updatedAt = document.getElementById('updated-at');
const $statusBar = document.getElementById('status-bar');
const $statusStage = document.getElementById('status-stage');
const $statusCount = document.getElementById('status-count');
const $progressBar = document.getElementById('progress-bar');
const $progressFill = document.getElementById('progress-fill');
const $alert = document.getElementById('alert');
const $alertIcon = document.getElementById('alert-icon');
const $alertText = document.getElementById('alert-text');
const $alertClose = document.getElementById('alert-close');
const $btn = document.getElementById('refresh-btn');
const $cancelBtn = document.getElementById('cancel-btn');
const $panelBtn = document.getElementById('panel-btn');
const $settingsBtn = document.getElementById('settings-btn');
const $exportBtn = document.getElementById('export-btn');
const $clearBtn = document.getElementById('clear-btn');

// 侧边栏模式：popup 的宽度固定 400px、高度上限 600px，
// 侧边栏则占满整个侧栏高度。据此区分两种宿主环境，
// 避免依赖 manifest 的 default_path 带 query 参数（部分版本不接受）
const viewportIsPopupSized = window.innerWidth <= 400 && window.innerHeight <= 620;
const IS_PANEL = !viewportIsPopupSized;

if (IS_PANEL) {
  document.body.classList.add('is-panel');
} else if (!chrome.sidePanel || !chrome.windows) {
  $panelBtn.classList.add('is-hidden');
}
const $uidInput = document.getElementById('uid-input');
const $uidSaveBtn = document.getElementById('uid-save-btn');
const $searchInput = document.getElementById('search-input');
const $filterBtn = document.getElementById('filter-btn');
const $filterIcon = document.getElementById('filter-icon');
const $filterText = document.getElementById('filter-text');
const $bulkBar = document.getElementById('bulk-bar');
const $bulkCount = document.getElementById('bulk-count');
const $bulkOpen = document.getElementById('bulk-open');
const $bulkCopy = document.getElementById('bulk-copy');
const $bulkUnfollow = document.getElementById('bulk-unfollow');
const $confirmMask = document.getElementById('confirm-mask');
const $dialogBody = document.getElementById('dialog-body');
const $confirmOk = document.getElementById('confirm-ok');
const $confirmCancel = document.getElementById('confirm-cancel');

// ---- 状态 ----
let totalFromBackend = 0;
let currentUid = DEFAULT_UID;
let itemIndex = new Map();
// 分组容器：key -> { section, ul, count }
let groupEls = new Map();
// 是否隐藏异常 UP 主（默认隐藏）
let hideErrorItems = true;
// 搜索关键词（昵称或 UID）
let keyword = '';
// 当前列表数据的时间戳（毫秒）
let updatedAt = 0;
// 已勾选的 UP 主 mid 集合
let selected = new Set();
let $emptyEl = null;
let noticeTimer = null;
let searchTimer = null;
let finishTimer = null;

// ---- 过滤控件 ----
function applyFilter() {
  $filterIcon.innerHTML = hideErrorItems ? ICON.eyeOff : ICON.eye;
  $filterText.textContent = hideErrorItems ? '隐藏异常' : '显示异常';
  $filterBtn.title = hideErrorItems ? '点击显示异常 UP 主' : '点击隐藏异常 UP 主';
  $filterBtn.setAttribute('aria-pressed', String(hideErrorItems));
  $filterBtn.classList.toggle('chip-is-active', hideErrorItems);
}

// 判断一个 item 是否为异常
function isErrorItem(item) {
  return Boolean(item.error) || !item.lastVideoAt;
}

function isVisible(item) {
  if (hideErrorItems && isErrorItem(item)) return false;
  if (keyword) {
    const k = keyword.toLowerCase();
    const hit = String(item.name || '').toLowerCase().includes(k)
      || String(item.mid).includes(keyword);
    if (!hit) return false;
  }
  return true;
}

// ---- 统计 / 数据时效 ----
function updateStats() {
  const queried = itemIndex.size;
  $stats.textContent = '';

  if (queried === 0) {
    $stats.textContent = currentUid ? '暂无数据' : '未设置 UID';
    return;
  }

  const errorCount = Array.from(itemIndex.values()).filter(v => isErrorItem(v.item)).length;
  // 「已查询」统计的是真正拿到数据的条数，失败的条目不计入：
  // 这样批量重试把失败项救回来后，这个数字会跟着涨，能直观看出重试的成效
  const okCount = queried - errorCount;
  const total = totalFromBackend > 0 ? totalFromBackend : queried;
  const text = total > okCount
    ? `已查询 ${okCount} / 共 ${total} 个关注`
    : `已查询 ${okCount} 个关注`;

  $stats.appendChild(document.createTextNode(text));

  if (errorCount > 0) {
    $stats.appendChild(document.createTextNode(' · '));
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'stats-retry';
    retry.textContent = `${errorCount} 个失败`;
    retry.title = '点击重新查询这些失败的 UP 主';
    retry.addEventListener('click', retryFailed);
    $stats.appendChild(retry);
  }
}

function renderUpdatedAt() {
  if (!updatedAt) {
    $updatedAt.textContent = '';
    $updatedAt.classList.remove('is-old');
    return;
  }
  $updatedAt.textContent = `更新于 ${formatTimeAgo(Math.floor(updatedAt / 1000))}`;
  $updatedAt.classList.toggle('is-old', Date.now() - updatedAt > UPDATED_WARN_MS);
}

// 相对时间文案会随真实时间推移而过时。
// 单项刷新 / 批量重试完成后统一重算一次，保证列表里所有时间基于同一时刻
function refreshTimeLabels() {
  for (const entry of itemIndex.values()) {
    if (!entry.li || isErrorItem(entry.item)) continue;
    const time = entry.li.querySelector('.up-time');
    if (time) time.textContent = formatTimeAgo(entry.item.lastVideoAt);
  }
  renderUpdatedAt();
}

// popup 长时间开着时，每分钟校准一次相对时间
setInterval(refreshTimeLabels, 60 * 1000);

function clearAlertTimer() {
  if (noticeTimer) {
    clearTimeout(noticeTimer);
    noticeTimer = null;
  }
}

function showAlert(msg) {
  clearAlertTimer();
  $alert.classList.remove('is-info');
  $alert.classList.add('is-error');
  $alertIcon.innerHTML = ICON.warn;
  $alertText.textContent = msg;
  $alert.classList.remove('is-hidden');
}

// 轻量信息提示，2 秒后自动消失（不抢占用户的错误提示）
function showNotice(msg) {
  clearAlertTimer();
  $alert.classList.remove('is-error');
  $alert.classList.add('is-info');
  $alertIcon.innerHTML = ICON.info;
  $alertText.textContent = msg;
  $alert.classList.remove('is-hidden');
  noticeTimer = setTimeout(() => {
    if ($alert.classList.contains('is-info')) hideAlert();
  }, 2000);
}

function hideAlert() {
  clearAlertTimer();
  $alert.classList.add('is-hidden');
}

// ---- 进度条 ----
function showProgress(stage, current, total, eta) {
  $statusBar.classList.remove('is-hidden', 'is-indeterminate');
  $statusStage.textContent = stage;
  $statusCount.textContent = eta ? `${current}/${total} · ${eta}` : `${current}/${total}`;
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  $progressFill.style.width = `${pct}%`;
  $progressBar.setAttribute('aria-valuenow', String(pct));
}

// 进度未知时使用真正的 indeterminate 动画，而不是固定 40% 的假进度
function showIndeterminateProgress(stage, note) {
  $statusBar.classList.remove('is-hidden');
  $statusBar.classList.add('is-indeterminate');
  $statusStage.textContent = stage;
  $statusCount.textContent = note || '';
  // 清掉 inline width，让 CSS 的往复动画接管
  $progressFill.style.removeProperty('width');
  $progressBar.removeAttribute('aria-valuenow');
}

function hideProgress() {
  clearTimeout(finishTimer);
  finishTimer = null;
  $statusBar.classList.add('is-hidden');
  $statusBar.classList.remove('is-indeterminate', 'is-fading');
  $progressFill.style.width = '0%';
  $progressBar.setAttribute('aria-valuenow', '0');
}

// 完成态：进度条先补满并停留片刻，再淡出，让"查完了"这件事有明确视觉回调
function finishProgress() {
  clearTimeout(finishTimer);
  $statusBar.classList.remove('is-indeterminate');
  $progressFill.style.width = '100%';
  $progressBar.setAttribute('aria-valuenow', '100');
  finishTimer = setTimeout(() => {
    $statusBar.classList.add('is-fading');
    finishTimer = setTimeout(hideProgress, FINISH_FADE_MS);
  }, FINISH_HOLD_MS);
}

// 统一管理"查询中"的按钮状态，保证任何分支下都能恢复可点击
// 同时锁住批量操作，避免查询与取关并发导致的列表与账号数据不一致
function setBusy(busy) {
  $btn.disabled = busy;
  $btn.classList.toggle('is-spinning', busy);
  $cancelBtn.classList.toggle('is-hidden', !busy);
  $bulkOpen.disabled = busy;
  $bulkCopy.disabled = busy;
  $bulkUnfollow.disabled = busy;
}

// ---- 时间格式化 ----
function formatTimeAgo(ts) {
  if (!ts) return '从未更新';
  const now = Math.floor(Date.now() / 1000);
  const diff = now - ts;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  const days = Math.floor(diff / 86400);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}

// 判断一个 item 属于哪个停更分组
function classifyGroup(item) {
  if (isErrorItem(item)) return 'error';
  const days = (Date.now() / 1000 - item.lastVideoAt) / 86400;
  for (const grp of GROUPS) {
    if (grp.maxDays !== null && days < grp.maxDays) return grp.key;
  }
  return 'retired';
}

function formatEta(ms) {
  if (!ms || ms <= 0) return '';
  if (ms < 1000) return '剩余 <1秒';
  if (ms < 60000) return `剩余 ${Math.round(ms / 1000)}秒`;
  const min = Math.floor(ms / 60000);
  const sec = Math.round((ms % 60000) / 1000);
  return `剩余 ${min}分${sec}秒`;
}

// ---- 列表项 ----
function addTag(parent, text, className, title) {
  const tag = document.createElement('span');
  tag.className = `tag ${className}`;
  tag.textContent = text;
  if (title) tag.title = title;
  parent.appendChild(tag);
}

function buildItem(item) {
  const li = document.createElement('li');
  // 停更等级配色由所属分组的 --level-color 继承而来，节点跨组移动后自动跟随
  li.className = 'up-item';
  li.dataset.mid = item.mid;
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  li.title = `打开 ${item.name} 的主页`;

  const openProfile = () => chrome.tabs.create({ url: `https://space.bilibili.com/${item.mid}` });
  li.addEventListener('click', openProfile);
  li.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openProfile();
    }
  });

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'up-check';
  check.checked = selected.has(item.mid);
  check.setAttribute('aria-label', `选择 ${item.name}`);
  check.addEventListener('click', (e) => e.stopPropagation());
  check.addEventListener('change', () => {
    if (check.checked) selected.add(item.mid);
    else selected.delete(item.mid);
    syncBulkBar();
  });
  li.appendChild(check);

  const img = document.createElement('img');
  img.className = 'up-avatar';
  img.src = item.face || '';
  img.alt = '';
  img.loading = 'lazy';
  li.appendChild(img);

  const info = document.createElement('div');
  info.className = 'up-info';

  const nameRow = document.createElement('div');
  nameRow.className = 'up-name-row';
  const name = document.createElement('span');
  name.className = 'up-name';
  name.textContent = item.name;
  nameRow.appendChild(name);

  if (item.error) {
    addTag(nameRow, '查询失败', 'tag-warn');
  } else {
    if (item.type) addTag(nameRow, item.type, 'tag-type');
    if (item.isTop) addTag(nameRow, '置顶', 'tag-pin');
    if (item.polluted) addTag(nameRow, '可能不准', 'tag-warn', '数据来自 upstat 兜底接口，可能被置顶视频覆盖');
  }
  info.appendChild(nameRow);

  const meta = document.createElement('div');
  meta.className = 'up-meta';

  const time = document.createElement('span');
  time.className = 'up-time';
  if (item.error) {
    time.classList.add('is-error-msg');
    time.textContent = item.error;
    time.title = item.error;
  } else {
    time.textContent = formatTimeAgo(item.lastVideoAt);
  }
  meta.appendChild(time);

  // 最近更新内容的标题直接展示，无需悬停
  if (!item.error && item.lastVideoName) {
    const titleEl = document.createElement('span');
    titleEl.className = 'up-title';
    titleEl.textContent = item.lastVideoName;
    titleEl.title = item.lastVideoName;
    meta.appendChild(titleEl);
  }

  info.appendChild(meta);

  li.appendChild(info);

  // 单项刷新：只重查这一行，不影响其它条目
  const rowRefresh = document.createElement('button');
  rowRefresh.type = 'button';
  rowRefresh.className = 'up-refresh';
  rowRefresh.title = `重新查询 ${item.name}`;
  rowRefresh.setAttribute('aria-label', `重新查询 ${item.name}`);
  rowRefresh.innerHTML = ICON.reload;
  rowRefresh.addEventListener('click', (e) => {
    e.stopPropagation();
    refreshOneItem(item.mid);
  });
  li.appendChild(rowRefresh);

  return li;
}

// ---- 分组容器 ----
// 一次性按 GROUPS 顺序建好全部组外壳，空组通过 is-hidden 收起
function buildGroupShell() {
  $list.innerHTML = '';
  groupEls.clear();
  for (const grp of GROUPS) {
    const section = document.createElement('section');
    section.className = 'group is-hidden';
    section.dataset.group = grp.key;

    const head = document.createElement('div');
    head.className = 'group-head';
    const dot = document.createElement('span');
    dot.className = 'group-dot';
    dot.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'group-name';
    name.textContent = grp.label;
    const count = document.createElement('span');
    count.className = 'group-count';
    head.append(dot, name, count);

    // 「查询失败」组提供一个批量重试入口
    if (grp.key === 'error') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'group-retry';
      retry.textContent = '全部重试';
      retry.title = '重新查询所有失败的 UP 主';
      retry.addEventListener('click', retryFailed);
      head.appendChild(retry);
    }

    const ul = document.createElement('ul');
    ul.className = 'group-list';

    section.append(head, ul);
    $list.appendChild(section);
    groupEls.set(grp.key, { section, ul, count });
  }
}

function syncGroupShell() {
  for (const [, g] of groupEls) {
    const n = g.ul.children.length;
    g.count.textContent = n > 0 ? String(n) : '';
    g.section.classList.toggle('is-hidden', n === 0);
  }
}

function clearEmpty() {
  if ($emptyEl) {
    $emptyEl.remove();
    $emptyEl = null;
  }
}

function renderEmpty(title, desc, action) {
  clearEmpty();
  const box = document.createElement('div');
  box.className = 'empty';

  const icon = document.createElement('div');
  icon.className = 'empty-icon';
  icon.innerHTML = ICON.inbox;

  const titleEl = document.createElement('div');
  titleEl.className = 'empty-title';
  titleEl.textContent = title;

  const descEl = document.createElement('div');
  descEl.className = 'empty-desc';
  descEl.textContent = desc;

  box.append(icon, titleEl, descEl);

  if (action) {
    const btn = document.createElement('button');
    btn.className = 'btn-primary empty-action';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    box.appendChild(btn);
  }

  $list.appendChild(box);
  $emptyEl = box;
}

// 加载骨架屏：查询进行中给列表区一个占位形态，避免大片空白
function renderSkeleton(count) {
  clearEmpty();
  const box = document.createElement('div');
  box.className = 'skeleton-list';
  for (let i = 0; i < count; i++) {
    const row = document.createElement('div');
    row.className = 'skeleton-row';
    row.innerHTML =
      '<span class="skeleton-avatar"></span>' +
      '<span class="skeleton-lines">' +
      '<span class="skeleton-line"></span>' +
      '<span class="skeleton-line is-short"></span>' +
      '</span>';
    box.appendChild(row);
  }
  $list.appendChild(box);
  $emptyEl = box;
}

// 列表为空时给出解释，避免"数字有值但列表一片空白"
function refreshEmptyState() {
  if ($list.querySelector('.up-item')) {
    clearEmpty();
    return;
  }
  const items = Array.from(itemIndex.values()).map(v => v.item);
  if (items.length === 0) return; // 保留调用方设置的初始空态文案

  // 搜索无结果时优先提示搜索相关
  if (keyword) {
    const k = keyword.toLowerCase();
    const matched = items.filter(i =>
      String(i.name || '').toLowerCase().includes(k) || String(i.mid).includes(keyword)
    );
    if (matched.length === 0) {
      renderEmpty(
        '没有匹配的 UP 主',
        `没有找到与「${keyword}」相关的昵称或 UID`,
        {
          label: '清除搜索',
          onClick: () => {
            $searchInput.value = '';
            keyword = '';
            rerenderList();
          }
        }
      );
      return;
    }
  }

  const errorCount = items.filter(isErrorItem).length;
  if (errorCount === items.length) {
    renderEmpty(
      `${items.length} 个 UP 主查询失败`,
      '可能是接口限流或登录态过期，也可能是账号已注销',
      {
        label: '显示异常项',
        onClick: () => {
          hideErrorItems = false;
          applyFilter();
          savePrefs();
          rerenderList();
        }
      }
    );
    return;
  }

  renderEmpty('当前筛选下没有可显示的 UP 主', '可尝试切换「显示异常」以查看全部数据');
}

// 按发布时间倒序插入到所属分组内
function insertIntoGroup(li, item) {
  const g = groupEls.get(classifyGroup(item));
  if (!g) return;
  const ts = item.lastVideoAt || 0;
  for (const child of Array.from(g.ul.children)) {
    const entry = itemIndex.get(parseInt(child.dataset.mid, 10));
    if (!entry) continue;
    if ((entry.item.lastVideoAt || 0) < ts) {
      g.ul.insertBefore(li, child);
      return;
    }
  }
  g.ul.appendChild(li);
}

// 按当前分组与过滤规则同步单个 item 的 DOM
function syncItem(item) {
  const existed = itemIndex.get(item.mid);
  if (existed && existed.li) {
    existed.li.remove();
    existed.li = null;
  }

  if (!isVisible(item)) {
    itemIndex.set(item.mid, { item, li: null });
    syncGroupShell();
    return;
  }

  const li = buildItem(item);
  itemIndex.set(item.mid, { item, li });
  insertIntoGroup(li, item);
  syncGroupShell();
}

// 在指定容器内按目标顺序摆放节点：只移动需要移动的节点，其余保持原样
function reorderDom(container, nodes) {
  let ref = container.firstElementChild;
  for (const node of nodes) {
    if (node === ref) {
      ref = ref.nextElementSibling;
    } else {
      container.insertBefore(node, ref);
    }
  }
}

// 分组 / 过滤 / 搜索变化时重排列表：
// 复现已有的 li 节点，只在可见性变化时构建或移除节点，避免整列表重建导致的闪烁与卡顿
function rerenderList() {
  const entries = Array.from(itemIndex.values());

  for (const entry of entries) {
    const visible = isVisible(entry.item);
    if (visible && !entry.li) {
      entry.li = buildItem(entry.item);
    } else if (!visible && entry.li) {
      entry.li.remove();
      entry.li = null;
    }
  }

  for (const grp of GROUPS) {
    const g = groupEls.get(grp.key);
    if (!g) continue;
    const nodes = entries
      .filter(e => e.li && classifyGroup(e.item) === grp.key)
      .sort((a, b) => (b.item.lastVideoAt || 0) - (a.item.lastVideoAt || 0))
      .map(e => e.li);
    reorderDom(g.ul, nodes);
  }

  clearEmpty();
  syncGroupShell();
  updateStats();
  refreshEmptyState();
}

function resetView() {
  itemIndex.clear();
  selected.clear();
  buildGroupShell();
  $emptyEl = null;
  syncBulkBar();
  updateStats();
}

// ---- 多选与批量操作 ----
function syncBulkBar() {
  const n = selected.size;
  $bulkCount.textContent = `已选 ${n} 项`;
  $bulkBar.classList.toggle('is-hidden', n === 0);
}

function removeItem(mid) {
  const entry = itemIndex.get(mid);
  if (entry && entry.li) entry.li.remove();
  itemIndex.delete(mid);
  selected.delete(mid);
  syncGroupShell();
}

// 单项刷新：只重查一个 UP 主并就地更新该行
async function refreshOneItem(mid) {
  const entry = itemIndex.get(mid);
  if (!entry || entry.loading) return;

  entry.loading = true;
  if (entry.li) entry.li.classList.add('is-loading');

  const resp = await chrome.runtime.sendMessage({ type: 'refresh-one', mid }).catch(() => null);
  entry.loading = false;

  if (!resp || resp.ok === false) {
    if (entry.li) entry.li.classList.remove('is-loading');
    showAlert((resp && resp.error) || '单项刷新失败，请重试');
    return;
  }

  const next = { mid, name: entry.item.name, face: entry.item.face, ...resp.stat };
  syncItem(next); // syncItem 会重建该行节点并归入新的分组
  updateStats();
  refreshTimeLabels(); // 其它条目的相对时间一并对齐到同一时刻
  showNotice(`已更新 ${next.name}`);
}

// 批量重试所有查询失败的 UP 主
// 具体的重试由 background 执行：popup 关闭后任务继续跑，结果也会逐条写回缓存。
// 这里只负责发起任务、消费流式消息（在 attachStreamListener 里）、最后给出结论
let retrying = false;

async function retryFailed() {
  if (retrying) return;

  const queue = Array.from(itemIndex.values()).filter(e => isErrorItem(e.item));
  if (queue.length === 0) {
    showNotice('当前没有查询失败的 UP 主');
    return;
  }

  retrying = true;
  hideAlert();
  setBusy(true);
  showIndeterminateProgress('正在重新查询失败的 UP 主');

  const resp = await chrome.runtime.sendMessage({ type: 'retry-failed', mid: currentUid }).catch(() => null);

  retrying = false;
  setBusy(false);
  finishProgress();
  updateStats();
  refreshEmptyState();
  refreshTimeLabels(); // 与单项刷新保持一致：全列表时间基准统一

  if (!resp || resp.ok === false) {
    showAlert((resp && resp.error) || '重新查询失败，请重试');
    return;
  }
  if (resp.canceled) {
    showNotice('重新查询被新的查询中断');
    return;
  }
  if (resp.total === 0) {
    showNotice('没有需要重新查询的 UP 主');
  } else if (resp.failCount === 0) {
    showNotice(`已重新查询 ${resp.okCount} 个 UP 主，全部成功`);
  } else {
    showAlert(`${resp.okCount} 个成功，${resp.failCount} 个仍然失败`);
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (err) {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

// 取关成功后同步把缓存里的对应项剔除，避免下次打开又看到已取关的人
async function pruneCache(mids) {
  const dead = new Set(mids);
  return new Promise((resolve) => {
    chrome.storage.local.get([CACHE_KEY], (data) => {
      const cached = data[CACHE_KEY];
      if (!cached || !Array.isArray(cached.items)) return resolve();
      const items = cached.items.filter(i => !dead.has(i.mid));
      chrome.storage.local.set({ [CACHE_KEY]: { ...cached, items } }, resolve);
    });
  });
}

// ---- 导出 CSV 报告 ----
function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function formatDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function buildCsv() {
  const groupOrder = new Map(GROUPS.map((g, i) => [g.key, i]));
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = [['昵称', 'UID', '停更分组', '最后更新', '停更天数', '内容类型', '最近内容', '备注']];

  const items = Array.from(itemIndex.values())
    .map(e => e.item)
    .sort((a, b) => {
      const ga = groupOrder.get(classifyGroup(a));
      const gb = groupOrder.get(classifyGroup(b));
      if (ga !== gb) return ga - gb; // 与界面分组顺序保持一致
      return (b.lastVideoAt || 0) - (a.lastVideoAt || 0);
    });

  for (const item of items) {
    const ts = item.lastVideoAt || 0;
    const notes = [];
    if (item.isTop) notes.push('置顶内容');
    if (item.polluted) notes.push('upstat 兜底，可能不准');
    if (item.error) notes.push(item.error);

    rows.push([
      item.name,
      item.mid,
      GROUP_LABEL.get(classifyGroup(item)) || '',
      formatDateTime(ts),
      ts ? Math.floor((nowSec - ts) / 86400) : '',
      item.type || '',
      item.lastVideoName || '',
      notes.join('；')
    ]);
  }

  // 加 BOM，便于 Excel 正确识别 UTF-8
  return '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
}

function downloadFile(filename, content) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$exportBtn.addEventListener('click', () => {
  if (itemIndex.size === 0) {
    showAlert('暂无可导出的数据，请先查询关注列表');
    return;
  }
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  downloadFile(`bili-follow-${currentUid}-${stamp}.csv`, buildCsv());
  showNotice(`已导出 ${itemIndex.size} 条记录`);
});

// ---- 设置页 ----
$settingsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

// ---- 侧边栏 ----
if (!IS_PANEL && chrome.sidePanel && chrome.windows) {
  $panelBtn.addEventListener('click', async () => {
    try {
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: win.id });
      window.close(); // 避免 popup 与侧边栏同时存在
    } catch (e) {
      showAlert(`无法打开侧边栏：${(e && e.message) || '未知错误'}`);
    }
  });
}

// ---- 清空本地缓存 ----
$clearBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'cancel' }).catch(() => {});
  await clearCache();
  setBusy(false);
  hideProgress();
  hideAlert();
  updatedAt = 0;
  renderUpdatedAt();
  resetView();
  renderEmpty('本地缓存已清空', '点击右上角刷新按钮可重新查询关注列表');
  showNotice('已清空本地缓存');
});

$bulkOpen.addEventListener('click', () => {
  for (const mid of selected) {
    chrome.tabs.create({ url: `https://space.bilibili.com/${mid}` });
  }
});

$bulkCopy.addEventListener('click', async () => {
  const ok = await copyText(Array.from(selected).join('\n'));
  if (ok) showNotice(`已复制 ${selected.size} 个 UID`);
  else showAlert('复制失败，请手动选择复制');
});

$bulkUnfollow.addEventListener('click', () => {
  const items = Array.from(selected)
    .map(mid => itemIndex.get(mid)?.item)
    .filter(Boolean);
  if (items.length === 0) return;

  const preview = items.slice(0, 6).map(i => `· ${i.name}`).join('\n');
  const more = items.length > 6 ? `\n…以及其他 ${items.length - 6} 个` : '';
  $dialogBody.textContent =
    `将取消关注以下 ${items.length} 个 UP 主：\n\n${preview}${more}\n\n` +
    '该操作会真实修改你的 B 站关注列表，且无法一键撤销。';
  $confirmMask.classList.remove('is-hidden');
  $confirmOk.focus();
});

function closeDialog() {
  $confirmMask.classList.add('is-hidden');
}

$confirmCancel.addEventListener('click', closeDialog);
$confirmMask.addEventListener('click', (e) => {
  if (e.target === $confirmMask) closeDialog();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$confirmMask.classList.contains('is-hidden')) closeDialog();
});

$confirmOk.addEventListener('click', async () => {
  const mids = Array.from(selected);
  if (mids.length === 0) {
    closeDialog();
    return;
  }
  closeDialog();
  hideAlert();
  setBusy(true);
  showProgress('正在取关', 0, mids.length, '');

  const resp = await chrome.runtime.sendMessage({ type: 'unfollow', mids }).catch(() => null);

  setBusy(false);

  if (!resp || resp.ok === false) {
    hideProgress();
    showAlert((resp && resp.error) || '取关失败，请重试');
    return;
  }

  finishProgress();

  for (const mid of resp.succeeded) removeItem(mid);
  selected.clear();
  // 失败项保留勾选状态，便于直接重试
  for (const f of resp.failed) selected.add(f.mid);
  syncBulkBar();
  await pruneCache(resp.succeeded);
  updateStats();
  refreshEmptyState();

  if (resp.failed.length === 0) {
    showNotice(`已成功取关 ${resp.succeeded.length} 个 UP 主`);
  } else {
    showAlert(`取关完成：成功 ${resp.succeeded.length} 个，失败 ${resp.failed.length} 个。失败的项已保留勾选，可再次点击「批量取关」重试`);
  }
});

// ---- 消息监听 ----
function attachStreamListener() {
  if (window._streamListener) {
    chrome.runtime.onMessage.removeListener(window._streamListener);
  }

  const listener = (msg) => {
    if (msg.type === 'item') {
      const p = msg.payload;
      // 只接受当前 UID 的任务推送，避免切换 UID 后旧任务数据串台
      if (p.mid !== currentUid) return;
      syncItem(p.item);
      updateStats();
      refreshEmptyState();
    } else if (msg.type === 'progress') {
      const p = msg.payload;
      if (p.mid !== currentUid) return;
      if (p.stage === 'followings') {
        totalFromBackend = p.total; // 记下 B 站返回的真实总数
        showProgress('获取关注列表', p.current, p.total, '');
      } else if (p.stage === 'stats') {
        // label 由 background 给出，区分「全量查询」与「批量重试」
        showProgress(p.label || '查询更新时间', p.current, p.total, formatEta(p.etaMs));
      } else if (p.stage === 'cooldown') {
        // 风控冷却：进度条停在当前位置，文案显示倒计时，避免看起来像卡死
        showProgress(p.label, p.current, p.total, '');
      }
    } else if (msg.type === 'unfollow-progress') {
      const p = msg.payload;
      showProgress('正在取关', p.current, p.total, '');
    } else if (msg.type === 'task-state') {
      const t = msg.payload;
      if (t.mid && t.mid !== currentUid) return;
      const isRetry = t.kind === 'retry';
      if (t.status === 'running') {
        setBusy(true);
        if (isRetry) showIndeterminateProgress('正在重新查询失败的 UP 主');
      } else if (t.status === 'done') {
        setBusy(false);
        finishProgress();
        // 重试只是补查失败项，「上次全量查询时间」不应被它刷新
        if (!isRetry) updatedAt = t.finishedAt || Date.now();
        updateStats();
        if (itemIndex.size === 0) {
          renderEmpty('暂无关注', '快去 B 站关注一些 UP 主吧');
        } else {
          refreshEmptyState();
        }
        // 流式查询跨越数分钟时，各行时间基于不同时刻算出，这里统一重算
        refreshTimeLabels();
      } else if (t.status === 'error') {
        setBusy(false);
        hideProgress();
        showAlert(t.error || '查询失败');
      } else {
        setBusy(false);
        hideProgress();
      }
    }
  };
  window._streamListener = listener;
  chrome.runtime.onMessage.addListener(listener);
}

// 建立 keepalive 长连接（防 Service Worker 被休眠）
function connectKeepAlive() {
  if (window._keepAlivePort) return;
  try {
    window._keepAlivePort = chrome.runtime.connect({ name: 'keepalive' });
    window._keepAlivePort.onDisconnect.addListener(() => {
      window._keepAlivePort = null;
    });
  } catch (e) {
    // ignore
  }
}

// ---- 存储 ----
// 缓存由 background.js 在任务结束后写入，popup 只负责读取
async function loadFromCache() {
  return new Promise((resolve) => {
    chrome.storage.local.get([CACHE_KEY], (data) => {
      const cached = data[CACHE_KEY];
      if (!cached) return resolve(null);
      // 缓存默认不过期，直到切 UID 或手动刷新才清除
      if (cached.uid && cached.uid !== currentUid) return resolve(null);
      resolve(cached);
    });
  });
}

async function clearCache() {
  return new Promise((resolve) => {
    chrome.storage.local.remove([CACHE_KEY], resolve);
  });
}

// 异常过滤属于长期偏好，持久化后每次打开 popup 保持一致
async function loadPrefs() {
  return new Promise((resolve) => {
    chrome.storage.local.get([PREFS_KEY], (data) => {
      resolve(data[PREFS_KEY] || {});
    });
  });
}

async function savePrefs() {
  // 合并写入，避免覆盖设置页存进同一个键里的反风控开关
  const prefs = await loadPrefs();
  return new Promise((resolve) => {
    chrome.storage.local.set({
      [PREFS_KEY]: { ...prefs, hideErrorItems }
    }, resolve);
  });
}

async function loadStoredUid() {
  return new Promise((resolve) => {
    chrome.storage.local.get([UID_KEY], (data) => {
      resolve(data[UID_KEY] || DEFAULT_UID);
    });
  });
}

async function saveStoredUid(uid) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [UID_KEY]: uid }, resolve);
  });
}

// ---- 查询流程 ----
function startQuery() {
  if (!currentUid) {
    showAlert('请先填写并保存你的 B 站 UID');
    return;
  }
  hideAlert();
  resetView();
  hideProgress();
  updatedAt = 0;
  renderUpdatedAt();
  setBusy(true);
  showIndeterminateProgress('正在启动查询…');
  // 用骨架屏占位，首条结果到达时会被自动替换，不留裸空白
  renderSkeleton(5);

  chrome.runtime.sendMessage({ type: 'reset', mid: currentUid })
    .then((resp) => {
      if (resp && resp.ok === false) {
        setBusy(false);
        hideProgress();
        showAlert(resp.error || '查询失败');
      }
    })
    .catch(() => {
      setBusy(false);
      hideProgress();
      showAlert('无法与后台通信，请重新加载扩展后重试');
    });
}

$btn.addEventListener('click', startQuery);

$cancelBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'cancel' }).catch(() => {});
  setBusy(false);
  hideProgress();
  if (itemIndex.size === 0) {
    renderEmpty('已停止查询', '点击右上角刷新按钮可重新开始');
  }
});

// ---- UID 保存：一步到位（保存 + 立即查询）----
$uidSaveBtn.addEventListener('click', async () => {
  const newUid = parseInt($uidInput.value.trim(), 10);
  if (!newUid || newUid <= 0) {
    showAlert('请输入有效的 B 站 UID（个人空间地址后的数字）');
    return;
  }

  if (newUid !== currentUid) {
    // 切换 UID 前先让后台的旧任务失效，避免旧数据混入新列表
    await chrome.runtime.sendMessage({ type: 'cancel' }).catch(() => {});
    await saveStoredUid(newUid);
    currentUid = newUid;
    totalFromBackend = 0;
    // 搜索条件属于上一个 UID 的上下文，一并清空
    $searchInput.value = '';
    keyword = '';
    await clearCache();
  }

  startQuery();
});

$uidInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $uidSaveBtn.click();
});

// ---- 过滤 / 搜索 ----
$filterBtn.addEventListener('click', () => {
  hideErrorItems = !hideErrorItems;
  applyFilter();
  savePrefs();
  rerenderList();
});

$searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    keyword = $searchInput.value.trim();
    rerenderList();
  }, SEARCH_DEBOUNCE);
});

$alertClose.addEventListener('click', hideAlert);

// ---- 启动 ----
async function bootstrap() {
  attachStreamListener();
  connectKeepAlive();
  syncBulkBar();
  buildGroupShell();

  // 恢复上次的异常过滤偏好
  const prefs = await loadPrefs();
  if (typeof prefs.hideErrorItems === 'boolean') hideErrorItems = prefs.hideErrorItems;
  applyFilter();

  currentUid = await loadStoredUid();
  $uidInput.value = currentUid;

  // 未配置 UID 时给出获取路径引导，不发起任何查询
  if (!currentUid) {
    updateStats();
    renderUpdatedAt();
    renderEmpty(
      '先设置你的 B 站 UID',
      'UID 就是你个人空间地址 space.bilibili.com/ 后面那串数字',
      {
        label: '打开 B 站获取 UID',
        onClick: () => chrome.tabs.create({ url: 'https://space.bilibili.com' })
      }
    );
    return;
  }

  const cached = await loadFromCache();
  if (cached && cached.items && cached.items.length > 0) {
    totalFromBackend = cached.items.length;
    updatedAt = cached.ts || 0;
    for (const item of cached.items) syncItem(item);
    updateStats();
    renderUpdatedAt();
    refreshEmptyState();
  } else {
    updateStats();
    renderUpdatedAt();
    renderEmpty('点击右上角刷新开始查询', `UID ${currentUid} 的关注列表`);
  }

  // 纯手动模式：popup 打开不自动触发任何查询
  // 只监听后台是否在跑（可能用户上一次点过刷新还没跑完）
  const stateResp = await chrome.runtime.sendMessage({ type: 'query-state' }).catch(() => null);
  const task = stateResp && stateResp.task;
  if (!task) return;
  if (task.mid && task.mid !== currentUid) return;

  if (task.status === 'running') {
    setBusy(true);
    // 后台任务可能是上一次没跑完的全量查询，也可能是批量重试
    showIndeterminateProgress(task.kind === 'retry' ? '正在重新查询失败的 UP 主' : '后台查询中');
  } else if (task.status === 'error') {
    setBusy(false);
    showAlert(task.error || '上次查询失败');
  } else {
    setBusy(false);
    hideProgress();
  }
}

bootstrap();
