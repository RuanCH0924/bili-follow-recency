// background.js - 后台服务：关注列表拉取 / 最近更新查询 / 任务状态机 / 缓存 / 批量取关 / 自动化
// 版本号以 manifest.json 为准

const BILI_API = 'https://api.bilibili.com';
const PAGE_SIZE = 50;
const REQUEST_INTERVAL = 80;
const REQUEST_TIMEOUT = 10000;
const RETRY_DELAY = 300;
const UNFOLLOW_INTERVAL = 400;
// 注意：此键必须与 popup.js 中的 CACHE_KEY 保持一致
const CACHE_KEY = 'bili_follow_cache';
// 注意：此键必须与 popup.js / options.js 中的 PREFS_KEY 保持一致
const PREFS_KEY = 'bili_prefs';
const BUVID4_KEY = 'bili_buvid4';
// 注意：此键必须与 popup.js 中的 UID_KEY 保持一致
const UID_KEY = 'bili_uid';
// 界面形态记忆（上次用的是弹窗还是侧边栏）；注意：此键必须与 popup.js 中的 UI_KEY 保持一致
const UI_KEY = 'bili_ui';
// 图标默认弹出 popup；切成侧边栏模式后要把它摘掉
const POPUP_PATH = 'popup.html';

// ---- 反风控（-352 风控校验失败）相关 ----
// 命中这些 code 说明整个请求链路已被限流，而不是单个 UP 主没数据
const RISK_CODES = new Set([-352, -412, -509, -799]);

// 各开关与并发数的默认值；用户可在设置页逐项调整
// 「请求节奏拟人化」与「风控熔断」默认关闭：前者会明显拖慢查询，后者会让进度条长时间停留，
// 两者都需要用户看过利弊说明后主动开启
const DEFAULT_ANTI_RISK = { pacing: false, cooldown: false, deviceId: true, concurrency: 3 };

// 并发数取值区间（设置页以分段选择器呈现）
const CONCURRENCY_MIN = 1;
const CONCURRENCY_MAX = 5;

// 组 1 拟人化节奏：牺牲速度换取更低的机器特征（并发数已拆成独立设置项）
const PACING = {
  intervalJitter: 80,   // 在 REQUEST_INTERVAL 基础上叠加 0~80ms 随机抖动
  pauseEvery: 30,       // 每处理满 30 个
  pauseMin: 1000,       // 插入一次 1~3 秒的随机停顿
  pauseMax: 3000
};

// 组 2 熔断冷却：命中风控后暂停整个队列，而不是继续撞墙
const COOLDOWN = {
  minMs: 30000,
  maxMs: 60000,
  maxHits: 3            // 单次任务内连续触发 3 次即中止
};

// ---- 自动化（设置页的「自动化」区块）相关 ----
// 自动更新：由 chrome.alarms 定时唤醒 Service Worker 跑一次全量查询
const AUTO_ALARM = 'bili_auto_update';
// 自动更新最短间隔（分钟）：过于频繁既无意义，也容易撞上 B 站风控
const AUTO_UPDATE_MIN_MINUTES = 5;
const AUTO_UPDATE_MAX_MINUTES = 24 * 60;
// 自动重查失败项的等待步长：第 n 轮等待 5×n 秒（5 / 10 / 15 / 20 …），单轮最长 30 秒
const AUTO_RETRY_STEP_MS = 5000;
const AUTO_RETRY_MAX_WAIT_MS = 30000;
// 自动重查的轮数上限：到达后停下来交给用户，避免无意义地长时间重试
const AUTO_RETRY_MAX_ROUNDS = 10;
// 连续多少轮失败数没有减少就判定「再重试也没用」并停止（通常是 B 站要求人工验证）
const AUTO_RETRY_STUCK_ROUNDS = 2;

// 各自动化开关的默认值；用户可在设置页调整
const DEFAULT_AUTO = { autoUpdate: false, intervalMin: 60, autoRetry: false };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 拟人化节奏是否生效（任务开始时按设置写入，供各请求辅助函数读取）
let pacingEnabled = false;

// 并发数可能被手工改坏，读取时统一夹到合法区间
function normalizeConcurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_ANTI_RISK.concurrency;
  return Math.min(CONCURRENCY_MAX, Math.max(CONCURRENCY_MIN, Math.round(n)));
}

async function getAntiRiskConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get([PREFS_KEY], (data) => {
      const saved = (data[PREFS_KEY] || {}).antiRisk || {};
      resolve({
        pacing: saved.pacing ?? DEFAULT_ANTI_RISK.pacing,
        cooldown: saved.cooldown ?? DEFAULT_ANTI_RISK.cooldown,
        deviceId: saved.deviceId ?? DEFAULT_ANTI_RISK.deviceId,
        concurrency: normalizeConcurrency(saved.concurrency)
      });
    });
  });
}

// 自动更新的间隔同样可能被手工改坏，统一夹到合法区间
function normalizeInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_AUTO.intervalMin;
  return Math.min(AUTO_UPDATE_MAX_MINUTES, Math.max(AUTO_UPDATE_MIN_MINUTES, Math.round(n)));
}

async function getAutoConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get([PREFS_KEY], (data) => {
      const saved = (data[PREFS_KEY] || {}).auto || {};
      resolve({
        autoUpdate: saved.autoUpdate ?? DEFAULT_AUTO.autoUpdate,
        intervalMin: normalizeInterval(saved.intervalMin),
        autoRetry: saved.autoRetry ?? DEFAULT_AUTO.autoRetry
      });
    });
  });
}

