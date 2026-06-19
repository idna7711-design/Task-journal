# TaskJournal → NotebookLM 自動同期

固定IDのGoogleドキュメントが更新されたときだけ、ローカルn8nからNotebookLMのソース再同期を実行します。

## 構成

1. 2分ごとに`scripts/notebooklm-refresh.ps1`を実行
2. `notebooklm source stale`で登録済みGoogleドキュメントの鮮度を確認
3. 変更がある場合だけ`notebooklm source refresh`を実行

## 必要なもの

- ローカルn8n
- Python 3.10以上
- 非公式`notebooklm-py[browser]`
- NotebookLMへ登録済みの固定Googleドキュメント

`taskjournal-notebooklm-sync.template.json`内の以下の値は、インポート前に実値へ置換します。

- `__NOTEBOOK_ID__`
- `__SOURCE_ID__`
- `__REFRESH_SCRIPT_PATH__`
- `__NOTEBOOKLM_COMMAND__`
- `__NOTEBOOKLM_HOME__`

NotebookLM個人版の非公開APIを利用するため、Google側の仕様変更で停止する可能性があります。
停止時は`notebooklm auth check --test`とn8nの実行履歴を確認してください。
