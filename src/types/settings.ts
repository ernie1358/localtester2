/**
 * Settings type definitions
 */

/** アプリケーション設定 */
export interface AppSettings {
  /** テスト失敗時の通知先Webhook URL */
  failureWebhookUrl: string;
}

/** 設定テーブルの行 */
export interface SettingsRow {
  key: string;
  value: string;
  updated_at: string;
}

/** Webhook通知のペイロード */
export interface WebhookPayload {
  event: 'test_failure';
  timestamp: string;
  scenario: {
    id: string;
    title: string;
  };
  error: {
    message: string;
    failedAtAction?: string;
    lastSuccessfulAction?: string;
    completedActions: number;
  };
}
