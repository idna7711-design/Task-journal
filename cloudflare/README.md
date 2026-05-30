# Cloudflare Worker (OpenAI互換プロキシ) — CORS対応

TaskJournal の **Pages版（HTTPS）** から、Cloudflare 経由でローカル LM Studio (Gemma) を
呼べるようにするための Worker です。`worker-openai-proxy.js` を使います。

## なぜ必要か

- Pages版は HTTPS。`http://localhost:1234` は **Mixed Content** でブラウザが遮断する。
- 一方 `https://api.edaaiapps.com/...` は HTTPS なので Mixed Content にはならない。
- ただし **ブラウザからの fetch は CORS が必須**。`Authorization` ヘッダー＋JSON を送ると
  **プリフライト(OPTIONS)** が飛ぶため、Worker が CORS ヘッダーを返さないと応答が破棄される。
  （GAS=サーバー間通信では CORS 不要だったので、既存 Worker には CORS が無い可能性が高い）

この版は **OPTIONS への応答**と **全レスポンスへの CORS 付与**を追加済み。

## 既存 Worker との差し替え/マージ

すでに `cloudflare-worker-openai-proxy.js` を運用中なら、要点だけ取り込めば十分です:

1. **OPTIONS を認証より前に処理**して `204 + CORSヘッダー` を返す
   （ブラウザは preflight に `Authorization` を載せないため、ここで認証すると必ず失敗する）
2. **本来のレスポンスにも** `Access-Control-Allow-Origin` 等を付ける

まるごと置き換えるなら、この `worker-openai-proxy.js` をエディタに貼り付け → Deploy。

## 環境変数（Cloudflare ダッシュボード → Worker → Settings → Variables）

| 変数 | 種類 | 値 |
|---|---|---|
| `GEMMA_API_KEY` | Secret | 既存のキー |
| `CF_ACCESS_CLIENT_ID` | Secret | 既存 |
| `CF_ACCESS_CLIENT_SECRET` | Secret | 既存 |
| `UPSTREAM_BASE_URL` | Text | `https://lmstudio.edaaiapps.com` |
| `ALLOWED_ORIGINS` | Text(任意) | `https://idna7711-design.github.io` |

> `ALLOWED_ORIGINS` を設定すると、その Origin からのブラウザ呼び出しだけ CORS 許可します（推奨）。
> 未設定なら `*`（誰のサイトからでも、ただしキーが要る）になります。
> Pages版＋ローカル`file://`の両方で使う場合、`file://` は Origin が `null` になるため
> `*`（=`ALLOWED_ORIGINS`未設定）か、`null` を許可リストに加える必要があります。
> ローカルは元々 localhost 直結で使えるので、Pages用に Origin 限定するのが安全です。

## アプリ側の設定（TaskJournal → ⚙️同期・AI設定）

- **Endpoint URL**: `https://api.edaaiapps.com/v1/chat/completions`
- **Model Name**: `google/gemma-4-e4b`
- **API Key**: あなたの `GEMMA_API_KEY`

保存後、AI自動分類・豆知識が Pages版からも動きます。

## CORS疎通の確認（任意）

ブラウザの DevTools コンソールで:

```js
fetch('https://api.edaaiapps.com/v1/models', {
  headers: { 'Authorization': 'Bearer ' + 'あなたのGEMMA_API_KEY' }
}).then(r => r.json()).then(console.log)
```

`google/gemma-4-e4b` を含む一覧が返れば CORS/認証ともOK。
`CORS policy` 系のエラーが出る場合は Worker の CORS 設定（特に OPTIONS 応答）を見直す。

## セキュリティ注意

- ブラウザに入力した `GEMMA_API_KEY` は、その**端末のローカルDB(IndexedDB)に保存**されます。
  共有端末では入力しないでください。
- キーは公開リポジトリ・チャット・HTML手順書などに**書かない**（ナレッジの運用方針どおり）。
- 心配なら、ブラウザ用に**別のAPIキー**を発行し、Worker側で複数キーを許容する運用も可能です
  （その場合は Worker の検証ロジックを「許可キーの集合に含まれるか」に変更）。
