# AI Gateway 共通設定リファレンス

このファイルは、Cloudflare Worker 経由でローカル Gemma を呼ぶための
**シークレット不要の接続情報**をまとめたものです。

新しいアプリを作る際はここの値をコピーして設定画面に貼ってください。

## エンドポイント

```
https://api.edaaiapps.com/v1/chat/completions
```

## モデル名

```
google/gemma-4-e4b
```

## 認証方式

```
Authorization: Bearer <あなたのアプリ用キー>
```

> **キー自体はここに書かない。**
> Cloudflare Worker の `GEMMA_API_KEYS`（Secret）にカンマ区切りで管理します。

---

## 新しいアプリを追加するとき

1. 新キーを生成（パスワードマネージャ等でランダム文字列）
2. [Cloudflare ダッシュボード](https://dash.cloudflare.com/) → Worker → Settings → Variables
   → `GEMMA_API_KEYS` の値の末尾に `,新キー` を追加して保存
3. アプリの設定画面に上記 Endpoint / Model / キーを入力

Worker のコードは変更不要です。

---

## 環境変数まとめ（Worker Settings）

| 変数名 | 種類 | 内容 |
|---|---|---|
| `GEMMA_API_KEYS` | Secret | カンマ区切りキー一覧 例: `key1,key2` |
| `GEMMA_API_KEY` | Secret | 旧変数（後方互換。GEMMA_API_KEYS があれば不要） |
| `CF_ACCESS_CLIENT_ID` | Secret | Cloudflare Access Service Token ID |
| `CF_ACCESS_CLIENT_SECRET` | Secret | 同 Secret |
| `UPSTREAM_BASE_URL` | Text | `https://lmstudio.edaaiapps.com` |
| `ALLOWED_ORIGINS` | Text | `https://idna7711-design.github.io`（カンマ区切りで複数可） |

---

## 動作確認コマンド

ブラウザの DevTools コンソール（F12）で実行：

```js
fetch('https://api.edaaiapps.com/v1/models', {
  headers: { 'Authorization': 'Bearer あなたのキー' }
}).then(r => r.json()).then(console.log)
```

`google/gemma-4-e4b` を含む一覧が返れば OK。

---

## よくあるトラブル

| 症状 | 原因 | 対処 |
|---|---|---|
| `CORS policy` エラー | Worker 未更新 / ALLOWED_ORIGINS 不一致 | Worker 再デプロイ・設定確認 |
| `401` | キーが違う | Worker の GEMMA_API_KEYS と一致しているか確認 |
| Error 1033 | cloudflared 停止 | `Start-Service cloudflared`（Windows） |
| タイムアウト | LM Studio 未起動 / モデル未ロード | PC で LM Studio を起動してモデルをロード |