function getStoredUid() {
  return new Promise((resolve) => {
    chrome.storage.local.get([UID_KEY], (d) => resolve(d[UID_KEY] || null));
  });
}

// 请求间隔：开启拟人化时加入随机抖动，避免完全均匀的机器特征
function nextInterval() {
  return REQUEST_INTERVAL + (pacingEnabled ? Math.random() * PACING.intervalJitter : 0);
}

// 风控拦截：独立错误类型，让上层能够区分"这条没数据"与"整体被限流"
class RiskControlError extends Error {
  constructor(code, message) {
    super(`B 站风控拦截（code=${code}${message ? ' ' + message : ''}）`);
    this.name = 'RiskControlError';
    this.isRiskControl = true;
    this.code = code;
  }
}

// 该 UP 主确实没有任何公开动态（账号注销 / 被封禁 / 从未投稿）
// 这是"查到了，但结果为空"，不是查询失败，也不该被当成风控或网络问题反复重查。
// 注意：这条文案同时是识别老缓存的数据标识（老版本只存了文案、没有 noDynamic 标记），
// 必须与 popup.js 的 NO_DYNAMIC_MESSAGE 保持一致
const NO_DYNAMIC_MESSAGE = '该 UP 主无公开动态';

class NoDynamicError extends Error {
  constructor() {
    super(NO_DYNAMIC_MESSAGE);
    this.name = 'NoDynamicError';
    this.isNoDynamic = true;
  }
}

// ---- B 站错误码语义化：把 code 翻译成用户能据以行动的中文 ----
const API_ERROR_HINT = {
  '-101': '登录已过期，请重新登录 B 站',
  '-111': 'csrf 校验失败，请刷新 B 站页面后重试',
  '-352': '触发风控校验，请稍后再试',
  '-400': '请求参数有误',
  '-403': '访问被拒绝，可能是账号权限或风控限制',
  '-404': '接口不存在，B 站可能已调整接口',
  '-412': '请求过于频繁，请稍后再试',
  '-509': '请求过于频繁，请稍后再试',
  '-799': '请求过于频繁，请稍后再试'
};

function describeApiError(data, scene) {
  const raw = `code=${data.code}${data.message ? ' ' + data.message : ''}`;
  const hint = API_ERROR_HINT[String(data.code)];
  return hint ? `${scene}失败：${hint}（${raw}）` : `${scene}失败：${raw}`;
}

// ---- 任务状态机 ----
const task = {
  status: 'idle',  // idle | running | done | error
  kind: 'query',   // query | retry
  mid: null,
  runId: 0,
  startedAt: 0,
  finishedAt: 0,
  error: null,
  // 任务正常结束、但需要用户手动处理时的提示（如自动重查连续无进展，需人工验证）
  notice: null
};

// 递增令牌：每次启动新任务都会让旧任务失效，避免并发双跑导致重复请求与重复项
let runSeq = 0;
let activeAbort = null;

function isStale(runId) {
  return runId !== runSeq;
}

// 让当前运行中的任务失效并中止其在途请求
function cancelActiveRun() {
  runSeq++;
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
}

// ---- Service Worker 保活：popup 长连接 ----
let keepAlivePort = null;
function setupKeepAlive() {
  if (keepAlivePort) return;
  // 监听 popup 连接，长连接期间 SW 不会被休眠
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'keepalive') {
      keepAlivePort = port;
      port.onDisconnect.addListener(() => {
        keepAlivePort = null;
      });
    }
  });
}
setupKeepAlive();

function broadcastTaskState() {
  chrome.runtime.sendMessage({
    type: 'task-state',
    payload: { ...task }
  }).catch(() => {});
}

async function readCache() {
  return new Promise((resolve) => {
    chrome.storage.local.get([CACHE_KEY], (data) => resolve(data[CACHE_KEY] || null));
  });
}

// 缓存的「读 → 改 → 写」必须串行。
// patchCachedItem 中间有 await，批量重试会并发调用它：两条同时读到同一份旧快照时，
// 后写的会用旧数据覆盖先写的修改（丢更新）。实测 3 并发写 9 条只有 3 条落盘。
// 这里用一个 Promise 链把读改写排成队，保证每次修改都基于最新快照。
let cacheLock = Promise.resolve();
function withCacheLock(fn) {
  const run = cacheLock.then(fn, fn);
  cacheLock = run.then(() => {}, () => {});
  return run;
}

async function saveCache(items, mid) {
  return withCacheLock(() => new Promise((resolve) => {
    chrome.storage.local.set({
      [CACHE_KEY]: { ts: Date.now(), items, uid: mid }
    }, resolve);
  }));
}

// 与 popup.js 的 isNoDynamicItem 保持一致：老缓存里只有文案、没有 noDynamic 标记
function isNoDynamicItem(item) {
  return Boolean(item.noDynamic) || item.error === NO_DYNAMIC_MESSAGE;
}

// 与 popup.js 的 isErrorItem 保持一致：要么带 error 字段，要么压根没有可用更新时间。
// 「该 UP 主无公开动态」已单独归类，不算失败 —— 否则列表里看不出它、重试队列里却算上它，
// 「2 个成功，1 个仍然失败」这类对不上账的提示就是这么来的
function isFailedItem(item) {
  if (isNoDynamicItem(item)) return false;
  return Boolean(item.error) || !item.lastVideoAt;
}

