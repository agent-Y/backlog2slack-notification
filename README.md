# Backlog 通知 → Slack 連携スクリプト

Google Apps Script で Backlog の通知を取得し、Slack に投稿するためのサンプルです。単一ワークスペース構成と複数ワークスペース構成の両方に対応しています。

- メインファイル: `back2slack.gs`
- 想定実行環境: Google Apps Script (時間主導トリガー)

## セットアップ手順

1. Google Apps Script プロジェクトを作成し、`back2slack.gs` の内容を貼り付けます。
2. メニュー「設定 → スクリプト プロパティ」を開き、以下のいずれかの方法でプロパティを登録します。

### 複数ワークスペース設定 (推奨)

`BACKLOG_CONFIGS` に JSON 配列を保存します。各要素が 1 つのワークスペース設定です。

```json
[
  {
    "space": "space1",
    "apiKey": "<Backlog API Key>",
    "webhook": "https://hooks.slack.com/services/...",
    "label": "Workspace A",
    "storageKey": "BACKLOG_LAST_SEEN_NOTIFICATION_ID__workspace_a"
  },
  {
    "space": "space2",
    "apiKey": "<Backlog API Key>",
    "webhook": "https://hooks.slack.com/services/...",
    "label": "Workspace B"
  }
]
```

- `space`: Backlog のスペースサブドメイン (例: `https://space1.backlog.com` → `space1`)
- `apiKey`: Backlog API キー
- `webhook`: Slack Incoming Webhook URL
- 任意フィールド
  - `label`: ログ出力時に使う識別名 (未指定時は自動で生成)
  - `storageKey`: 既読通知IDを保存するスクリプトプロパティ名。指定しない場合は自動生成されます。

### 単一ワークスペース設定 (旧互換)

従来の 3 つのプロパティを設定すれば、そのまま単一ワークスペースとして動作します。

- `BACKLOG_SPACE`
- `BACKLOG_API_KEY`
- `SLACK_WEBHOOK_URL`

## トリガー設定

1. 「トリガー」メニューを開き、関数 `run` を選択します。
2. イベントのソースを「時間主導型」、タイプを「分ベース」などに設定し、5〜15 分間隔で実行するのが目安です。

## 実行フロー概要

1. `run` 関数が設定情報を読み込み、ワークスペースごとに `processWorkspace` を順番に実行します。
2. 各ワークスペースで Backlog API (`/api/v2/notifications`) を呼び出し、未読かつ前回取得より新しい通知のみを抽出します。
3. 抽出した通知を Slack Webhook へ投稿し、使用した通知 ID の最大値をスクリプトプロパティへ保存します。
4. 新着が無い場合も、ワークスペースごとにログへ「新着通知なし」を出力します。

## テスト送信

`runTest` 関数を Apps Script エディタから手動実行すると、設定済みの Slack Webhook に簡単なテキストメッセージを送信できます。

## トラブルシューティング

- **`BACKLOG_CONFIGS が不正なJSONです` などのエラー**: JSON フォーマット (ダブルクォート、カンマ等) を再確認してください。
- **`space がありません` と表示される**: 設定オブジェクト内に `space` プロパティが含まれているか確認してください。
- **通知が重複する / 送信されない**: `storageKey` が設定ごとに一意になっているか確認してください。複数設定の場合は自動で重複チェックを行います。

## ライセンス

このスクリプトは MIT ライセンスで提供されます。詳細は必要に応じてライセンスファイルを追加してください。
