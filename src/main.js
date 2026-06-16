/**
 * エントリポイント。
 *
 * フォールバック順:
 *   1. IndexedDB cache  (Tier 1)
 *   2. glossary.json    (Tier 0)
 *   3. Chrome built-in  (Tier 2) — 対応ブラウザのみ
 *   4. Transformers.js  (Tier 3) — WebGPU/WASM
 *   5. Server API       (Tier 4) — オプトイン
 */
import * as cache from './cache/indexedDb.js';
import { ChromeTranslatorEngine } from './engines/chromeTranslator.js';
import { TransformersJsEngine, quickLangDetect } from './engines/transformersJs.js';
import { ServerApiEngine } from './engines/serverApi.js';

const LANGS = [
  { code: 'en', name: 'English' },
  { code: 'ja', name: '日本語' },
  { code: 'zh', name: '中文' },
  { code: 'ko', name: '한국어' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'ru', name: 'Русский' },
];

// --- DOM ---
const $ = sel => document.querySelector(sel);
const srcSel = $('#src'), tgtSel = $('#tgt');
const srcText = $('#srcText'), tgtText = $('#tgtText');
const srcMeta = $('#srcMeta'), tgtMeta = $('#tgtMeta');
const btn = $('#go'), engineStatus = $('#engineStatus');
const useServerApi = $('#useServerApi'), apiUrl = $('#apiUrl');

// --- エンジン初期化 ---
const chromeEng = new ChromeTranslatorEngine();
const tjsEng = new TransformersJsEngine();
let serverEng = null;

tjsEng.setProgressCallback((pct, msg) => {
  setStatus('loading', `📦 ${msg} ${pct ? pct.toFixed(0)+'%' : ''}`);
});

let glossary = {};
fetch('./glossary.json').then(r => r.ok ? r.json() : {}).then(g => { glossary = g; }).catch(() => {});

// --- UI 初期化 ---
function populateLangs() {
  srcSel.innerHTML = '<option value="auto">自動検出</option>';
  tgtSel.innerHTML = '';
  for (const l of LANGS) {
    srcSel.add(new Option(l.name, l.code));
    tgtSel.add(new Option(l.name, l.code));
  }
  // ブラウザの優先言語を target に
  const browserLang = (navigator.language || 'en').split('-')[0];
  tgtSel.value = LANGS.find(l => l.code === browserLang) ? browserLang : 'ja';
  if (tgtSel.value === 'ja') srcSel.value = 'auto';
}
populateLangs();

// 設定の永続化
const STORAGE_KEY = 'translate-settings-v1';
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    useServerApi.checked = !!s.useServerApi;
    apiUrl.value = s.apiUrl || '';
    if (s.apiUrl) serverEng = new ServerApiEngine(s.apiUrl);
  } catch {}
}
function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    useServerApi: useServerApi.checked,
    apiUrl: apiUrl.value,
  }));
  serverEng = apiUrl.value ? new ServerApiEngine(apiUrl.value) : null;
}
useServerApi.addEventListener('change', saveSettings);
apiUrl.addEventListener('change', saveSettings);
loadSettings();

$('#clearCache').onclick = async () => {
  await cache.clear();
  setStatus('ready', 'キャッシュ削除完了');
};

// --- エンジン可用性チェック ---
async function detectEngines() {
  const flags = [];
  if (ChromeTranslatorEngine.isSupported()) flags.push('Chrome内蔵AI ✓');
  if ('gpu' in navigator) flags.push('WebGPU ✓'); else flags.push('WASM');
  flags.push('Transformers.js ✓');
  setStatus('ready', flags.join(' · '));
}

function setStatus(klass, msg) {
  engineStatus.className = 'engine-status ' + klass;
  engineStatus.textContent = msg;
}

// 起動時にバキューム
cache.vacuum().catch(() => {});
detectEngines();