// 单项刷新 / 批量重试 / 自动重查后，只更新缓存里的对应条目
// ts 表示"上次全量查询时间"，单项刷新不应改变它，否则时效提示会失真
// stat 是查询结果：成功时清掉失败标记；失败时保留 error，带 noDynamic 的连标记一起落盘
// （老缓存里只有文案没有标记，不补标记的话下次重试又会被当成失败项）
async function patchCachedItem(mid, stat) {
  return withCacheLock(async () => {
    const cached = await readCache();
    if (!cached || !Array.isArray(cached.items)) return;

    const target = cached.items.find(i => Number(i.mid) === Number(mid));
    if (!target) return;

    Object.assign(target, stat);
    if (stat.error) {
      if (stat.noDynamic) target.noDynamic = true;
    } else {
      delete target.error;
      delete target.noDynamic;
    }

    return new Promise((resolve) => {
      chrome.storage.local.set({
        [CACHE_KEY]: { ts: cached.ts, items: cached.items, uid: cached.uid }
      }, resolve);
    });
  });
}

async function getCookie(url, name) {
  return new Promise((resolve) => {
    chrome.cookies.get({ url, name }, (cookie) => {
      resolve(cookie ? cookie.value : null);
    });
  });
}

// 同一个 Cookie 可能在 B 站不同子域下，依次查找
async function getCookieAnywhere(name) {
  const domains = [
    'https://www.bilibili.com',
    'https://api.bilibili.com',
    'https://space.bilibili.com'
  ];
  for (const d of domains) {
    const v = await getCookie(d, name);
    if (v) return v;
  }
  return null;
}

async function getSessData() {
  return getCookieAnywhere('SESSDATA');
}

// ---- 组 3：设备指纹补全 ----
// buvid3 是基础；buvid4 / b_nut 一起带上能让请求更接近真实浏览器
let deviceCookies = { buvid3: null, buvid4: null, bNut: null };

async function readStoredBuvid4() {
  return new Promise((resolve) => {
    chrome.storage.local.get([BUVID4_KEY], (d) => resolve(d[BUVID4_KEY] || null));
  });
}

// buvid4 长期有效，取到后落盘复用，避免每次查询都多打一次接口
async function fetchBuvid4() {
  const cached = await readStoredBuvid4();
  if (cached) return cached;

  try {
    const data = await biliFetch(`${BILI_API}/x/frontend/finger/spi`, null, null);
    const b4 = data?.data?.b_4;
    if (b4) {
      chrome.storage.local.set({ [BUVID4_KEY]: b4 });
      return b4;
    }
  } catch (e) {
    // 拿不到就退回只用 buvid3，不阻断主流程
  }
  return null;
}

async function loadDeviceCookies(useDeviceId) {
  const [buvid3, buvid4, bNut] = await Promise.all([
    getCookieAnywhere('buvid3'),
    useDeviceId ? getCookieAnywhere('buvid4') : Promise.resolve(null),
    useDeviceId ? getCookieAnywhere('b_nut') : Promise.resolve(null)
  ]);

  deviceCookies = { buvid3, buvid4, bNut };

  if (useDeviceId && !buvid4) {
    deviceCookies.buvid4 = await fetchBuvid4();
  }
  return deviceCookies;
}

