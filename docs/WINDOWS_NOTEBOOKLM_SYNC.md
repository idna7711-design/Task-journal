# WindowsでのNotebookLM自動同期

固定Googleドキュメントの更新確認とNotebookLM再同期は、Windowsタスクスケジューラで15分ごとに実行します。
n8nの`Execute Command`は使用しません。
PowerShellは非表示・非対話モードで実行するため、作業中にウィンドウや入力フォーカスを奪いません。

## 構成

1. タスクスケジューラが`scripts/notebooklm-refresh.ps1`を15分ごとに非表示実行
2. `notebooklm source stale`でGoogleドキュメントの鮮度を確認
3. 更新がある場合だけ`notebooklm source refresh`を実行

## 登録

`scripts/register-notebooklm-sync-task.ps1`へNotebookLMのノートブックID、ソースID、CLIパス、認証保存先を渡します。
登録タスク名は`TaskJournal-NotebookLM-Sync`です。Windowsへのログイン中だけ、現在のユーザー権限で動作します。

定期実行するPowerShellは`%LOCALAPPDATA%\TaskJournal\Sync`へコピーされ、
本人・SYSTEM・Administratorsだけが変更できるACLで保護されます。

NotebookLM個人版の非公開APIを利用するため、Google側の仕様変更で停止する可能性があります。
停止時は`notebooklm auth check --test`とタスクスケジューラの実行結果を確認してください。

NotebookLMのGoogleドライブソースは、このアカウントで固定Googleドキュメント更新後9分以上待っても
自動取り込みされなかったため、Windowsタスクを撤去せずフォールバックとして維持します。
