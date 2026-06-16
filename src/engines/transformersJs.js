/**
 * Tier 3: Transformers.js による完全クライアント翻訳（OPUS-MT / ONNX 量子化）。
 *
 * 設計:
 *   - モデルは Hugging Face CDN から取得（GitHubの帯域は使わない）
 *   - WebGPU 対応ブラウザでは GPU 実行、未対応なら WASM フォールバック
 *   - 言語ペアごとにパイプラインを遅延ロード＆Mapにキャッシュ
 *   - 翻訳実行はメインスレッドをブロックしうるため Worker 化も推奨
 *     （ここでは簡潔さ優先でメインスレッド版を実装、main.js 側で UI ロックを管理）
 *
 * モデル選定: Xenova/opus-mt-{src}-{tgt} （Helsinki-NLP の OPUS-MT 量子化版）
 *   - 1ペアあたり ~80MB (q8)
 *   - 初回 DL 後はブラウザの HTTP Cache + Transformers.js 内部キャッシュに保持
 */

// CDN から ESM 直 import。バンドラ不要で GitHub Pages に置ける構成。
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6';

let tfPromise = null;
async function loadTransformers() {
  if (!tfPromise) {
    tfPromise = import(/* @vite-ignore */ TRANSFORMERS_URL).then(mod => {
      // ローカルモデルは使わず CDN モデルだけを使う
      mod.env.allowLocalModels = false;
      mod.env.useBrowserCache = true;
      return mod;
    });
  }
  return tfPromise;
}

async function detectWebGPU() {
  try {
    if (!('gpu' in navigator)) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

export class TransformersJsEngine {
  static get name() { return 'transformers-js'; }

  constructor() {
    this._pipelines = new Map();   // "src->tgt" -> pipeline
    this._device = null;            // 'webgpu' | 'wasm'
    this._onProgress = null;        // callback(percent, message)
  }

  setProgressCallback(cb) { this._onProgress = cb; }

  async _device_() {
    if (this._device) return this._device;
    this._device = (await detectWebGPU()) ? 'webgpu' : 'wasm';
    return this._device;
  }

  static MODEL_MAP = {
    // よく使う言語ペアのみ。未登録ペアは pivot (任意言語 → en → 任意言語) で2段翻訳。
    'en->ja': 'Xenova/opus-mt-en-jap',
    'ja->en': 'Xenova/opus-mt-ja-en',
    'en->zh': 'Xenova/opus-mt-en-zh',
    'zh->en': 'Xenova/opus-mt-zh-en',
    'en->ko': 'Xenova/opus-mt-en-ko',
    'ko->en': 'Xenova/opus-mt-ko-en',
    'en->es': 'Xenova/opus-mt-en-es',
    'es->en': 'Xenova/opus-mt-es-en',
    'en->fr': 'Xenova/opus-mt-en-fr',
    'fr->en': 'Xenova/opus-mt-fr-en',
    'en->de': 'Xenova/opus-mt-en-de',
    'de->en': 'Xenova/opus-mt-de-en',
  };

  static resolveModel(source, target) {
    const direct = TransformersJsEngine.MODEL_MAP[`${source}->${target}`];
    if (direct) return { type: 'direct', model: direct };
    // 直接モデル無し → en 経由でピボット翻訳
    const a = TransformersJsEngine.MODEL_MAP[`${source}->en`];
    const b = TransformersJsEngine.MODEL_MAP[`en->${target}`];
    if (a && b) return { type: 'pivot', via: 'en', model1: a, model2: b };
    return null;
  }

  async _loadPipeline(modelId) {
    if (this._pipelines.has(modelId)) return this._pipelines.get(modelId);

    const { pipeline } = await loadTransformers();
    const device = await this._device_();

    if (this._onProgress) this._onProgress(0, `モデルロード中: ${modelId} (${device})`);

    const pipe = await pipeline('translation', modelId, {
      device,
      dtype: device === 'webgpu' ? 'fp16' : 'q8',
      progress_callback: (p) => {
        if (this._onProgress && p.status === 'progress') {
          this._onProgress(p.progress, `${modelId}: ${p.file}`);
        }
      },
    });
    this._pipelines.set(modelId, pipe);
    if (this._onProgress) this._onProgress(100, `${modelId} ready`);
    return pipe;
  }

  async translate(text, source, target) {
    if (source === 'auto') {
      throw new Error('Transformers.js requires explicit source language (use langDetect first)');
    }
    if (source === target) {
      return { text, detectedSource: source, engine: 'transformers-js' };
    }

    const route = TransformersJsEngine.resolveModel(source, target);
    if (!route) {
      throw new Error(`No model for ${source}->${target}`);
    }

    let out;
    if (route.type === 'direct') {
      const pipe = await this._loadPipeline(route.model);
      const r = await pipe(text);
      out = Array.isArray(r) ? r[0].translation_text : r.translation_text;
    } else {
      // pivot: source -> en -> target
      const pipe1 = await this._loadPipeline(route.model1);
      const r1 = await pipe1(text);
      const mid = Array.isArray(r1) ? r1[0].translation_text : r1.translation_text;
      const pipe2 = await this._loadPipeline(route.model2);
      const r2 = await pipe2(mid);
      out = Array.isArray(r2) ? r2[0].translation_text : r2.translation_text;
    }

    return {
      text: out,
      detectedSource: source,
      engine: route.type === 'pivot' ? 'transformers-js (pivot via en)' : 'transformers-js',
    };
  }
}

// 軽量言語判定（fastText に頼らず文字種ベースの簡易ヒューリスティック）
export function quickLangDetect(text) {
  const t = text.slice(0, 200);
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(t)) return 'ja';
  if (/[\uac00-\ud7af]/.test(t)) return 'ko';
  if (/[\u4e00-\u9fff]/.test(t)) return 'zh';
  if (/[áéíóúñü¿¡]/i.test(t)) return 'es';
  if (/[àâçéèêëîïôûùüÿœæ]/i.test(t)) return 'fr';
  if (/[äöüß]/i.test(t)) return 'de';
  if (/[а-яё]/i.test(t)) return 'ru';
  return 'en';
}