// 所有 API 请求统一走这里：10s 超时 + 可被外层 signal 取消 + 风控码识别
// 注意：User-Agent / Origin / Referer 都属于浏览器的禁止修改头（forbidden header），
// JS 设置会被静默忽略，所以这里不再尝试伪造，实际发出的就是扩展自身的来源特征
async function biliFetch(url, sessdata, signal) {
  const cookieParts = [];
  if (sessdata) cookieParts.push(`SESSDATA=${sessdata}`);
  if (deviceCookies.buvid3) cookieParts.push(`buvid3=${deviceCookies.buvid3}`);
  if (deviceCookies.buvid4) cookieParts.push(`buvid4=${deviceCookies.buvid4}`);
  if (deviceCookies.bNut) cookieParts.push(`b_nut=${deviceCookies.bNut}`);

  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Cookie': cookieParts.join('; ')
  };

  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), REQUEST_TIMEOUT);
  const onOuterAbort = () => timeoutCtrl.abort();
  if (signal) {
    if (signal.aborted) timeoutCtrl.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  try {
    const resp = await fetch(url, {
      credentials: 'include',
      headers,
      signal: timeoutCtrl.signal
    });
    const data = await resp.json();
    // 风控命中时统一抛专用错误，交由上层熔断处理，避免继续撞墙
    if (RISK_CODES.has(data.code)) throw new RiskControlError(data.code, data.message);
    return data;
  } catch (e) {
    if (signal && signal.aborted) throw new Error('已取消');
    if (timeoutCtrl.signal.aborted) throw new Error(`请求超时（${REQUEST_TIMEOUT / 1000} 秒）`);
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

async function fetchFollowings(mid, sessdata, signal, onProgress) {
  const all = [];
  let pn = 1;
  let total = 0;

  while (true) {
    const url = `${BILI_API}/x/relation/followings?vmid=${mid}&pn=${pn}&ps=${PAGE_SIZE}&order=desc`;
    const data = await biliFetch(url, sessdata, signal);

    if (data.code !== 0) {
      throw new Error(describeApiError(data, '获取关注列表'));
    }

    const list = data.data?.list || [];
    total = data.data?.total || 0;
    all.push(...list);

    if (onProgress) onProgress({ current: all.length, total });
    if (all.length >= total || list.length === 0) break;
    pn++;
    await sleep(nextInterval());
  }

  return all;
}

async function fetchUpLatest(mid, sessdata, signal) {
  // 两条路径都失败时，把最后一次的真实原因抛出去，方便用户定位问题
  let lastError = null;

  try {
    const url = `${BILI_API}/x/polymer/web-dynamic/v1/feed/space?host_mid=${mid}`;
    const data = await biliFetch(url, sessdata, signal);
    if (data.code === 0 && data.data?.items?.length > 0) {
      const items = data.data.items;
      const sorted = [...items].sort((a, b) => {
        const ta = a?.modules?.module_author?.pub_ts || 0;
        const tb = b?.modules?.module_author?.pub_ts || 0;
        return tb - ta;
      });

      const first = sorted[0];
      const pubTs = first?.modules?.module_author?.pub_ts || 0;
      if (pubTs > 0) {
        const major = first?.modules?.module_dynamic?.major;
        let type = '动态';
        let title = '';
        if (major?.archive) {
          type = '视频';
          title = major.archive.title || '';
        } else if (major?.opus) {
          type = '专栏';
          title = major.opus.title || '';
        } else if (major?.live) {
          type = '直播';
          title = major.live.title || '';
        } else {
          const desc = first?.modules?.module_dynamic?.desc;
          if (desc?.text) title = desc.text;
        }
        const isTop = !!first?.modules?.module_tag?.text?.includes('置顶');
        return { lastAt: pubTs, lastName: title.slice(0, 40), type, isTop, source: 'dynamic-sorted' };
      }
    } else if (data.code !== 0) {
      lastError = new Error(describeApiError(data, '获取动态'));
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    if (e.isRiskControl) throw e; // 风控不是单条数据的问题，直接上抛给熔断
    lastError = e;
  }

  try {
    const url = `${BILI_API}/x/space/upstat?mid=${mid}`;
    const data = await biliFetch(url, sessdata, signal);
    if (data.code === 0 && data.data?.archive?.last_video_ts) {
      return {
        lastAt: data.data.archive.last_video_ts,
        lastName: data.data.archive.last_video_title || '',
        type: '视频',
        isTop: false,
        polluted: true,
        source: 'upstat-fallback'
      };
    }
    if (data.code !== 0) {
      lastError = new Error(describeApiError(data, '获取投稿'));
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    if (e.isRiskControl) throw e;
    lastError = e;
  }

  throw lastError || new NoDynamicError();
}

// 单个 UP 主查询失败时重试一次（取消与风控场景不重试）
async function fetchUpLatestWithRetry(mid, sessdata, signal) {
  try {
    return await fetchUpLatest(mid, sessdata, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    // 风控靠"重试"解决不了，立即上抛交给上层熔断
    if (e.isRiskControl) throw e;
    // 有没有公开动态是确定性结果，重试也不会改变
    if (e.isNoDynamic) throw e;
    // 开启拟人化时用更长的退避 + 随机抖动，避免规律性的重试节奏
    const base = pacingEnabled ? RETRY_DELAY * 3 : RETRY_DELAY;
    await sleep(base + Math.random() * base * 0.6);
    if (signal?.aborted) throw new Error('已取消');
    return await fetchUpLatest(mid, sessdata, signal);
  }
}

// 推送消息给 popup：统一带上 mid / runId，popup 端据此过滤，避免切换 UID 时数据串台
function pushTaskMessage(runId, msg) {
  if (isStale(runId)) return;
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ---- 组 2：风控冷却 ----
// 命中风控后暂停整个队列并倒计时，而不是继续发请求把风控越撞越深
async function cooldownAfterRisk({ mid, runId, state, current, total }) {
  const waitMs = COOLDOWN.minMs + Math.random() * (COOLDOWN.maxMs - COOLDOWN.minMs);
  const endAt = Date.now() + waitMs;

  while (Date.now() < endAt) {
    if (isStale(runId)) return;
    const left = Math.max(1, Math.ceil((endAt - Date.now()) / 1000));
    pushTaskMessage(runId, {
      type: 'progress',
      payload: {
        mid, runId, stage: 'cooldown', current, total, etaMs: 0,
        label: `触发 B 站风控，${left} 秒后自动继续（第 ${state.cooldownHit} 次）`
      }
    });
    await sleep(1000);
  }
}

// 并发查询一批 UP 主的最近更新：命中风控时只重试被拦截的条目（受 antiRisk.cooldown 控制），
// 结果逐条推送给 popup；onItem 让调用方在每条结果产生时就地处理（写回缓存 / 更新结果集）
// stopOnRisk=true 时（自动重查阶段）命中风控不再冷却续跑，而是停下整轮并回报 riskStopped，
// 因为这时的失败几乎都是「平台要求人工验证」，继续撞只会让风控加深
// 返回 { canceled, items, riskStopped? }，items 的顺序与传入的 followings 一致
async function queryFollowings({ followings, mid, runId, sessdata, signal, antiRisk, state, label, onItem, stopOnRisk = false }) {
  const total = followings.length;
  const concurrency = antiRisk.concurrency;
  const items = [];
  let processed = 0;
  let sincePause = 0;
  // 命中风控导致整轮提前结束（仅 stopOnRisk 模式会置位）
  let riskStopped = false;
  const queryStartAt = Date.now();

  // 推送"开始查询"进度（含 ETA 估算）
  const avgMs = 200; // 假设平均 200ms/请求
  pushTaskMessage(runId, {
    type: 'progress',
    payload: {
      mid, runId, stage: 'stats', current: 0, total, startedAt: queryStartAt,
      etaMs: Math.round((total / concurrency) * avgMs), label
    }
  });

  for (let i = 0; i < total; i += concurrency) {
    if (isStale(runId)) return { canceled: true, items };

    let batch = followings.slice(i, i + concurrency);
    // 用 Map 累积每一轮的结果：命中风控时只重试被拦截的条目，
    // 同一批里已经成功的条目必须先收好，否则会在下一轮被整体丢弃
    const settledItems = new Map();

    while (true) {
      const settled = await Promise.all(batch.map(async (up) => {
        const base = { mid: up.mid, name: up.uname, face: up.face };
        try {
          const stat = await fetchUpLatestWithRetry(up.mid, sessdata, signal);
          return {
            item: {
              ...base,
              lastVideoAt: stat.lastAt,
              lastVideoName: stat.lastName,
              type: stat.type,
              isTop: stat.isTop,
              polluted: stat.polluted || false,
              source: stat.source
            }
          };
        } catch (e) {
          if (e.isRiskControl) return { risk: true, up, base };
          const item = { ...base, error: e.message };
          // 无公开动态是「查到了，但结果为空」，标记出来供列表单独分组
          if (e.isNoDynamic) item.noDynamic = true;
          return { item };
        }
      }));

      for (const s of settled) {
        if (!s.risk) settledItems.set(s.item.mid, s.item);
      }

      const risked = settled.filter((s) => s.risk);

      if (risked.length === 0) break;

      // 自动重查阶段（stopOnRisk）：风控一旦命中就收手。被拦截的条目仍按失败记下、
      // 同批已成功的条目继续保留，然后结束整轮 —— 这时继续冷却续跑没有意义，
      // 失败的根本原因是平台要求人工验证，得交给用户去点一次 UP 主主页
      if (stopOnRisk) {
        for (const s of risked) {
          settledItems.set(s.base.mid, { ...s.base, error: 'B 站风控拦截，请稍后再试' });
        }
        riskStopped = true;
        break;
      }

      // 熔断开关关闭时退化为旧行为：把风控直接当作这几条查询失败
      if (!antiRisk.cooldown) {
        for (const s of risked) {
          settledItems.set(s.base.mid, { ...s.base, error: 'B 站风控拦截，请稍后再试' });
        }
        break;
      }

      state.cooldownHit++;
      if (state.cooldownHit > COOLDOWN.maxHits) {
        throw new Error(`连续 ${COOLDOWN.maxHits} 次触发 B 站风控，已中止本次查询。${MANUAL_VERIFY_HINT}`);
      }

      await cooldownAfterRisk({ mid, runId, state, current: processed, total });
      if (isStale(runId)) return { canceled: true, items };

      batch = risked.map((s) => s.up);
    }

    // 按原始批次顺序输出，保证结果顺序稳定
    const results = followings
      .slice(i, i + concurrency)
      .map((up) => settledItems.get(up.mid))
      .filter(Boolean);

    if (isStale(runId)) return { canceled: true, items };

    for (const item of results) {
      items.push(item);
      if (onItem) await onItem(item);
      pushTaskMessage(runId, { type: 'item', payload: { mid, runId, item } });
    }

    // 因风控停轮：本批结果已经推给 popup 并（在自动重查里）落了盘，直接回报调用方
    if (riskStopped) return { canceled: false, items, riskStopped: true };

    processed += results.length;
    // 推送进度 + 动态 ETA
    const elapsed = Date.now() - queryStartAt;
    const avgPerItem = elapsed / processed;
    pushTaskMessage(runId, {
      type: 'progress',
      payload: {
        mid, runId, stage: 'stats', current: processed, total,
        etaMs: Math.max(0, Math.round((total - processed) * avgPerItem)), label
      }
    });

    await sleep(nextInterval());

    // 组 1：每处理满一批插入一次随机停顿，打断长时间恒定的请求节奏
    sincePause += results.length;
    if (antiRisk.pacing && sincePause >= PACING.pauseEvery) {
      sincePause = 0;
      await sleep(PACING.pauseMin + Math.random() * (PACING.pauseMax - PACING.pauseMin));
    }
  }

  return { canceled: false, items };
}

// ---- 自动重查失败项 ----
// 全部查询结束后循环补查「查询失败」的条目，直到失败数归零。收敛条件有四条：
//   1. 失败数归零 → 正常结束
//   2. 本轮命中风控（熔断）→ 立即停止：这时的失败基本都是平台要求人工验证，越重试越深
//   3. 连续 AUTO_RETRY_STUCK_ROUNDS 轮失败数没有减少 → 判定重试已无效，立即停止
//   4. 达到 AUTO_RETRY_MAX_ROUNDS 轮上限 → 停止，剩余失败交给用户手动重试
// 其中 2、3 会让 popup 提示用户手动点进一个失败 UP 主的主页完成人工验证
// 第 n 轮等待 5×n 秒（5 / 10 / 15 / 20 …），单轮最长 30 秒；等待期间推送倒计时。
// 与普通查询一样受 runId 约束：点停止或重新发起查询会立即中断
async function autoRetryFailed({ mid, runId, sessdata, signal, antiRisk, state, items }) {
  let round = 0;
  let stuckRounds = 0;

  while (true) {
    const failed = items.filter(isFailedItem);

    if (failed.length === 0) return { canceled: false, left: 0 };

    if (round >= AUTO_RETRY_MAX_ROUNDS) {
      return { canceled: false, left: failed.length, stopped: 'maxRounds' };
    }

    round++;
    const waitMs = Math.min(AUTO_RETRY_STEP_MS * round, AUTO_RETRY_MAX_WAIT_MS);
    const endAt = Date.now() + waitMs;

    while (Date.now() < endAt) {
      if (isStale(runId)) return { canceled: true };
      const leftSec = Math.max(1, Math.ceil((endAt - Date.now()) / 1000));
      pushTaskMessage(runId, {
        type: 'progress',
        payload: {
          mid, runId, stage: 'auto-wait', current: round, total: AUTO_RETRY_MAX_ROUNDS,
          label: `第 ${round}/${AUTO_RETRY_MAX_ROUNDS} 轮自动重查将在 ${leftSec} 秒后开始（仍有 ${failed.length} 个失败）`
        }
      });
      await sleep(1000);
    }

    if (isStale(runId)) return { canceled: true };

    const followings = failed.map((i) => ({ mid: i.mid, uname: i.name, face: i.face }));
    const { canceled, riskStopped } = await queryFollowings({
      followings, mid, runId, sessdata, signal, antiRisk, state,
      stopOnRisk: true,
      label: `第 ${round}/${AUTO_RETRY_MAX_ROUNDS} 轮自动重查失败的 UP 主`,
      onItem: async (item) => {
        const idx = items.findIndex((x) => x.mid === item.mid);
        if (idx >= 0) items[idx] = item;
        // 重查成功的条目即时写回，避免中途关闭 popup 时结果丢失
        if (!item.error) await patchCachedItem(item.mid, item);
      }
    });

    if (canceled) return { canceled: true };

    // 本轮命中风控熔断：不再冷却续跑，直接停止重查并交给用户完成人工验证
    if (riskStopped) {
      return { canceled: false, left: items.filter(isFailedItem).length, stopped: 'risk' };
    }

    // 这一轮救回了多少？连续几轮颗粒无收就说明再重试也没用
    const left = items.filter(isFailedItem).length;
    stuckRounds = left < failed.length ? 0 : stuckRounds + 1;
    if (stuckRounds >= AUTO_RETRY_STUCK_ROUNDS) {
      return { canceled: false, left, stopped: 'stuck' };
    }
  }
}

// 停止重查时给用户的手动操作指引（风控熔断与「连续无进展」共用同一套动作）
const MANUAL_VERIFY_HINT = '请点击列表中任意一个「查询失败」的 UP 主进入其主页，'
  + '在打开的 B 站页面里完成人工操作验证（这一步程序无法代替你），然后回来点「N 个失败」重新查询。';

// 自动重查提前结束时给用户的可操作提示，写入 task.notice 由 popup 展示
function buildAutoRetryNotice({ left, stopped }) {
  if (stopped === 'risk') {
    return `自动重查已停止：本轮命中 B 站风控拦截，继续重试只会让风控越撞越深，`
      + `仍有 ${left} 个 UP 主查询失败。${MANUAL_VERIFY_HINT}`;
  }
  if (stopped === 'stuck') {
    return `自动重查已停止：连续 ${AUTO_RETRY_STUCK_ROUNDS} 轮失败数没有减少，`
      + `仍有 ${left} 个 UP 主查询失败。这通常是 B 站要求人工操作验证，程序无法自行通过。`
      + MANUAL_VERIFY_HINT;
  }
  return `自动重查已达 ${AUTO_RETRY_MAX_ROUNDS} 轮上限，仍有 ${left} 个 UP 主查询失败。`
    + '可在列表里点「N 个失败」手动重试，或稍后再执行一次完整查询。';
}

// 启动一次查询：每次调用都会让上一次运行失效
// mode='full'  全量查询：拉关注列表 → 逐条查更新 → 整体覆盖写缓存 →（开启时）循环重查失败项
// mode='retry' 批量重试：只挑缓存里「查询失败」的条目重查 → 逐条写回缓存
// 重试放在后台跑（而不是 popup 里循环），这样关闭 popup 后任务仍会继续，
// 重新打开时也能从 task 状态里看到它正在跑
async function runTask(mid, mode = 'full') {
  const isRetry = mode === 'retry';
  const runId = ++runSeq;
  if (activeAbort) activeAbort.abort();
  const abort = new AbortController();
  activeAbort = abort;
  const { signal } = abort;

  task.status = 'running';
  task.kind = isRetry ? 'retry' : 'query';
  task.mid = mid;
  task.runId = runId;
  task.startedAt = Date.now();
  task.finishedAt = 0;
  task.error = null;
  task.notice = null;
  broadcastTaskState();

  const collectedItems = [];
  // 整个任务共享的风控冷却计数：自动重查的每一轮都算在同一次任务里
  const state = { cooldownHit: 0 };

  try {
    const antiRisk = await getAntiRiskConfig();
    const auto = await getAutoConfig();
    pacingEnabled = antiRisk.pacing;

    // 重试模式的待办清单直接取自缓存里的失败条目，无需再拉关注列表
    let followings;
    if (isRetry) {
      const cached = await readCache();
      if (!cached || !Array.isArray(cached.items)) {
        throw new Error('没有可重试的数据，请先执行一次完整查询');
      }
      followings = cached.items
        .filter(isFailedItem)
        .map((i) => ({ mid: i.mid, uname: i.name, face: i.face }));

      if (followings.length === 0) {
        task.status = 'done';
        task.finishedAt = Date.now();
        broadcastTaskState();
        return { ok: true, kind: 'retry', total: 0, okCount: 0, failCount: 0 };
      }
    }

    const sessdata = await getSessData();
    if (!sessdata) throw new Error('未找到 SESSDATA，请先在 www.bilibili.com 登录');
    await loadDeviceCookies(antiRisk.deviceId);

    if (!isRetry) {
      followings = await fetchFollowings(mid, sessdata, signal, (p) => {
        pushTaskMessage(runId, { type: 'progress', payload: { mid, runId, stage: 'followings', ...p } });
      });
    }

    if (isStale(runId)) return { ok: true, canceled: true };

    const { canceled, items } = await queryFollowings({
      followings, mid, runId, sessdata, signal, antiRisk, state,
      label: isRetry ? '正在重新查询失败的 UP 主' : '查询更新时间',
      // 边查边写回缓存：中途关闭 popup 或 Service Worker 被回收时，已完成的进度不会丢。
      // 除成功项外，「无公开动态」的标记也要补写进缓存，否则老数据下次仍会被算作失败项
      onItem: async (item) => {
        collectedItems.push(item);
        if (isRetry && (!item.error || item.noDynamic)) await patchCachedItem(item.mid, item);
      }
    });

    if (canceled) return { ok: true, canceled: true };

    // 重试模式的结果已在查询过程中逐条写回，这里只统计成败
    if (isRetry) {
      const okCount = items.filter((i) => !i.error).length;
      task.status = 'done';
      task.finishedAt = Date.now();
      broadcastTaskState();
      return {
        ok: true, kind: 'retry',
        total: followings.length, okCount, failCount: followings.length - okCount
      };
    }

    await saveCache(collectedItems, mid);

    // 全量查询到此结束：自动更新从这一刻重新起算一个完整周期。
    // 放在自动重查之前，是因为「后续补查失败项」不属于一次完整更新，不应把周期推后；
    // 重排失败也不该影响已经拿到的查询结果，所以吞掉异常
    await restartAutoUpdateCountdown().catch(() => {});

    // 自动重查失败项：全量查询跑完后循环补查失败条目，直到失败数归零（受轮数与无进展上限约束）
    if (auto.autoRetry) {
      const retried = await autoRetryFailed({
        mid, runId, sessdata, signal, antiRisk, state, items: collectedItems
      });
      if (retried.canceled) return { ok: true, canceled: true };
      if (retried.stopped) task.notice = buildAutoRetryNotice(retried);
    }

    task.status = 'done';
    task.finishedAt = Date.now();
    broadcastTaskState();
    return { ok: true };
  } catch (err) {
    // 被取消或已失效的运行不再改动状态、不写缓存
    if (isStale(runId)) return { ok: true, canceled: true };

    if (!isRetry && collectedItems.length > 0) {
      await saveCache(collectedItems, mid);
    }
    task.status = 'error';
    task.error = err.message;
    task.finishedAt = Date.now();
    broadcastTaskState();
    return { ok: false, kind: isRetry ? 'retry' : 'query', error: err.message };
  } finally {
    if (activeAbort === abort) activeAbort = null;
  }
}

// ---- 单项刷新 ----
// 只重新查询一个 UP 主，不影响其它条目的数据与缓存
async function refreshOne(mid) {
  const antiRisk = await getAntiRiskConfig();
  pacingEnabled = antiRisk.pacing;

  const sessdata = await getSessData();
  if (!sessdata) return { ok: false, error: '未找到 SESSDATA，请先在 www.bilibili.com 登录' };
  await loadDeviceCookies(antiRisk.deviceId);

  try {
    const stat = await fetchUpLatestWithRetry(mid, sessdata, null);
    const payload = {
      lastVideoAt: stat.lastAt,
      lastVideoName: stat.lastName,
      type: stat.type,
      isTop: stat.isTop,
      polluted: stat.polluted || false,
      source: stat.source
    };
    // 同步落盘，避免用户关闭 popup 后刷新结果丢失
    await patchCachedItem(mid, payload);
    return { ok: true, stat: payload };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- 批量取关 ----
// B 站取关接口需要 bili_jct（csrf token），POST 表单提交
// Cookie（SESSDATA / bili_jct / 设备指纹）由 credentials:'include' 自动携带；
// User-Agent / Origin / Referer 属禁止修改头，写在这里不会生效
async function modifyRelation(mid, csrf) {
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), REQUEST_TIMEOUT);
  try {
    const resp = await fetch(`${BILI_API}/x/relation/modify`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json, text/plain, */*'
      },
      body: new URLSearchParams({ fid: String(mid), act: '2', re_src: '11', csrf }).toString(),
      signal: timeoutCtrl.signal
    });
    return await resp.json();
  } catch (e) {
    if (timeoutCtrl.signal.aborted) throw new Error(`请求超时（${REQUEST_TIMEOUT / 1000} 秒）`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 串行执行取关，避免触发风控；逐个推送结果供 popup 实时反馈
async function unfollowBatch(mids) {
  const csrf = await getCookie('https://www.bilibili.com', 'bili_jct');
  if (!csrf) {
    return { ok: false, error: '未找到 bili_jct，请先在 www.bilibili.com 登录' };
  }

  const succeeded = [];
  const failed = [];

  for (let i = 0; i < mids.length; i++) {
    const mid = mids[i];
    let error = null;
    try {
      const data = await modifyRelation(mid, csrf);
      if (data.code === 0) {
        succeeded.push(mid);
      } else {
        error = `code=${data.code} ${data.message || ''}`.trim();
      }
    } catch (e) {
      error = e.message;
    }
    if (error) failed.push({ mid, error });

    chrome.runtime.sendMessage({
      type: 'unfollow-progress',
      payload: { current: i + 1, total: mids.length, mid, ok: !error, error }
    }).catch(() => {});

    if (i < mids.length - 1) await sleep(UNFOLLOW_INTERVAL);
  }

  return { ok: true, succeeded, failed };
}

// ---- 自动更新：定时唤起 Service Worker 跑一次全量查询 ----
// MV3 的 Service Worker 会被浏览器回收，setTimeout / setInterval 都活不过休眠，
// 只有 chrome.alarms 能可靠地把 SW 唤醒，所以定时轮询必须走它
async function syncAutoUpdateAlarm() {
  const { autoUpdate, intervalMin } = await getAutoConfig();
  const existing = await chrome.alarms.get(AUTO_ALARM);

  if (!autoUpdate) {
    if (existing) await chrome.alarms.clear(AUTO_ALARM);
    return;
  }

  // 已存在且间隔一致就不动它：Service Worker 每次被唤醒都会执行到这里，
  // 若无条件重建，计时会被反复重置，自动更新可能永远等不到触发
  if (existing && existing.periodInMinutes === intervalMin) return;

  await chrome.alarms.clear(AUTO_ALARM);
  chrome.alarms.create(AUTO_ALARM, { periodInMinutes: intervalMin, delayInMinutes: intervalMin });
}

// 让「自动更新」从此刻重新起算一个完整周期。
// 调用时机只有一个：一次全量查询跑完（写完缓存）之后、失败项自动重查开始之前 ——
// 即计时锚点是「上一次完整更新的完成时刻」，后续的自动重查不计入，不会把周期再次推后。
// 这里必须显式 clear + create，不能走 syncAutoUpdateAlarm 的「已存在就跳过」分支
async function restartAutoUpdateCountdown() {
  const { autoUpdate, intervalMin } = await getAutoConfig();
  if (!autoUpdate) return;
  await chrome.alarms.clear(AUTO_ALARM);
  chrome.alarms.create(AUTO_ALARM, { periodInMinutes: intervalMin, delayInMinutes: intervalMin });
}

// 定时器到点：当前已有任务在跑就跳过本轮（两次运行会互相覆盖结果），
// 未设置 UID 时也不做任何事
async function startAutoUpdate() {
  if (task.status === 'running') return;
  const mid = await getStoredUid();
  if (!mid) return;
  runTask(mid);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_ALARM) startAutoUpdate();
});

// 设置变动时重排定时器；只认自动化设置本身的变化，
// 否则 popup 每次写回「隐藏异常」偏好都会把自动更新的计时重置
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[PREFS_KEY]) return;
  const before = JSON.stringify((changes[PREFS_KEY].oldValue || {}).auto || null);
  const after = JSON.stringify((changes[PREFS_KEY].newValue || {}).auto || null);
  if (before !== after) syncAutoUpdateAlarm();
});

// 浏览器启动 / 扩展更新后，SW 里的定时器会丢失，需要重建；
// 图标的点击行为也重新同步一次（侧边栏偏好来自上一次会话）
chrome.runtime.onStartup.addListener(() => { syncAutoUpdateAlarm(); syncActionMode(); });
chrome.runtime.onInstalled.addListener(() => { syncAutoUpdateAlarm(); syncActionMode(); });
syncAutoUpdateAlarm();
syncActionMode();

// ---- 界面形态记忆：上次用的是侧边栏，则下次点击工具栏图标直接进侧边栏 ----
// 列表与侧边栏共用同一个页面，由 popup.js 检测宿主后把形态写进 UI_KEY，这里负责让
// 工具栏图标的行为跟着变：有 action popup 时点击只会弹 popup，所以要先把 popup 摘掉，
// 再打开 sidePanel 的 openPanelOnActionClick，点击图标才会直接展开侧边栏
function getUiPrefs() {
  return new Promise((resolve) => {
    chrome.storage.local.get([UI_KEY], (d) => resolve(d[UI_KEY] || {}));
  });
}

// setPanelBehavior 需要 Chrome 116+；不支持时保持 popup 行为，功能降级但不会点了没反应
async function syncActionMode() {
  const { lastMode } = await getUiPrefs();
  const canPanel = Boolean(chrome.sidePanel && chrome.sidePanel.setPanelBehavior);
  const wantPanel = lastMode === 'panel' && canPanel;

  try {
    chrome.action.setPopup({ popup: wantPanel ? '' : POPUP_PATH });
    if (canPanel) await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: wantPanel });
  } catch (e) {
    // 同步失败就退回默认的 popup 行为，避免图标点击后什么都不发生
    try { chrome.action.setPopup({ popup: POPUP_PATH }); } catch (e2) { /* 忽略 */ }
  }
}

// 界面形态变化时立刻跟随（popup.js 每次打开都会写入当前形态）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[UI_KEY]) syncActionMode();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // start / reset 语义统一：启动新任务，旧任务自动失效
  if (msg.type === 'start' || msg.type === 'reset') {
    runTask(msg.mid).then(sendResponse);
    return true;
  }
  if (msg.type === 'cancel') {
    cancelActiveRun();
    task.status = 'idle';
    task.mid = null;
    task.error = null;
    task.notice = null;
    task.finishedAt = Date.now();
    broadcastTaskState();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'query-state') {
    sendResponse({ ok: true, task: { ...task } });
    return false;
  }
  if (msg.type === 'retry-failed') {
    // 已有任务在跑时不抢占：否则两次运行会互相覆盖结果
    if (task.status === 'running') {
      sendResponse({ ok: false, error: '当前有查询正在进行，请等它结束后再重试' });
      return false;
    }
    runTask(msg.mid, 'retry').then(sendResponse);
    return true;
  }
  if (msg.type === 'refresh-one') {
    refreshOne(msg.mid).then(sendResponse);
    return true;
  }
  if (msg.type === 'unfollow') {
    unfollowBatch(msg.mids || []).then(sendResponse);
    return true;
  }
});