// --- 翻訳ロジック ---
async function translate() {
  const q = srcText.value.trim();
  if (!q) { tgtText.value = ''; tgtMeta.textContent = '—'; return; }

  let source = srcSel.value;
  const target = tgtSel.value;

  if (source === 'auto') source = quickLangDetect(q);
  if (source === target) {
    tgtText.value = q;
    tgtMeta.innerHTML = '<span class="badge">SAME LANG</span>同一言語のためパススルー';
    return;
  }

  btn.disabled = true;
  const t0 = performance.now();

  try {
    // Tier 1: IDB キャッシュ
    const key = await cache.cacheKey(q, source, target);
    const cached = await cache.get(key);
    if (cached) {
      finalize(cached.dst, cached.engine, cached.detectedSource || source, t0, 'CACHE');
      return;
    }

    // Tier 0: 用語集
    const norm = cache.normalize(q);
    const gKey = `${source}->${target}`;
    if (glossary[gKey] && glossary[gKey][norm]) {
      const dst = glossary[gKey][norm];
      cache.set(key, q, dst, 'glossary', source);
      finalize(dst, 'glossary', source, t0, 'GLOSSARY');
      return;
    }

    // Tier 2: Chrome 内蔵
    if (ChromeTranslatorEngine.isSupported()) {
      try {
        const avail = await chromeEng.checkAvailability(source, target);
        if (avail !== 'unavailable') {
          setStatus('loading', 'Chrome内蔵AIで翻訳中...');
          const r = await chromeEng.translate(q, source, target);
          cache.set(key, q, r.text, r.engine, r.detectedSource);
          finalize(r.text, r.engine, r.detectedSource, t0, 'CHROME');
          return;
        }
      } catch (e) {
        console.warn('Chrome translator failed, falling through:', e);
      }
    }

    // Tier 3: Transformers.js
    try {
      const r = await tjsEng.translate(q, source, target);
      cache.set(key, q, r.text, r.engine, r.detectedSource);
      finalize(r.text, r.engine, r.detectedSource, t0, 'TJS');
      return;
    } catch (e) {
      console.warn('Transformers.js failed, trying server:', e);
    }

    // Tier 4: サーバーAPI（オプトイン）
    if (useServerApi.checked && serverEng?.isConfigured()) {
      setStatus('loading', 'サーバーAPI 呼び出し中...');
      const r = await serverEng.translate(q, source, target);
      cache.set(key, q, r.text, r.engine, r.detectedSource);
      finalize(r.text, r.engine, r.detectedSource, t0, 'SERVER');
      return;
    }

    throw new Error('利用可能な翻訳エンジンがありません。サーバーAPIを有効化するか、対応ブラウザを使用してください。');
  } catch (e) {
    tgtMeta.innerHTML = `<span class="badge" style="background:var(--err);color:#fff">ERROR</span>${e.message}`;
    setStatus('error', `エラー: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

function finalize(text, engine, detectedSource, t0, badgeKind) {
  tgtText.value = text;
  const elapsed = Math.round(performance.now() - t0);
  const badgeMap = {
    CACHE: '<span class="badge cache">CACHE</span>',
    GLOSSARY: '<span class="badge cache">GLOSSARY</span>',
    CHROME: '<span class="badge chrome">CHROME-AI</span>',
    TJS: '<span class="badge tjs">TRANSFORMERS.JS</span>',
    SERVER: '<span class="badge server">SERVER</span>',
  };
  tgtMeta.innerHTML = `${badgeMap[badgeKind] || ''} engine: <b>${engine}</b> · ${elapsed}ms · detected: ${detectedSource}`;
  setStatus('ready', `${engine} · ${elapsed}ms`);
}

// --- イベント ---
let debounce;
srcText.addEventListener('input', () => {
  srcMeta.textContent = `${srcText.value.length} / 5000`;
  clearTimeout(debounce);
  debounce = setTimeout(translate, 800);  // 入力停止 800ms で自動翻訳
});

btn.onclick = translate;

$('#swap').onclick = () => {
  if (srcSel.value === 'auto') return;
  [srcSel.value, tgtSel.value] = [tgtSel.value, srcSel.value];
  [srcText.value, tgtText.value] = [tgtText.value, srcText.value];
  translate();
};

$('#copy').onclick = () => {
  navigator.clipboard.writeText(tgtText.value);
};

// --- Service Worker 登録（オフライン対応） ---
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(e => console.warn('SW reg failed', e));
}
