<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { emit } from '@tauri-apps/api/event';
import { getSettings, saveSettings } from '../services/settingsService';

const isLoading = ref(true);
const isSaving = ref(false);
const saveError = ref('');
const saveSuccess = ref(false);

// Form state
const failureWebhookUrl = ref('');

// Load settings on mount
onMounted(async () => {
  try {
    const settings = await getSettings();
    failureWebhookUrl.value = settings.failureWebhookUrl;
  } catch (error) {
    console.error('Failed to load settings:', error);
    saveError.value = '設定の読み込みに失敗しました';
  } finally {
    isLoading.value = false;
  }

  // Signal that the window is ready (handshake)
  await emit('settings-window-ready');
});

async function handleSave() {
  isSaving.value = true;
  saveError.value = '';
  saveSuccess.value = false;

  // Validate URL if provided
  if (failureWebhookUrl.value.trim()) {
    try {
      new URL(failureWebhookUrl.value.trim());
    } catch {
      saveError.value = '有効なURLを入力してください';
      isSaving.value = false;
      return;
    }
  }

  try {
    await saveSettings({
      failureWebhookUrl: failureWebhookUrl.value.trim(),
    });
    saveSuccess.value = true;
    // Auto-hide success message after 2 seconds
    setTimeout(() => {
      saveSuccess.value = false;
    }, 2000);
  } catch (error) {
    console.error('Failed to save settings:', error);
    saveError.value = '設定の保存に失敗しました';
  } finally {
    isSaving.value = false;
  }
}
</script>

<template>
  <div class="settings-page">
    <h1>設定</h1>

    <div v-if="isLoading" class="loading">読み込み中...</div>

    <div v-else class="settings-content">
      <!-- Save success message -->
      <div v-if="saveSuccess" class="success-box">
        設定を保存しました
      </div>

      <!-- Save error message -->
      <div v-if="saveError" class="error-box">
        {{ saveError }}
      </div>

      <div class="settings-section">
        <h2>通知設定</h2>

        <div class="form-group">
          <label for="webhook-url">
            テスト失敗時の通知先 Webhook URL
          </label>
          <input
            id="webhook-url"
            v-model="failureWebhookUrl"
            type="url"
            placeholder="https://example.com/webhook"
            :disabled="isSaving"
          />
          <p class="hint-text">
            テストステップが失敗した際に、このURLにPOSTリクエストで通知が送信されます。<br />
            空欄の場合は通知されません。
          </p>
        </div>
      </div>

      <div class="button-row">
        <button
          class="primary-button"
          @click="handleSave"
          :disabled="isLoading || isSaving"
        >
          {{ isSaving ? '保存中...' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style>
:root {
  font-family: Inter, Avenir, Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 24px;
  color: #0f0f0f;
  background-color: #f6f6f6;
}

@media (prefers-color-scheme: dark) {
  :root {
    color: #f6f6f6;
    background-color: #1a1a1a;
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 0;
}
</style>

<style scoped>
.settings-page {
  padding: 20px;
  max-width: 600px;
  margin: 0 auto;
}

h1 {
  color: #24c8db;
  margin-bottom: 24px;
}

h2 {
  margin-top: 0;
  margin-bottom: 16px;
  font-size: 16px;
}

.loading {
  text-align: center;
  padding: 40px;
  color: #888;
}

.settings-section {
  background: #f8f9fa;
  padding: 20px;
  border-radius: 12px;
  margin-bottom: 24px;
}

@media (prefers-color-scheme: dark) {
  .settings-section {
    background: #2a2a2a;
  }
}

.success-box {
  padding: 12px 16px;
  border-radius: 6px;
  margin-bottom: 16px;
  background-color: #d4edda;
  border: 1px solid #c3e6cb;
  color: #155724;
  font-size: 14px;
}

@media (prefers-color-scheme: dark) {
  .success-box {
    background-color: #0b2e13;
    border-color: #155724;
    color: #c3e6cb;
  }
}

.error-box {
  padding: 12px 16px;
  border-radius: 6px;
  margin-bottom: 16px;
  background-color: #f8d7da;
  border: 1px solid #f5c6cb;
  color: #721c24;
  font-size: 14px;
}

@media (prefers-color-scheme: dark) {
  .error-box {
    background-color: #2c0b0e;
    border-color: #491217;
    color: #f5c6cb;
  }
}

.form-group {
  margin-bottom: 16px;
}

.form-group:last-child {
  margin-bottom: 0;
}

.form-group label {
  display: block;
  margin-bottom: 8px;
  font-weight: 500;
  font-size: 14px;
}

.form-group input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #ddd;
  border-radius: 6px;
  font-size: 14px;
  box-sizing: border-box;
}

.form-group input:focus {
  outline: none;
  border-color: #24c8db;
  box-shadow: 0 0 0 2px rgba(36, 200, 219, 0.2);
}

.form-group input:disabled {
  background: #f5f5f5;
  cursor: not-allowed;
}

@media (prefers-color-scheme: dark) {
  .form-group input {
    background: #333;
    border-color: #555;
    color: #f6f6f6;
  }

  .form-group input:disabled {
    background: #444;
  }
}

.hint-text {
  font-size: 12px;
  color: #888;
  margin-top: 8px;
  margin-bottom: 0;
  line-height: 1.5;
}

.button-row {
  display: flex;
  justify-content: flex-end;
}

.primary-button {
  background: #24c8db;
  color: white;
  padding: 10px 24px;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
}

.primary-button:hover:not(:disabled) {
  background: #1ba8b8;
}

.primary-button:disabled {
  background: #999;
  cursor: not-allowed;
}
</style>
