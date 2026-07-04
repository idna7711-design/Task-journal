# WindowsでのNotebookLM自動同期（予備手段）

> 2026年7月時点では、NotebookLM公式ヘルプによりGoogleドライブから追加したソースは数分ごとに自動更新されます。
> このWindowsタスクは、公式自動同期が実アカウントで動かない場合だけ使う予備手段です。

## 推奨する撤去判定

1. TaskJournalで確認用タスクを1件追加し、GAS同期を成功させる
2. 固定Googleドキュメントの本文と最終更新時刻が変わったことを確認する
3. NotebookLMを操作せず10～15分待つ
4. NotebookLMで確認用タスクが参照できれば、Windowsタスクを無効化する
5. 数日問題がなければ`TaskJournal-NotebookLM-Sync`を削除する

自動反映されなかった場合だけ、以下の非公式CLI手順を使用します。

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

過去の試験では固定Googleドキュメント更新後9分以上待っても自動取り込みされませんでした。
公式仕様が更新されたため、上記の撤去判定を再実施し、成功確認後にWindowsタスクを撤去します。
