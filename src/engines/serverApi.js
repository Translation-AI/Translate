/**
 * Tier 4: サーバーAPI 呼び出し（オプトイン）。
 *
 * デフォルトはOFF。ユーザーが明示的に有効化＋URLを設定した場合のみ送信される。
 * 送信内容: 入力テキスト・src/tgt 言語（プライバシー警告は UI 側で表示済み）
 */
export class ServerApiEngine {
  static get name() { return 'server-api'; }

  constructor(baseUrl) {
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
  }

  isConfigured() {
    return !!this.baseUrl;
  }

  async translate(text, source, target) {
    if (!this.isConfigured()) {
      throw new Error('Server API not configured');
    }
    const r = await fetch(`${this.baseUrl}/api/v1/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source, target, format: 'text' }),
    });
    if (!r.ok) throw new Error(`Server API ${r.status}`);
    const j = await r.json();
    return {
      text: j.translatedText,
      detectedSource: j.detectedSourceLanguage || source,
      engine: `server:${j.engine || 'unknown'}`,
    };
  }
}
