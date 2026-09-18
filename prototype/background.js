// background.js - 后台服务：关注列表拉取 / 最近更新查询 / 任务状态机 / 缓存 / 批量取关
// 版本号以 manifest.json 为准

const BILI_API = 'https://api.bilibili.com';
const PAGE_SIZE = 50;
const REQUEST_INTERVAL = 80;
const CONCURRENCY = 5;
const REQUEST_TIMEOUT = 10000;
const RETRY_DELAY = 300;
const UNFOLLOW_INTERVAL = 400;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// 注意：此键必须与 popup.js 中的 CACHE_KEY 保持一致
const CACHE_KEY = 'bili_follow_cache';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function saveCache(items, mid) {
  return new Promise((resolve) => {
    chrome.storage.local.set({
      [CACHE_KEY]: { ts: Date.now(), items, uid: mid }
    }, resolve);
  });
}

async function getCookie(url, name) {
  return new Promise((resolve) => {
    chrome.cookies.get({ url, name }, (cookie) => {
      resolve(cookie ? cookie.value : null);
    });
  });
}

async function getSessData() {
  const domains = [
    'https://www.bilibili.com',
    'https://api.bilibili.com',
    'https://space.bilibili.com'
  ];
  for (const d of domains) {
    const v = await getCookie(d, 'SESSDATA');
    if (v) return v;
  }
  return null;
}

async function getBuvid3() {
  const domains = ['https://www.bilibili.com', 'https://api.bilibili.com'];
  for (const d of domains) {
    const v = await getCookie(d, 'buvid3');
    if (v) return v;
  }
  return null;
}

