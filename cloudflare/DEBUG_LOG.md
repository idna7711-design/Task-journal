# デバッグログのクラウド保存（Worker → GitHub）

アプリでエラーが起きると、デバッグログ＋端末情報が **Worker 経由で GitHub リポジトリの `debug/`** に
Markdown としてコミットされます。GitHub トークンは **Worker（サーバー側）にのみ** 置くため、
ブラウザには一切露出しません。

## 仕組み

```
ブラウザ(index.html)
  │  POST /v1/debug-log  （AIと同じBearerキーで認証）
  ▼
Cloudflare Worker (worker-openai-proxy.js)
  │  GitHub Contents API (PUT, サーバー側のトークンを使用)
  ▼
GitHub リポジトリ debug/<timestamp>-<id>.md
```

これで「今エラーが出たから見て」と伝えれば、`debug/` のファイルを読んで状況を把握できます。

## セットアップ（Worker の環境変数）

Cloudflare ダッシュボード → 対象 Worker → Settings → Variables で設定します。

| 変数名 | 種別 | 例 / 説明 |
| --- | --- | --- |
| `GITHUB_TOKEN` | Secret | Fine-grained PAT。対象リポジトリのみ・権限は **Contents: Read and write** だけでOK |
| `GITHUB_REPO` | Text | `idna7711-design/Task-journal` |
| `GITHUB_BRANCH` | Text(任意) | 既定 `main` |
| `DEBUG_LOG_DIR` | Text(任意) | 既定 `debug` |

### Fine-grained PAT の作り方
1. GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token
2. Repository access: **Only select repositories** → 対象リポジトリを選択
3. Permissions → Repository permissions → **Contents** を **Read and write** に設定
4. 発行したトークンを `GITHUB_TOKEN` に Secret として登録

> 注意: この機能を設定しない（`GITHUB_TOKEN`/`GITHUB_REPO` 未設定）場合、`/v1/debug-log` は
> 500 を返すだけで、アプリ側の自動送信は静かに失敗します（通常利用には影響しません）。

## アプリ側
- 送信先は AI エンドポイントと同じオリジンの `/v1/debug-log` を自動利用します
  （例: `https://api.edaaiapps.com/v1/chat/completions` → `https://api.edaaiapps.com/v1/debug-log`）。
- 認証は AI と同じ Bearer キー（設定の API Key）。
- 設定画面の「デバッグ」→「デバッグログを開く」から、手動でコピー / ダウンロード / 送信も可能です。
- 送信内容に **API キーやフル URL は含めません**（エンドポイントはホスト名のみ）。
