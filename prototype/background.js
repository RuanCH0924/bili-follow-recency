// background.js - 后台服务：关注列表拉取 / 最近更新查询 / 任务状态机 / 缓存 / 批量取关
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
  error: null
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

// 与 popup.js 的 isErrorItem 保持一致：要么带 error 字段，要么压根没有可用更新时间
function isFailedItem(item) {
  return Boolean(item.error) || !item.lastVideoAt;
}

// 单项刷新 / 批量重试后，只更新缓存里的对应条目
// ts 表示"上次全量查询时间"，单项刷新不应改变它，否则时效提示会失真
async function patchCachedItem(mid, stat) {
  return withCacheLock(async () => {
    const cached = await readCache();
    if (!cached || !Array.isArray(cached.items)) return;

    const target = cached.items.find(i => Number(i.mid) === Number(mid));
    if (!target) return;

    Object.assign(target, stat);
    delete target.error;

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

  throw lastError || new Error('该 UP 主无公开动态');
}

// 单个 UP 主查询失败时重试一次（取消与风控场景不重试）
async function fetchUpLatestWithRetry(mid, sessdata, signal) {
  try {
    return await fetchUpLatest(mid, sessdata, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    // 风控靠"重试"解决不了，立即上抛交给上层熔断
    if (e.isRiskControl) throw e;
    // 开启拟人化时用更长的退避 + 随机抖动，避免规律性的重试节奏
    const base = pacingEnabled ? RETRY_DELAY * 3 : RETRY_DELAY;
    await sleep(base + Math.random() * base * 0.6);
    if (signal?.aborted) throw new Error('已取消');
    return await fetchUpLatest(mid, sessdata, signal);
  }
}

// 启动一次查询：每次调用都会让上一次运行失效
// mode='full'  全量查询：拉关注列表 → 逐条查更新 → 整体覆盖写缓存
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
  broadcastTaskState();

  const collectedItems = [];

  // 所有推送都带上 mid / runId，popup 端据此过滤，避免切换 UID 时数据串台
  const push = (msg) => {
    if (isStale(runId)) return;
    chrome.runtime.sendMessage(msg).catch(() => {});
  };

  // ---- 组 2：风控冷却 ----
  // 命中风控后暂停整个队列并倒计时，而不是继续发请求把风控越撞越深
  let cooldownHit = 0;
  const cooldown = async (current, total) => {
    const waitMs = COOLDOWN.minMs + Math.random() * (COOLDOWN.maxMs - COOLDOWN.minMs);
    const endAt = Date.now() + waitMs;

    while (Date.now() < endAt) {
      if (isStale(runId)) return;
      const left = Math.max(1, Math.ceil((endAt - Date.now()) / 1000));
      push({
        type: 'progress',
        payload: {
          mid, runId, stage: 'cooldown', current, total, etaMs: 0,
          label: `触发 B 站风控，${left} 秒后自动继续（第 ${cooldownHit} 次）`
        }
      });
      await sleep(1000);
    }
  };

  try {
    const antiRisk = await getAntiRiskConfig();
    pacingEnabled = antiRisk.pacing;
    const concurrency = antiRisk.concurrency;

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
        push({ type: 'progress', payload: { mid, runId, stage: 'followings', ...p } });
      });
    }

    if (isStale(runId)) return { ok: true, canceled: true };

    const total = followings.length;
    let processed = 0;
    let sincePause = 0;
    const queryStartAt = Date.now();

    // 推送"开始查询"进度（含 ETA 估算）
    const avgMs = 200; // 假设平均 200ms/请求
    const etaMs = Math.round((total / concurrency) * avgMs);
    push({
      type: 'progress',
      payload: {
        mid, runId, stage: 'stats', current: 0, total, etaMs, startedAt: queryStartAt,
        label: isRetry ? '正在重新查询失败的 UP 主' : '查询更新时间'
      }
    });

    for (let i = 0; i < total; i += concurrency) {
      if (isStale(runId)) return { ok: true, canceled: true };

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
            return { item: { ...base, error: e.message } };
          }
        }));

        for (const s of settled) {
          if (!s.risk) settledItems.set(s.item.mid, s.item);
        }

        const risked = settled.filter((s) => s.risk);

        if (risked.length === 0) break;

        // 熔断开关关闭时退化为旧行为：把风控直接当作这几条查询失败
        if (!antiRisk.cooldown) {
          for (const s of risked) {
            settledItems.set(s.base.mid, { ...s.base, error: 'B 站风控拦截，请稍后再试' });
          }
          break;
        }

        cooldownHit++;
        if (cooldownHit > COOLDOWN.maxHits) {
          throw new Error(`连续 ${COOLDOWN.maxHits} 次触发 B 站风控，已中止本次查询，请稍后再试`);
        }

        await cooldown(processed, total);
        if (isStale(runId)) return { ok: true, canceled: true };

        batch = risked.map((s) => s.up);
      }

      // 按原始批次顺序输出，保证结果顺序稳定
      const results = followings
        .slice(i, i + concurrency)
        .map((up) => settledItems.get(up.mid))
        .filter(Boolean);

      if (isStale(runId)) return { ok: true, canceled: true };

      for (const item of results) {
        collectedItems.push(item);
        // 重试模式边跑边落盘：中途关闭 popup 或 Service Worker 被回收时，已完成的进度不会丢
        if (isRetry && !item.error) await patchCachedItem(item.mid, item);
        push({ type: 'item', payload: { mid, runId, item } });
      }

      processed += results.length;
      // 推送进度 + 动态 ETA
      const elapsed = Date.now() - queryStartAt;
      const avgPerItem = elapsed / processed;
      const remaining = Math.max(0, Math.round((total - processed) * avgPerItem));
      push({
        type: 'progress',
        payload: {
          mid, runId, stage: 'stats', current: processed, total, etaMs: remaining,
          label: isRetry ? '正在重新查询失败的 UP 主' : '查询更新时间'
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

    if (isStale(runId)) return { ok: true, canceled: true };

    // 重试模式的结果已在循环里逐条写回，这里只统计成败
    if (isRetry) {
      const okCount = collectedItems.filter((i) => !i.error).length;
      task.status = 'done';
      task.finishedAt = Date.now();
      broadcastTaskState();
      return {
        ok: true, kind: 'retry',
        total: followings.length, okCount, failCount: followings.length - okCount
      };
    }

    await saveCache(collectedItems, mid);

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
