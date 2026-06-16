# 翻訳サイト 設計書 v2 — 2系統アーキテクチャ

## 1. なぜ「Web UIはクライアントRAM、APIはサーバー」なのか

| トラック | 担当 | スケール特性 | コスト |
|---|---|---|---|
| **A: Web UI** (GitHub Pages) | ブラウザの RAM/CPU/GPU で翻訳 | **ユーザー数 ∞ で線形スケール（各人のRAMを使うから）** | **完全 0 円**（GitHub Pages無料枠） |
| **B: REST API** (自前サーバ) | サーバー側でフォールバック翻訳 | サーバー性能に依存 | LLM は無料枠、インフラはVPS固定費 |

→ ブラウザ閲覧ユーザーは **無料インフラに無限ぶらさげる** ことが可能。  
→ API 利用者（curl/SDK/モバイル）だけサーバー負荷になるが、規模が桁違いに小さい。

「**1日100万回**」のうち、UIアクセスが大半なら **サーバー負荷は限りなく 0** に近づく。

## 2. Track A: GitHub Pages + クライアント翻訳

### 2.1 エンジン優先順位（クライアント側）

```
[1] IndexedDB キャッシュ          — 既訳済みは瞬時に返す（~500MB保持）
       ↓ ミス
[2] Chrome 内蔵 Translator API     — window.Translator (Chrome 138+, on-device, 完全無料・即時)
       ↓ 未対応 or 言語ペア無し
[3] Transformers.js (OPUS-MT)     — ONNX量子化版を WebGPU/WASM で実行
                                      ・モデルサイズ: ~80MB/言語ペア (q8量子化)
                                      ・初回 DL、以降は IndexedDB にキャッシュ
                                      ・WebGPU 対応: ~50ms/文、WASM: ~300ms/文
       ↓ ロード失敗 or ユーザーが明示的に有効化した場合のみ
[4] サーバーAPI (Track B)          — オプトイン。デフォルトはOFF
```

**重要**: Track A はネットワークアクセスを **モデルDL以外で行わない** デフォルト設定。プライバシー完全保護。

### 2.2 GitHub Pages の制約と対策

| 制約 | 対策 |
|---|---|
| 静的のみ（JSなし不可） | Vite ビルドの静的バンドルでOK |
| 1ファイル100MB上限 | モデルは Hugging Face CDN から直接DL（リポジトリには含めない） |
| 帯域 100GB/月 ソフトリミット | モデルは HF CDN 経由なのでGH帯域は使わない。HTML/JS/CSSのみ→1人 ~200KB |
| ビルドサイズ 1GB | 上記により余裕 |

→ **GitHub Pages の帯域消費は 1ユーザー約 200KB**。100万ユーザー/日 × 200KB = 200GB/日 だが、初回以降は Service Worker でキャッシュされるため実質はその 1/10 以下。

### 2.3 ハードウェア要件と劣化動作

| ユーザー環境 | 動作モード |
|---|---|
| Chrome 138+ (内蔵 Translator API 有) | **Tier 2 のみで完結**、モデルDL不要 |
| WebGPU 対応ブラウザ | Transformers.js + WebGPU、~50ms/文 |
| WebGPU 非対応 (Safari iOS など) | Transformers.js + WASM、~300ms/文 |
| RAM < 2GB | モデルロード警告 → API オプトイン誘導 |

## 3. Track B: REST API（サーバー側）

これは前回設計の縮小版を流用。**機械対機械の利用**のみ想定。

```
POST /api/v1/translate
  → Redis L1 → PG L2 → LibreTranslate L3 → LLM無料枠 L4
```

UI が無料で広がる前提なので、API 利用者は限定的（推定 全体の 1% 未満）。  
→ サーバーは **t3.small 1台 + 自前 Redis/PG** で十分。

## 4. ディレクトリ構造

```
translate-site-v2/
├── README.md
├── docs/
│   ├── 01_design.md
│   └── architecture.png
├── src/                          ← GitHub Pages にデプロイされる
│   ├── index.html
│   ├── main.js                   ← エンジン初期化＋ルーティング
│   ├── engines/
│   │   ├── chromeTranslator.js   ← Tier 2: window.Translator
│   │   ├── transformersJs.js     ← Tier 3: HF Transformers.js
│   │   └── serverApi.js          ← Tier 4: オプトイン
│   ├── cache/
│   │   └── indexedDb.js          ← Tier 1: IDB キャッシュ
│   ├── glossary.json             ← 共通用語集（リポジトリ管理）
│   ├── sw.js                     ← Service Worker (静的資産キャッシュ)
│   └── style.css
├── api-server/                   ← Track B (前回成果物を流用)
│   └── (前回の backend/ 一式)
└── .github/workflows/
    └── pages.yml                 ← GitHub Pages 自動デプロイ
```

## 5. デプロイ手順

```bash
# 1. リポジトリ作成
gh repo create translate-site --public
git init && git add . && git commit -m "init" && git push

# 2. GitHub Pages 有効化（自動）
#    .github/workflows/pages.yml が走り、src/ を Pages にデプロイ

# 3. API サーバー（必要な場合のみ）
cd api-server && docker compose up -d
```

公開URL例: `https://<user>.github.io/translate-site/`

## 6. プライバシーとオフライン動作

- Tier 1〜3 はすべてオンデバイス → **入力テキストが外部に出ない**
- Service Worker により **初回ロード以降はオフラインで動作**
- API オプトインは明示的なトグルが必要（デフォルトOFF）
