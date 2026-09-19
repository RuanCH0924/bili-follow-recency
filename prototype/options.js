// options.js - 设置页：读写反风控开关
// 注意：PREFS_KEY 必须与 background.js / popup.js 保持一致

const PREFS_KEY = 'bili_prefs';

// 开关与并发数的默认值，与 background.js 的 DEFAULT_ANTI_RISK 保持一致
// 「请求节奏拟人化」与「风控熔断」默认关闭：两者都会明显影响体验，需要用户看过说明后主动开启
const SWITCH_KEYS = ['pacing', 'cooldown', 'deviceId'];
const CONCURRENCY_MIN = 1;
const CONCURRENCY_MAX = 5;
const DEFAULT_ANTI_RISK = { pacing: false, cooldown: false, deviceId: true, concurrency: 3 };

const $hint = document.getElementById('save-hint');
const $resetBtn = document.getElementById('reset-btn');

let hintTimer = null;

function readPrefs() {
  return new Promise((resolve) => {
    chrome.storage.local.get([PREFS_KEY], (data) => resolve(data[PREFS_KEY] || {}));
  });
}

// 合并写入，避免覆盖 popup 端存在同一个键里的其它偏好
async function writeAntiRisk(antiRisk) {
  const prefs = await readPrefs();
  return new Promise((resolve) => {
    chrome.storage.local.set({
      [PREFS_KEY]: { ...prefs, antiRisk }
    }, resolve);
  });
}

// storage 里的值可能被手工改坏，统一夹到合法区间（与 background.js 的 normalizeConcurrency 一致）
function normalizeConcurrency(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_ANTI_RISK.concurrency;
  return Math.min(CONCURRENCY_MAX, Math.max(CONCURRENCY_MIN, n));
}

function applyToUI(antiRisk) {
  for (const key of SWITCH_KEYS) {
    document.getElementById(`opt-${key}`).checked = antiRisk[key];
  }

  const picked = normalizeConcurrency(antiRisk.concurrency);
  for (const input of document.querySelectorAll('input[name="concurrency"]')) {
    input.checked = Number(input.value) === picked;
  }
}

function collectFromUI() {
  const antiRisk = {};
  for (const key of SWITCH_KEYS) {
    antiRisk[key] = document.getElementById(`opt-${key}`).checked;
  }

  const picked = document.querySelector('input[name="concurrency"]:checked');
  antiRisk.concurrency = picked ? Number(picked.value) : DEFAULT_ANTI_RISK.concurrency;
  return antiRisk;
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
  await writeAntiRisk(collectFromUI());
  showHint('已保存');
}

for (const key of SWITCH_KEYS) {
  document.getElementById(`opt-${key}`).addEventListener('change', save);
}

for (const input of document.querySelectorAll('input[name="concurrency"]')) {
  input.addEventListener('change', save);
}

$resetBtn.addEventListener('click', async () => {
  applyToUI(DEFAULT_ANTI_RISK);
  await writeAntiRisk(DEFAULT_ANTI_RISK);
  showHint('已恢复默认');
});

async function init() {
  renderAbout();
  const prefs = await readPrefs();
  applyToUI({ ...DEFAULT_ANTI_RISK, ...(prefs.antiRisk || {}) });
}

// 版本号直接读 manifest，避免手工维护两份
function renderAbout() {
  const manifest = (chrome.runtime && chrome.runtime.getManifest) ? chrome.runtime.getManifest() : null;
  document.getElementById('about-version').textContent = manifest ? `v${manifest.version}` : '—';
}

init();
