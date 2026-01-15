<script setup lang="ts">
/**
 * UpdateNotification Component
 *
 * Displays a notification banner when an app update is available.
 * Shows download progress and provides "Update Now" / "Later" buttons.
 */

import type { UpdateStatus, UpdateInfo, UpdateProgress } from '../types/updater';

defineProps<{
  status: UpdateStatus;
  updateInfo: UpdateInfo | null;
  progress: UpdateProgress | null;
  error: string | null;
}>();

const emit = defineEmits<{
  (e: 'update'): void;
  (e: 'dismiss'): void;
}>();
</script>

<template>
  <div
    v-if="status === 'available' || status === 'downloading' || status === 'error'"
    class="update-notification"
    data-testid="update-notification"
  >
    <!-- Update Available -->
    <template v-if="status === 'available' && updateInfo">
      <div class="update-content">
        <div class="update-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </div>
        <div class="update-text">
          <span class="update-title">
            新しいバージョンが利用可能です: v{{ updateInfo.version }}
          </span>
          <span v-if="updateInfo.notes" class="update-notes">
            {{ updateInfo.notes }}
          </span>
        </div>
      </div>
      <div class="update-actions">
        <button
          class="update-button primary"
          @click="emit('update')"
          data-testid="update-now-button"
        >
          今すぐ更新
        </button>
        <button
          class="update-button secondary"
          @click="emit('dismiss')"
          data-testid="update-later-button"
        >
          後で
        </button>
      </div>
    </template>

    <!-- Downloading -->
    <template v-else-if="status === 'downloading' && progress">
      <div class="update-content">
        <div class="update-icon downloading">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </div>
        <div class="update-text">
          <span class="update-title">
            ダウンロード中... {{ progress.percentage }}%
          </span>
          <div class="progress-bar">
            <div
              class="progress-fill"
              :style="{ width: `${progress.percentage}%` }"
            ></div>
          </div>
        </div>
      </div>
    </template>

    <!-- Error -->
    <template v-else-if="status === 'error'">
      <div class="update-content">
        <div class="update-icon error">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="15" y1="9" x2="9" y2="15"/>
            <line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
        </div>
        <div class="update-text">
          <span class="update-title error-text">
            更新に失敗しました
          </span>
          <span v-if="error" class="update-notes error-text">
            {{ error }}
          </span>
        </div>
      </div>
      <div class="update-actions">
        <button
          class="update-button secondary"
          @click="emit('dismiss')"
        >
          閉じる
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.update-notification {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.75rem 1rem;
  background: linear-gradient(135deg, #3b82f6, #2563eb);
  color: white;
  border-radius: 0.5rem;
  margin-bottom: 1rem;
  box-shadow: 0 2px 8px rgba(37, 99, 235, 0.3);
}

.update-content {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex: 1;
}

.update-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 50%;
  flex-shrink: 0;
}

.update-icon.downloading {
  animation: pulse 1.5s ease-in-out infinite;
}

.update-icon.error {
  background: rgba(239, 68, 68, 0.3);
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.update-text {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  flex: 1;
}

.update-title {
  font-weight: 600;
  font-size: 0.9rem;
}

.update-notes {
  font-size: 0.8rem;
  opacity: 0.9;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 400px;
}

.error-text {
  color: #fecaca;
}

.progress-bar {
  width: 100%;
  height: 6px;
  background: rgba(255, 255, 255, 0.3);
  border-radius: 3px;
  overflow: hidden;
  margin-top: 0.25rem;
}

.progress-fill {
  height: 100%;
  background: white;
  border-radius: 3px;
  transition: width 0.2s ease;
}

.update-actions {
  display: flex;
  gap: 0.5rem;
  flex-shrink: 0;
}

.update-button {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 0.375rem;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.update-button.primary {
  background: white;
  color: #2563eb;
}

.update-button.primary:hover {
  background: #f0f9ff;
}

.update-button.secondary {
  background: rgba(255, 255, 255, 0.2);
  color: white;
}

.update-button.secondary:hover {
  background: rgba(255, 255, 255, 0.3);
}
</style>
