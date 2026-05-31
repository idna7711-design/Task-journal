@echo off
REM ============================================================
REM LM Studio をヘッドレス(GUIなし)でサーバ起動するスクリプト
REM   PC起動時に自動実行させると、各アプリから常時 Gemma を使える
REM
REM 使い方:
REM   1. このファイルを任意の場所にコピー
REM   2. ショートカットを スタートアップフォルダ に入れる
REM      (Win+R -> shell:startup -> Enter)
REM
REM 事前準備: lms CLI を有効化しておくこと
REM   cmd /c %USERPROFILE%\.lmstudio\bin\lms.exe bootstrap
REM ============================================================

REM OpenAI互換サーバを起動 (既定ポート 1234)
lms server start

REM 使うモデルをロード (必要に応じてモデル名を変更)
lms load google/gemma-4-e4b

REM サーバはバックグラウンドで動き続けます。
REM 状態確認: lms server status
