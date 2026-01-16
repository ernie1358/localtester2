/**
 * Settings Service - Manage application settings via SQLite
 */

import Database from '@tauri-apps/plugin-sql';
import type { AppSettings, SettingsRow } from '../types';

// 設定のキー名
const SETTINGS_KEYS = {
  FAILURE_WEBHOOK_URL: 'failure_webhook_url',
} as const;

// デフォルト値
const DEFAULT_SETTINGS: AppSettings = {
  failureWebhookUrl: '',
};

let db: Database | null = null;

/**
 * Get or create database connection
 */
async function getDatabase(): Promise<Database> {
  if (!db) {
    db = await Database.load('sqlite:xenotester.db');
  }
  return db;
}

/**
 * Get a single setting value
 */
async function getSetting(key: string): Promise<string | null> {
  const database = await getDatabase();
  const results = await database.select<SettingsRow[]>(
    'SELECT value FROM settings WHERE key = ?',
    [key]
  );
  return results[0]?.value ?? null;
}

/**
 * Set a single setting value
 */
async function setSetting(key: string, value: string): Promise<void> {
  const database = await getDatabase();
  await database.execute(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    [key, value]
  );
}

/**
 * Get all application settings
 */
export async function getSettings(): Promise<AppSettings> {
  const failureWebhookUrl = await getSetting(SETTINGS_KEYS.FAILURE_WEBHOOK_URL);

  return {
    failureWebhookUrl: failureWebhookUrl ?? DEFAULT_SETTINGS.failureWebhookUrl,
  };
}

/**
 * Save application settings
 */
export async function saveSettings(settings: Partial<AppSettings>): Promise<void> {
  if (settings.failureWebhookUrl !== undefined) {
    await setSetting(SETTINGS_KEYS.FAILURE_WEBHOOK_URL, settings.failureWebhookUrl);
  }
}

/**
 * Get failure webhook URL (convenience function)
 */
export async function getFailureWebhookUrl(): Promise<string> {
  return (await getSetting(SETTINGS_KEYS.FAILURE_WEBHOOK_URL)) ?? '';
}
