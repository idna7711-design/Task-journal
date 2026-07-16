# AGENTS.md — AIエージェント向け開発ガイド

このリポジトリで作業する AI コーディングエージェント（Codex / Claude Code など）への説明書です。
オーナーはプログラミング・ネットワーク初心者です。**変更は安全第一、説明・コミット・UI文言はすべて日本語**でお願いします。

## このプロジェクトは何か

- **TaskJournal**: タスク管理＋自動同期＋ローカルAI連携のWebアプリ。
- **`index.html` 1枚で動く静的サイト**。GitHub Pages で公開している。
- 公開URL: <https://idna7711-design.github.io/Task-journal/>
- `main` へマージすると自動で公開される（ビルド工程なし・CI なし）。

## ファイル地図

| パス | 役割 |
| --- | --- |
| `index.html` | **アプリ本体（これ1枚）**。HTML / CSS(Tailwind CDN) / JS が全部入り。ほぼ全ての変更はこのファイルに対して行う |
| `sw.js` | Service Worker。network-first キャッシュ（通常リロードで最新が反映される） |
| `manifest.webmanifest` | PWAマニフェスト（ホーム画面追加時の名前・アイコン・テーマ色） |
| `icons/*.png` | PWA・apple-touch用アイコン（スクリプト生成のフラットアイコン。手で編集しない） |
| `.nojekyll` | GitHub Pagesで不要なJekyll処理を無効化し、静的ファイルをそのまま公開するための空ファイル |
| `cloudflare/worker-openai-proxy.js` | Cloudflare Worker のコード。AIプロキシ＋デバッグログ受け口。**デプロイは手動**（オーナーがダッシュボードに貼って Deploy） |
| `cloudflare/*.md` | Worker・AI接続まわりの運用ドキュメント |
| `gas/Code.gs` | Google Apps Script（Drive同期・カレンダー連携）。**デプロイは手動** |
| `docs/ARCHITECTURE.md` | 全体構成図と、外部サービス・secrets の所在一覧 |
| `scripts/check.mjs` | 構文チェックスクリプト（下記「動作確認」） |
| `debug/*.md` | **自動生成のエラーログ**。アプリがエラー時に Worker 経由で自動コミットする。手で編集しない。「エラーが出たから見て」と言われたらここの最新ファイルを読む |
| `design-proposals.html` | 過去のデザイン案アーカイブ（通常は触らない） |

## 開発の作法（重要）

1. **`index.html` 1枚構成を維持する。** ビルドツール・npm 依存・ファイル分割を導入しない（オーナーが管理できなくなるため）。
2. **UI文言・コードコメント・コミットメッセージは日本語。**
3. **秘密情報（APIキー・トークン類）をリポジトリやクライアントJSに絶対に書かない。** secrets は Cloudflare Worker の環境変数と、各端末のブラウザ IndexedDB にだけ存在する（詳細は `docs/ARCHITECTURE.md`）。
4. ユーザーデータ（タスク・設定）は **IndexedDB** に保存されている。保存形式を変えるときは既存データを壊さない移行処理を入れる。
5. 動的に HTML を組み立てるときはユーザー由来文字列に必ず `escapeHtml()` を通す（XSS対策）。
6. Tailwind は CDN 読み込み。ジャンルバッジの色は意図的にインラインスタイル（`GENRE_PALETTE`）で描画している（動的クラス名はパージで消えるため）。
7. ブラウザから直接呼ぶ外部API:
   - GAS Webhook（タスク同期。POST は `text/plain` で preflight 回避）
   - Worker `/v1/chat/completions`（AI。OpenAI互換）
   - Worker `/v1/debug-log`（エラーログ送信）

## 動作確認

- **構文チェック**: `node scripts/check.mjs` — 変更後は必ず実行し、「すべてOK」になることを確認する。
- **目視確認**: `index.html` をブラウザで開く（`file://` でも動く。AI・同期機能は設定画面でエンドポイント登録が必要）。

## Git / PR のルール

- `main` から作業ブランチを切る → PR を作成する。**`main` へ直接 push しない。**
- マージすると即公開される。Service Worker は network-first のため、利用者は通常リロードで最新になる。
- コミットメッセージは日本語で「何を・なぜ」が分かるように書く。

## エラー調査の手順

1. `debug/` の最新 `.md` を読む（端末情報＋直近の console ログ入り。エラー時に自動でアップロードされる）。
2. 足りなければオーナーに「設定 → デバッグ → デバッグログを開く」での確認・手動送信を依頼する。
