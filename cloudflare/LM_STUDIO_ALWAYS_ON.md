# LM Studio をサーバとして常時稼働させる

複数アプリから Gemma を使うため、PC 起動時に LM Studio の
**OpenAI互換サーバ**を自動で立ち上げる手順です。

> これにより「AIが動かない → LM Studio 起動し忘れ」を防ぎます。

---

## 仕組み

```
PC起動 → LM Studio サーバ自動起動 → cloudflared(Tunnel) → Cloudflare Worker → 各アプリ
```

LM Studio には GUI を出さずにサーバだけ動かす **ヘッドレス(CLI)モード** があり、
`lms` コマンドで操作します。

---

## セットアップ（Windows）

### 1. `lms` CLI を有効化（初回のみ）

LM Studio を一度起動した状態で、PowerShell で：

```powershell
# LM Studio に同梱の lms CLI を PATH に登録
cmd /c %USERPROFILE%\.lmstudio\bin\lms.exe bootstrap
```

新しいターミナルを開いて `lms --version` が表示されれば OK。

### 2. 使うモデルを既定でロードする確認

```powershell
# サーバ起動
lms server start

# モデルをロード（初回にモデル名を確認）
lms ls                       # 手元のモデル一覧
lms load google/gemma-4-e4b  # 例：使うモデルをロード
```

### 3. 起動スクリプトを配置

このリポジトリの `cloudflare/start-lmstudio-server.bat` を
お好きな場所（例：`C:\Users\<あなた>\`）にコピーします。

内容（抜粋）:

```bat
@echo off
lms server start
lms load google/gemma-4-e4b
```

### 4. PC起動時の自動実行に登録

```
Win + R → shell:startup → Enter
```

開いたスタートアップフォルダに、`start-lmstudio-server.bat` の
**ショートカット**を入れます。次回 PC 起動から自動でサーバが立ち上がります。

---

## macOS / Linux の場合

```bash
# lms CLI 有効化（初回のみ）
~/.lmstudio/bin/lms bootstrap

# サーバ起動 + モデルロード
lms server start
lms load google/gemma-4-e4b
```

自動起動は OS の仕組みで登録：
- macOS: `launchd`（`~/Library/LaunchAgents` に plist）または「ログイン項目」
- Linux: `systemd --user` のユーザサービス

---

## 動作確認

PC 起動後、別アプリを使う前にローカルで：

```bash
curl http://localhost:1234/v1/models
```

`google/gemma-4-e4b` を含む一覧が返ればサーバ稼働中です。

---

## 注意

- `lms` のサブコマンドは LM Studio のバージョンで変わることがあります。
  うまくいかない時は `lms --help` / `lms server --help` を確認してください。
- モデルのロードは VRAM/メモリを使います。常時ロードが重い場合は
  `lms server start` だけ自動化し、ロードはアプリの初回リクエスト時に
  `--ttl` で自動ロードさせる運用も可能です（`lms server --help` 参照）。
- cloudflared(Tunnel) も常時稼働が前提です。Windows サービス化推奨：
  `cloudflared service install`。
