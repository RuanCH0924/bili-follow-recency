// options.js - 设置页：读写反风控开关与自动化设置
// 注意：PREFS_KEY 必须与 background.js / popup.js 保持一致

const PREFS_KEY = 'bili_prefs';

// 开关与并发数的默认值，与 background.js 的 DEFAULT_ANTI_RISK 保持一致
// 「请求节奏拟人化」与「风控熔断」默认关闭：两者都会明显影响体验，需要用户看过说明后主动开启
const SWITCH_KEYS = ['pacing', 'cooldown', 'deviceId'];
const CONCURRENCY_MIN = 1;
const CONCURRENCY_MAX = 5;
const DEFAULT_ANTI_RISK = { pacing: false, cooldown: false, deviceId: true, concurrency: 3 };

// 自动化设置的默认值，与 background.js 的 DEFAULT_AUTO 保持一致
const AUTO_SWITCH_KEYS = ['autoUpdate', 'autoRetry'];
const AUTO_UPDATE_MIN_MINUTES = 5;
const AUTO_UPDATE_MAX_MINUTES = 24 * 60;
const DEFAULT_AUTO = { autoUpdate: false, intervalMin: 60, autoRetry: false };

const $hint = document.getElementById('save-hint');
const $resetBtn = document.getElementById('reset-btn');
const $interval = document.getElementById('opt-interval');

let hintTimer = null;

function readPrefs() {
  return new Promise((resolve) => {
    chrome.storage.local.get([PREFS_KEY], (data) => resolve(data[PREFS_KEY] || {}));
  });
}

// 合并写入，避免覆盖 popup 端存在同一个键里的其它偏好
async function writePrefs(patch) {
  const prefs = await readPrefs();
  return new Promise((resolve) => {
    chrome.storage.local.set({
      [PREFS_KEY]: { ...prefs, ...patch }
    }, resolve);
  });
}

// storage 里的值可能被手工改坏，统一夹到合法区间（与 background.js 的 normalizeConcurrency 一致）
function normalizeConcurrency(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_ANTI_RISK.concurrency;
  return Math.min(CONCURRENCY_MAX, Math.max(CONCURRENCY_MIN, n));
}

// 自动更新的间隔同样会被夹到合法区间（与 background.js 的 normalizeInterval 一致），
// 最短 5 分钟是硬下限：再密就等同于持续抓取，必然挨风控
function normalizeInterval(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_AUTO.intervalMin;
  return Math.min(AUTO_UPDATE_MAX_MINUTES, Math.max(AUTO_UPDATE_MIN_MINUTES, n));
}

// 自动更新关闭时，频率输入没有意义，置灰以免误改
function syncIntervalEnabled() {
  $interval.disabled = !document.getElementById('opt-autoUpdate').checked;
}

function applyToUI(antiRisk, auto) {
  for (const key of SWITCH_KEYS) {
    document.getElementById(`opt-${key}`).checked = antiRisk[key];
  }

  const picked = normalizeConcurrency(antiRisk.concurrency);
  for (const input of document.querySelectorAll('input[name="concurrency"]')) {
    input.checked = Number(input.value) === picked;
  }

  for (const key of AUTO_SWITCH_KEYS) {
    document.getElementById(`opt-${key}`).checked = auto[key];
  }
  $interval.value = String(normalizeInterval(auto.intervalMin));
  syncIntervalEnabled();
}

function collectFromUI() {
  const antiRisk = {};
  for (const key of SWITCH_KEYS) {
    antiRisk[key] = document.getElementById(`opt-${key}`).checked;
  }
  const picked = document.querySelector('input[name="concurrency"]:checked');
  antiRisk.concurrency = picked ? Number(picked.value) : DEFAULT_ANTI_RISK.concurrency;

  const auto = {};
  for (const key of AUTO_SWITCH_KEYS) {
    auto[key] = document.getElementById(`opt-${key}`).checked;
  }
  auto.intervalMin = normalizeInterval($interval.value);

  return { antiRisk, auto };
}

function showHint(text) {
  $hint.textContent = text;
  $hint.classList.add('is-saved');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    $hint.textContent = '修改后自动保存';
    $hint.classList.remove('is-saved');
  }, 1800);
}

async function save() {
  const { antiRisk, auto } = collectFromUI();
  // 回写一次实际生效的间隔，让用户看到被夹到合法区间的结果（如输入 1 会变成 5）
  $interval.value = String(auto.intervalMin);
  await writePrefs({ antiRisk, auto });
  showHint('已保存');
}

for (const key of SWITCH_KEYS) {
  document.getElementById(`opt-${key}`).addEventListener('change', save);
}

for (const input of document.querySelectorAll('input[name="concurrency"]')) {
  input.addEventListener('change', save);
}

document.getElementById('opt-autoUpdate').addEventListener('change', () => {
  syncIntervalEnabled();
  save();
});

document.getElementById('opt-autoRetry').addEventListener('change', save);

// 数字输入框用 change 而不是 input：避免每敲一位数字就写一次 storage
$interval.addEventListener('change', save);

$resetBtn.addEventListener('click', async () => {
  applyToUI(DEFAULT_ANTI_RISK, DEFAULT_AUTO);
  await writePrefs({ antiRisk: DEFAULT_ANTI_RISK, auto: DEFAULT_AUTO });
  showHint('已恢复默认');
});

async function init() {
  renderAbout();
  const prefs = await readPrefs();
  applyToUI(
    { ...DEFAULT_ANTI_RISK, ...(prefs.antiRisk || {}) },
    { ...DEFAULT_AUTO, ...(prefs.auto || {}) }
  );
}

// 版本号直接读 manifest，避免手工维护两份
function renderAbout() {
  const manifest = (chrome.runtime && chrome.runtime.getManifest) ? chrome.runtime.getManifest() : null;
  document.getElementById('about-version').textContent = manifest ? `v${manifest.version}` : '—';
}

init();
