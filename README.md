# Zero-Cost Translate v2 — 2 系統アーキテクチャ

> **Web UI はクライアントRAMで翻訳（GitHub Pages）／API はサーバー側で提供**

![architecture](docs/architecture.png)

## 何が変わったか（v1 → v2）

| | v1 | v2 |
|---|---|---|
| Web UI | サーバー必須（Nginx + FastAPI 経由） | **GitHub Pages 静的、ブラウザだけで完結** |
| 翻訳実行 | サーバー側のRedis/PG/LibreTranslate | **ユーザーのRAM/CPU/GPU** |
| API | UIと同居 | **独立した別トラック**（必要な人だけ使う） |
| ユーザー1人増えるコスト | サーバー負荷 +1 | **ほぼ 0**（自分のブラウザで翻訳するため） |
| プライバシー | サーバーに送信 | **デフォルトで完全オンデバイス** |
| スケール上限 | サーバー性能 | **GitHub Pages の帯域だけ**（HTML 200KB/人） |

---

## Track A: Web UI（GitHub Pages）

### エンジンチェーン（ブラウザ内）

```
1. IndexedDB cache         ─ 既訳は即返却
2. glossary.json (用語集)  ─ UI文言など
3. Chrome 内蔵 Translator API ─ Chrome 138+、on-device、追加DL最小
4. Transformers.js (OPUS-MT) ─ ONNX 量子化を WebGPU/WASM で実行
5. Server API (Track B)    ─ オプトイン。デフォルトOFF
```

### 動作要件
- Chrome 138+ → Tier 3 で完結（モデルDLはChrome内部管理）
- それ以外 → Tier 4 で OPUS-MT モデル ~80MB/言語ペアを初回DL
- iOS Safari → WASM フォールバック（やや遅いが動作）

### コスト構造
- GitHub Pages: **無料**（パブリックリポジトリ）
- 帯域: HTML/JS/CSS あわせて **200KB/ユーザー**（初回のみ、以降 SW キャッシュ）
- モデル DL: **Hugging Face CDN** 経由（GitHub の帯域を消費しない）

---

## Track B: REST API（サーバー）

機械対機械（curl、SDK、モバイルアプリ等）向け。`api-server/` に前回成果物（FastAPI + 4段フォールバック）を配置。

```bash
cd api-server && docker compose up -d
curl -X POST http://localhost/api/v1/translate \
  -H 'Content-Type: application/json' \
  -d '{"q":"Hello","target":"ja"}'
```

LLM 課金 0 円戦略は v1 と同じ：Redis 85% → PG 5% → LibreTranslate 4.5% → LLM 無料枠 0.5%。

---

## 構成

```
translate-site-v2/
├── README.md
├── docs/
│   ├── 01_design.md
│   └── architecture.png
├── src/                          ← GitHub Pages 公開対象
│   ├── index.html
│   ├── main.js
│   ├── style.css
│   ├── manifest.json
│   ├── sw.js                     ← Service Worker
│   ├── glossary.json
│   ├── cache/
│   │   └── indexedDb.js          ← Tier 1
│   └── engines/
│       ├── chromeTranslator.js   ← Tier 3
│       ├── transformersJs.js     ← Tier 4 (HF CDN)
│       └── serverApi.js          ← Tier 5 (optional)
├── api-server/                   ← Track B (前回成果物)
└── .github/workflows/
    └── pages.yml                 ← 自動デプロイ
```

## デプロイ（GitHub Pages）

```bash
# 1. GitHub にリポジトリ作成
gh repo create translate-site --public --source . --push

# 2. リポジトリ Settings → Pages → Source: "GitHub Actions"
# 3. main へ push すると自動デプロイ
#    公開URL: https://<user>.github.io/translate-site/
```

ローカル確認:
```bash
cd src && python3 -m http.server 8080
# → http://localhost:8080
```

## ライセンス
MIT
