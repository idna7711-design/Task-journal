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
| `GEMMA_API_KEYS` | Secret | カンマ区切りで複数キー可。例 `key1,key2,key3`（アプリごとに別キー推奨） |
| `GEMMA_API_KEY` | Secret | 旧変数。`GEMMA_API_KEYS` があれば不要（後方互換のため残してもOK） |
| `CF_ACCESS_CLIENT_ID` | Secret | 既存 |
| `CF_ACCESS_CLIENT_SECRET` | Secret | 既存 |
| `UPSTREAM_BASE_URL` | Text | `https://lmstudio.edaaiapps.com` |
| `ALLOWED_ORIGINS` | Text(任意) | `https://idna7711-design.github.io`（カンマ区切りで複数可） |

> **複数アプリで使う場合**：アプリごとに別キーを発行し、`GEMMA_API_KEYS` にカンマ区切りで
> 並べます。1つ漏れても他アプリは無事です。接続情報の共通リファレンスは
> [`AI_GATEWAY.md`](./AI_GATEWAY.md)、LM Studio の常時稼働は
> [`LM_STUDIO_ALWAYS_ON.md`](./LM_STUDIO_ALWAYS_ON.md) を参照。

> `ALLOWED_ORIGINS` を設定すると、その Origin からのブラウザ呼び出しだけ CORS 許可します（推奨）。
> 未設定なら `*`（誰のサイトからでも、ただしキーが要る）になります。
> Pages版＋ローカル`file://`の両方で使う場合、`file://` は Origin が `null` になるため
> `*`（=`ALLOWED_ORIGINS`未設定）か、`null` を許可リストに加える必要があります。
> ローカルは元々 localhost 直結で使えるので、Pages用に Origin 限定するのが安全です。

## アプリ側の設定（TaskJournal → ⚙️同期・AI設定）

- **Endpoint URL**: `https://api.edaaiapps.com/v1/chat/completions`
- **Model Name**: `google/gemma-4-e4b`
- **API Key**: `GEMMA_API_KEYS` に登録したキーのいずれか（アプリ専用キー推奨）

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

## ストリーミング（逐次表示）について

リクエスト本文に `"stream": true` を付けると、LM Studio は SSE で応答を少しずつ返します。
この Worker は `upstreamRes.body`（ストリーム）を**そのまま素通し**するため、
**追加実装なしでストリーミングに対応**しています（ChatGPT風の逐次表示が可能）。

> Cloudflare Worker の CPU時間制限は計算時間に対するもので、上流からのレスポンス待ち時間は
> 含まれないため、長いストリーミング応答でも問題ありません。

## セキュリティ注意

- ブラウザに入力した `GEMMA_API_KEY` は、その**端末のローカルDB(IndexedDB)に保存**されます。
  共有端末では入力しないでください。
- キーは公開リポジトリ・チャット・HTML手順書などに**書かない**（ナレッジの運用方針どおり）。
- ブラウザ用・アプリ用に**別のAPIキー**を発行できます。本 Worker は既に
  `GEMMA_API_KEYS`（カンマ区切り）で複数キーを許容します（「許可キーの集合に含まれるか」で検証）。
