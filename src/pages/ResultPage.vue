<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { listen, emit } from '@tauri-apps/api/event';
import type { BatchExecutionResult, ExecutedAction } from '../types';
import { toDate } from '../types';

const result = ref<BatchExecutionResult | null>(null);

onMounted(async () => {
  // Set up listener for execution result
  await listen<BatchExecutionResult>('execution-result', (event) => {
    result.value = event.payload;
  });

  // Signal that the window is ready (handshake)
  await emit('result-window-ready');
});

function formatExecutedAt(value: Date | string): string {
  return toDate(value).toLocaleString();
}

function formatActionHistory(actions: ExecutedAction[]): string {
  return actions
    .map(
      (a, i) =>
        `${i + 1}. ${a.action}: ${a.description} [${a.success ? '成功' : '失敗'}]`
    )
    .join('\n');
}
</script>

<template>
  <div class="result-page">
    <h1>実行結果</h1>

    <div v-if="!result" class="loading">結果を読み込み中...</div>

    <div v-else class="result-content">
      <div class="summary-section">
        <h2>サマリー</h2>
        <div class="summary-grid">
          <div class="summary-item">
            <span class="label">実行済み / 選択数</span>
            <span class="value">{{ result.results.length }} / {{ result.totalScenarios }}</span>
          </div>
          <div class="summary-item success">
            <span class="label">成功</span>
            <span class="value">{{ result.successCount }}</span>
          </div>
          <div class="summary-item failure">
            <span class="label">失敗</span>
            <span class="value">{{ result.failureCount }}</span>
          </div>
        </div>
        <p class="executed-at">
          実行日時: {{ formatExecutedAt(result.executedAt) }}
        </p>
      </div>

      <div class="details-section">
        <h2>詳細結果</h2>
        <div
          v-for="(r, idx) in result.results"
          :key="r.scenarioId"
          :class="['result-item', r.success ? 'success' : 'failure']"
        >
          <div class="result-header">
            <span class="scenario-number">テストステップ{{ idx + 1 }}</span>
            <span class="scenario-title">{{ r.title }}</span>
            <span
              :class="[
                'status-badge',
                r.success ? 'badge-success' : 'badge-failure',
              ]"
            >
              {{ r.success ? '成功' : '失敗' }}
            </span>
          </div>

          <div class="result-body">
            <p>完了アクション数: {{ r.completedActions }}件</p>

            <template v-if="!r.success">
              <div class="failure-info">
                <p v-if="r.lastSuccessfulAction">
                  <strong>最後に成功したアクション:</strong><br />
                  {{ r.lastSuccessfulAction }}
                </p>
                <p v-if="r.failedAtAction">
                  <strong>失敗箇所:</strong><br />
                  {{ r.failedAtAction }}
                </p>
                <p v-if="r.error">
                  <strong>エラー:</strong><br />
                  {{ r.error }}
                </p>
              </div>

              <details
                v-if="r.actionHistory?.length > 0"
                class="action-history"
              >
                <summary>アクション履歴 ({{ r.actionHistory.length }}件)</summary>
                <pre>{{ formatActionHistory(r.actionHistory) }}</pre>
              </details>
            </template>
          </div>
        </div>
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
.result-page {
  padding: 20px;
  max-width: 800px;
  margin: 0 auto;
}

h1 {
  color: #24c8db;
  margin-bottom: 20px;
}

h2 {
  margin-top: 0;
  margin-bottom: 16px;
}

.loading {
  text-align: center;
  padding: 40px;
  color: #888;
}

.summary-section {
  background: #f8f9fa;
  padding: 20px;
  border-radius: 12px;
  margin-bottom: 24px;
}

@media (prefers-color-scheme: dark) {
  .summary-section {
    background: #2a2a2a;
  }
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin-top: 16px;
}

.summary-item {
  text-align: center;
  padding: 16px;
  background: white;
  border-radius: 8px;
}

@media (prefers-color-scheme: dark) {
  .summary-item {
    background: #333;
  }
}

.summary-item .label {
  display: block;
  font-size: 12px;
  color: #888;
}

.summary-item .value {
  display: block;
  font-size: 28px;
  font-weight: bold;
  margin-top: 4px;
}

.summary-item.success .value {
  color: #28a745;
}

.summary-item.failure .value {
  color: #dc3545;
}

.executed-at {
  font-size: 12px;
  color: #888;
  margin-top: 16px;
  margin-bottom: 0;
}

.result-item {
  border: 1px solid #ddd;
  border-radius: 8px;
  margin-bottom: 16px;
  overflow: hidden;
}

@media (prefers-color-scheme: dark) {
  .result-item {
    border-color: #444;
  }
}

.result-item.success {
  border-left: 4px solid #28a745;
}

.result-item.failure {
  border-left: 4px solid #dc3545;
}

.result-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: #f8f9fa;
}

@media (prefers-color-scheme: dark) {
  .result-header {
    background: #333;
  }
}

.scenario-number {
  font-weight: bold;
  color: #24c8db;
}

.scenario-title {
  flex: 1;
}

.badge-success {
  background: #28a745;
  color: white;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
}

.badge-failure {
  background: #dc3545;
  color: white;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
}

.result-body {
  padding: 16px;
}

.result-body p {
  margin: 0 0 8px 0;
}

.failure-info {
  background: rgba(220, 53, 69, 0.1);
  padding: 12px;
  border-radius: 6px;
  margin-top: 12px;
}

@media (prefers-color-scheme: dark) {
  .failure-info {
    background: rgba(220, 53, 69, 0.2);
  }
}

.failure-info p {
  margin: 8px 0;
}

.action-history {
  margin-top: 12px;
}

.action-history summary {
  cursor: pointer;
  color: #24c8db;
}

.action-history pre {
  background: #f5f5f5;
  padding: 12px;
  border-radius: 4px;
  font-size: 12px;
  overflow-x: auto;
  margin-top: 8px;
}

@media (prefers-color-scheme: dark) {
  .action-history pre {
    background: #333;
  }
}
</style>