// 所有 API 请求统一走这里：10s 超时 + 可被外层 signal 取消
async function biliFetch(url, sessdata, buvid3, signal) {
  const cookieParts = [];
  if (sessdata) cookieParts.push(`SESSDATA=${sessdata}`);
  if (buvid3) cookieParts.push(`buvid3=${buvid3}`);

  const headers = {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': 'https://space.bilibili.com/',
    'Origin': 'https://space.bilibili.com',
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
    return await resp.json();
  } catch (e) {
    if (signal && signal.aborted) throw new Error('已取消');
    if (timeoutCtrl.signal.aborted) throw new Error(`请求超时（${REQUEST_TIMEOUT / 1000} 秒）`);
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

async function fetchFollowings(mid, sessdata, buvid3, signal, onProgress) {
  const all = [];
  let pn = 1;
  let total = 0;

  while (true) {
    const url = `${BILI_API}/x/relation/followings?vmid=${mid}&pn=${pn}&ps=${PAGE_SIZE}&order=desc`;
    const data = await biliFetch(url, sessdata, buvid3, signal);

    if (data.code !== 0) {
      throw new Error(describeApiError(data, '获取关注列表'));
    }

    const list = data.data?.list || [];
    total = data.data?.total || 0;
    all.push(...list);

    if (onProgress) onProgress({ current: all.length, total });
    if (all.length >= total || list.length === 0) break;
    pn++;
    await sleep(REQUEST_INTERVAL);
  }

  return all;
}

async function fetchUpLatest(mid, sessdata, buvid3, signal) {
  // 两条路径都失败时，把最后一次的真实原因抛出去，方便用户定位问题
  let lastError = null;

  try {
    const url = `${BILI_API}/x/polymer/web-dynamic/v1/feed/space?host_mid=${mid}`;
    const data = await biliFetch(url, sessdata, buvid3, signal);
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
    lastError = e;
  }

  try {
    const url = `${BILI_API}/x/space/upstat?mid=${mid}`;
    const data = await biliFetch(url, sessdata, buvid3, signal);
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
    lastError = e;
  }

  throw lastError || new Error('该 UP 主无公开动态');
}

// 单个 UP 主查询失败时重试一次（取消场景不重试）
async function fetchUpLatestWithRetry(mid, sessdata, buvid3, signal) {
  try {
    return await fetchUpLatest(mid, sessdata, buvid3, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    await sleep(RETRY_DELAY);
    if (signal?.aborted) throw new Error('已取消');
    return await fetchUpLatest(mid, sessdata, buvid3, signal);
  }
}

// 启动一次完整查询：每次调用都会让上一次运行失效
async function runTask(mid) {
  const runId = ++runSeq;
  if (activeAbort) activeAbort.abort();
  const abort = new AbortController();
  activeAbort = abort;
  const { signal } = abort;

  task.status = 'running';
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

  try {
    const sessdata = await getSessData();
    if (!sessdata) throw new Error('未找到 SESSDATA，请先在 www.bilibili.com 登录');
    const buvid3 = await getBuvid3();

    const followings = await fetchFollowings(mid, sessdata, buvid3, signal, (p) => {
      push({ type: 'progress', payload: { mid, runId, stage: 'followings', ...p } });
    });

    if (isStale(runId)) return { ok: true, canceled: true };

    const total = followings.length;
    let processed = 0;
    const queryStartAt = Date.now();

    // 推送"开始查询"进度（含 ETA 估算）
    const avgMs = 200; // 假设平均 200ms/请求
    const etaMs = Math.round((total / CONCURRENCY) * avgMs);
    push({
      type: 'progress',
      payload: { mid, runId, stage: 'stats', current: 0, total, etaMs, startedAt: queryStartAt }
    });

    for (let i = 0; i < total; i += CONCURRENCY) {
      if (isStale(runId)) return { ok: true, canceled: true };

      const batch = followings.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(async (up) => {
        const base = { mid: up.mid, name: up.uname, face: up.face };
        try {
          const stat = await fetchUpLatestWithRetry(up.mid, sessdata, buvid3, signal);
          return {
            ...base,
            lastVideoAt: stat.lastAt,
            lastVideoName: stat.lastName,
            type: stat.type,
            isTop: stat.isTop,
            polluted: stat.polluted || false,
            source: stat.source
          };
        } catch (e) {
          return { ...base, error: e.message };
        }
      }));

      if (isStale(runId)) return { ok: true, canceled: true };

      for (const item of results) {
        collectedItems.push(item);
        push({ type: 'item', payload: { mid, runId, item } });
      }

      processed += results.length;
      // 推送进度 + 动态 ETA
      const elapsed = Date.now() - queryStartAt;
      const avgPerItem = elapsed / processed;
      const remaining = Math.max(0, Math.round((total - processed) * avgPerItem));
      push({
        type: 'progress',
        payload: { mid, runId, stage: 'stats', current: processed, total, etaMs: remaining }
      });

      await sleep(REQUEST_INTERVAL);
    }

    if (isStale(runId)) return { ok: true, canceled: true };

    await saveCache(collectedItems, mid);

    task.status = 'done';
    task.finishedAt = Date.now();
    broadcastTaskState();
    return { ok: true };
  } catch (err) {
    // 被取消或已失效的运行不再改动状态、不写缓存
    if (isStale(runId)) return { ok: true, canceled: true };

    if (collectedItems.length > 0) {
      await saveCache(collectedItems, mid);
    }
    task.status = 'error';
    task.error = err.message;
    task.finishedAt = Date.now();
    broadcastTaskState();
    return { ok: false, error: err.message };
  } finally {
    if (activeAbort === abort) activeAbort = null;
  }
}

// ---- 单项刷新 ----
// 只重新查询一个 UP 主，不影响其它条目的数据与缓存
async function refreshOne(mid) {
  const sessdata = await getSessData();
  if (!sessdata) return { ok: false, error: '未找到 SESSDATA，请先在 www.bilibili.com 登录' };
  const buvid3 = await getBuvid3();
  try {
    const stat = await fetchUpLatestWithRetry(mid, sessdata, buvid3, null);
    return {
      ok: true,
      stat: {
        lastVideoAt: stat.lastAt,
        lastVideoName: stat.lastName,
        type: stat.type,
        isTop: stat.isTop,
        polluted: stat.polluted || false,
        source: stat.source
      }
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- 批量取关 ----
// B 站取关接口需要 bili_jct（csrf token），POST 表单提交
async function modifyRelation(mid, csrf) {
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), REQUEST_TIMEOUT);
  try {
    const resp = await fetch(`${BILI_API}/x/relation/modify`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://space.bilibili.com/',
        'Origin': 'https://space.bilibili.com'
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
  if (msg.type === 'refresh-one') {
    refreshOne(msg.mid).then(sendResponse);
    return true;
  }
  if (msg.type === 'unfollow') {
    unfollowBatch(msg.mids || []).then(sendResponse);
    return true;
  }
});
