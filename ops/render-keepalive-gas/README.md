# Render keep-alive (Google Apps Script)

`https://mr-removal.onrender.com/health` を5分おきに取得し、Renderの統合サービスを起動状態に保つ運用スクリプトです。

## 操作

- `setupKeepAlive`: 重複トリガーを削除し、5分間隔のトリガーを1つ作成して初回疎通を確認します。
- `pingRender`: Renderへ1回だけヘルスチェックを送ります。
- `getKeepAliveStatus`: トリガー数と直近の結果を返します。
- `disableKeepAlive`: keep-aliveトリガーだけを削除します。

ソース反映にはリポジトリ直下で `clasp push` を使います。初回のみ、GAS編集画面で `setupKeepAlive` を選び「実行」してGoogleの権限を承認します。以後は自動実行されます。

Render Freeの750時間はワークスペース単位・暦月単位です。統合サービス以外を停止した状態で運用し、RenderのUsage画面も定期的に確認してください。
