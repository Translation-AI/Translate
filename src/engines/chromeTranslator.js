/**
 * Tier 2: Chrome 内蔵 Translator API ラッパー。
 *
 * 仕様:
 *   - Chrome 138+ で `self.Translator` がグローバル提供される
 *   - Translator.availability({sourceLanguage, targetLanguage}) で可用性を確認
 *   - Translator.create({sourceLanguage, targetLanguage}) でインスタンス取得
 *   - インスタンスは .translate(text) で翻訳
 *   - on-device 実行・完全無料・ネットワーク不要
 *   - 言語ペアごとにモデルDLが必要（初回のみ、Chromeが内部管理）
 */

export class ChromeTranslatorEngine {
  static get name() { return 'chrome-builtin'; }

  static isSupported() {
    return typeof self !== 'undefined' && 'Translator' in self;
  }

  constructor() {
    this._instances = new Map();   // "src->tgt" -> Translator instance
  }

  async checkAvailability(source, target) {
    if (!ChromeTranslatorEngine.isSupported()) return 'unavailable';
    try {
      // 仕様上の戻り値: 'available' | 'downloadable' | 'downloading' | 'unavailable'
      return await self.Translator.availability({
        sourceLanguage: source,
        targetLanguage: target,
      });
    } catch (e) {
      return 'unavailable';
    }
  }

  async _getInstance(source, target) {
    const key = `${source}->${target}`;
    if (this._instances.has(key)) return this._instances.get(key);

    const avail = await this.checkAvailability(source, target);
    if (avail === 'unavailable') {
      throw new Error(`Chrome Translator: language pair ${key} not supported`);
    }

    const inst = await self.Translator.create({
      sourceLanguage: source,
      targetLanguage: target,
      monitor(m) {
        m.addEventListener('downloadprogress', e => {
          console.log(`[chrome-translator] DL ${(e.loaded * 100).toFixed(1)}%`);
        });
      },
    });
    this._instances.set(key, inst);
    return inst;
  }

  async translate(text, source, target) {
    // source=auto は Chrome API では未サポート → 言語検出が必要
    if (source === 'auto') {
      throw new Error('Chrome Translator requires explicit source language');
    }
    const inst = await this._getInstance(source, target);
    const out = await inst.translate(text);
    return { text: out, detectedSource: source, engine: 'chrome-builtin' };
  }
}
