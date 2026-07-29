# TaskJournal

タスク管理＋自動同期＋ローカルAI連携のWebアプリ。
**`index.html` 1枚で動く静的サイト**で、GitHub Pages で公開しています。

- **公開URL**: <https://idna7711-design.github.io/Task-journal/>

## 主な機能

- 📝 タスク管理（すぐ追加・日時を指定する詳細追加・ジャンル・メモ・アプリ内カレンダーでの予定確認）
- 📅 カレンダー連携（日・週・月表示、Google予定の確認、専用カレンダーへの追加・更新・削除同期）
- ☁️ Google Drive 自動同期（GAS Webhook 経由・複数端末OK）
- 🛟 古い未同期タスクを失わず自動復旧（不一致は競合候補として保持）
- 📚 固定Googleドキュメント経由のNotebookLM自動更新（同期後にGASがバックグラウンド更新）
- 🤖 ローカルAI（LM Studio / Gemma）によるタスク自動分類
- 🐛 エラー時のデバッグログ自動クラウド保存（`debug/` へ自動コミット）
- 📱 PWA対応（インターネットにつながらないときでも、一度開いたアプリを起動できます）

## 使い方

ブラウザで公開URLを開くだけです。
同期・AI機能を使う場合は、アプリの ⚙️ 設定から各エンドポイントを登録します
（接続値のリファレンス: [`cloudflare/AI_GATEWAY.md`](./cloudflare/AI_GATEWAY.md)）。

## 構成

```
ブラウザ(index.html) ─┬─ GAS ──────── Google Drive（タスク同期）
                      │                 ├─ Googleカレンダー（選択中の予定を読み取り）
                      │                 └─ TaskJournal専用カレンダー（連携タスクを同期）
                      ├─ Cloudflare Worker ── LM Studio/Gemma（AI）
                      ├─ Cloudflare Worker ── GitHub debug/（エラーログ）
```

詳細: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)

## 開発（人間・AIエージェント共通）

- **開発ガイド: [`AGENTS.md`](./AGENTS.md)** — Codex / Claude Code などのエージェントはここを読む
- 変更後の確認: `node scripts/check.mjs`（構文チェック。「すべてOK」になること）
- 原則: `index.html` 1枚構成・ビルド不要・日本語コミット・secrets はリポジトリに置かない

## 関連ドキュメント

| ドキュメント | 内容 |
| --- | --- |
| [`AGENTS.md`](./AGENTS.md) | AIエージェント向け開発ガイド（作法・チェック方法・PRルール） |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | 全体構成図・外部サービスと secrets の所在 |
| [`cloudflare/README.md`](./cloudflare/README.md) | AIプロキシ Worker のセットアップ |
| [`cloudflare/DEBUG_LOG.md`](./cloudflare/DEBUG_LOG.md) | デバッグログ機能のセットアップ |
| [`cloudflare/AI_GATEWAY.md`](./cloudflare/AI_GATEWAY.md) | AI接続情報の共通リファレンス |
| [`cloudflare/LM_STUDIO_ALWAYS_ON.md`](./cloudflare/LM_STUDIO_ALWAYS_ON.md) | LM Studio の常時稼働設定 |
| [`gas/README.md`](./gas/README.md) | Google Apps Script（同期バックエンド）のデプロイ手順 |
| [`docs/WINDOWS_NOTEBOOKLM_SYNC.md`](./docs/WINDOWS_NOTEBOOKLM_SYNC.md) | Windows上のNotebookLM自動同期 |
