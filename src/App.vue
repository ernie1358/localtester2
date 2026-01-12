<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import ScenarioList from './components/ScenarioList.vue';
import ScenarioForm from './components/ScenarioForm.vue';
import DeleteConfirmDialog from './components/DeleteConfirmDialog.vue';
import {
  getAllScenarios,
  createScenario,
  updateScenario,
  deleteScenario,
  updateScenarioOrders,
} from './services/scenarioDatabase';
import { runSelectedScenarios, scenarioRunner } from './services/scenarioRunner';
import { openResultWindow } from './services/resultWindowService';
import type { StoredScenario, PermissionStatus } from './types';

// State
const scenarios = ref<StoredScenario[]>([]);
const selectedIds = ref<Set<string>>(new Set());
const isRunning = ref(false);
const logs = ref<string[]>([]);

// Modal state
const showScenarioForm = ref(false);
const editingScenario = ref<StoredScenario | null>(null);
const showDeleteConfirm = ref(false);
const deletingScenario = ref<StoredScenario | null>(null);

// Permission state
const permissionStatus = ref<PermissionStatus | null>(null);
const apiKeyConfigured = ref(false);
const errorMessage = ref('');

// ScenarioList ref
const scenarioListRef = ref<InstanceType<typeof ScenarioList> | null>(null);

// Computed
const selectedCount = computed(() => selectedIds.value.size);
const canExecute = computed(
  () => selectedCount.value > 0 && !isRunning.value && apiKeyConfigured.value
);

// Lifecycle
onMounted(async () => {
  try {
    // Check permissions
    permissionStatus.value = await invoke<PermissionStatus>('check_permissions');
    // Check API key
    apiKeyConfigured.value = await invoke<boolean>('is_api_key_configured', {
      keyName: 'anthropic',
    });
    // Load scenarios
    await loadScenarios();
  } catch (error) {
    console.error('Initialization error:', error);
    errorMessage.value =
      error instanceof Error ? error.message : String(error);
  }
});

onUnmounted(async () => {
  await scenarioRunner.destroy();
});

// Methods
async function loadScenarios() {
  try {
    scenarios.value = await getAllScenarios();
  } catch (error) {
    console.error('Failed to load scenarios:', error);
    addLog(
      `シナリオ読み込みエラー: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function requestPermissions() {
  try {
    await invoke('request_screen_recording_permission');
    await invoke('request_accessibility_permission');
    permissionStatus.value = await invoke<PermissionStatus>('check_permissions');
  } catch (error) {
    console.error('Permission request error:', error);
  }
}

// Scenario CRUD
function openNewScenarioForm() {
  editingScenario.value = null;
  showScenarioForm.value = true;
}

function openEditForm(scenario: StoredScenario) {
  editingScenario.value = scenario;
  showScenarioForm.value = true;
}

async function handleSaveScenario(title: string, description: string) {
  try {
    if (editingScenario.value) {
      await updateScenario(editingScenario.value.id, title, description);
      addLog(`シナリオを更新しました: ${title}`);
    } else {
      await createScenario(title, description);
      addLog(`シナリオを登録しました: ${title}`);
    }
    await loadScenarios();
    showScenarioForm.value = false;
    editingScenario.value = null;
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : String(error);
  }
}

function handleCancelForm() {
  showScenarioForm.value = false;
  editingScenario.value = null;
}

function openDeleteConfirm(scenario: StoredScenario) {
  deletingScenario.value = scenario;
  showDeleteConfirm.value = true;
}

async function handleDeleteScenario() {
  if (!deletingScenario.value) return;
  try {
    await deleteScenario(deletingScenario.value.id);
    selectedIds.value.delete(deletingScenario.value.id);
    addLog(`シナリオを削除しました: ${deletingScenario.value.title}`);
    await loadScenarios();
    showDeleteConfirm.value = false;
    deletingScenario.value = null;
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : String(error);
  }
}

async function handleOrderUpdate(newOrder: StoredScenario[]) {
  scenarios.value = newOrder;
  const orders = newOrder.map((s, i) => ({ id: s.id, orderIndex: i }));
  try {
    await updateScenarioOrders(orders);
  } catch (error) {
    console.error('Failed to update order:', error);
  }
}

// Execution
async function executeSelected() {
  if (!canExecute.value) return;

  errorMessage.value = '';
  logs.value = [];
  isRunning.value = true;

  try {
    // Get selected IDs in display order from component
    const orderedIds = scenarioListRef.value?.getSelectedIdsInOrder() ?? [...selectedIds.value];

    addLog(`${orderedIds.length}個のシナリオを実行開始...`);

    const result = await runSelectedScenarios(orderedIds, scenarios.value, {
      stopOnFailure: false,
      onLog: addLog,
    });

    addLog(
      `実行完了: 成功 ${result.successCount}件 / 失敗 ${result.failureCount}件`
    );

    // Open result window
    await openResultWindow(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    errorMessage.value = msg;
    addLog(`エラー: ${msg}`);
  } finally {
    isRunning.value = false;
  }
}

function stopExecution() {
  scenarioRunner.stop();
  addLog('実行を停止しました');
}

function addLog(message: string) {
  const timestamp = new Date().toLocaleTimeString();
  logs.value.push(`[${timestamp}] ${message}`);
  setTimeout(() => {
    const logContainer = document.querySelector('.log-container');
    if (logContainer) {
      logContainer.scrollTop = logContainer.scrollHeight;
    }
  }, 0);
}
</script>

<template>
  <main class="container">
    <h1>Xenotester</h1>
    <p class="subtitle">AI Desktop Agent for Automated Testing</p>

    <!-- Permission Warning -->
    <div
      v-if="
        permissionStatus &&
        (!permissionStatus.screenRecording || !permissionStatus.accessibility)
      "
      class="warning-box"
    >
      <p>
        <strong>Permissions Required:</strong>
        Screen Recording and Accessibility permissions are required for this app
        to work.
      </p>
      <button @click="requestPermissions">Request Permissions</button>
    </div>

    <!-- API Key Warning -->
    <div v-if="!apiKeyConfigured" class="warning-box">
      <p>
        <strong>API Key Required:</strong>
        Please set ANTHROPIC_API_KEY in your .env file.
      </p>
    </div>

    <!-- Error Message -->
    <div v-if="errorMessage" class="error-box">
      {{ errorMessage }}
    </div>

    <!-- Scenario Management Section -->
    <section class="management-section">
      <div class="section-header">
        <h2>シナリオ管理</h2>
        <button
          @click="openNewScenarioForm"
          :disabled="isRunning"
          class="primary-button"
        >
          + 新規シナリオ登録
        </button>
      </div>

      <!-- Scenario List Component -->
      <ScenarioList
        ref="scenarioListRef"
        :scenarios="scenarios"
        :selected-ids="selectedIds"
        :is-running="isRunning"
        @update:selectedIds="selectedIds = $event"
        @update:order="handleOrderUpdate"
        @edit="openEditForm"
        @delete="openDeleteConfirm"
      />

      <!-- Execute Button -->
      <div class="execution-controls">
        <span class="selected-count">
          {{ selectedCount }}件選択中
        </span>
        <button
          v-if="!isRunning"
          @click="executeSelected"
          :disabled="!canExecute"
          class="execute-button"
        >
          チェックしたシナリオを実行
        </button>
        <button v-else @click="stopExecution" class="danger-button">
          停止 (Shift+Esc)
        </button>
      </div>
    </section>

    <!-- Execution Log -->
    <section class="log-section">
      <h2>実行ログ</h2>
      <div class="log-container">
        <div v-for="(log, index) in logs" :key="index" class="log-item">
          {{ log }}
        </div>
        <div v-if="logs.length === 0" class="log-empty">
          ログはまだありません...
        </div>
      </div>
    </section>

    <!-- Modals -->
    <ScenarioForm
      :visible="showScenarioForm"
      :scenario="editingScenario"
      @save="handleSaveScenario"
      @cancel="handleCancelForm"
    />

    <DeleteConfirmDialog
      :visible="showDeleteConfirm"
      :scenario-title="deletingScenario?.title ?? ''"
      @confirm="handleDeleteScenario"
      @cancel="showDeleteConfirm = false"
    />
  </main>
</template>

<style>
:root {
  font-family: Inter, Avenir, Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 24px;
  font-weight: 400;
  color: #0f0f0f;
  background-color: #f6f6f6;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
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
.container {
  max-width: 900px;
  margin: 0 auto;
  padding: 20px;
}

h1 {
  margin-bottom: 0;
  color: #24c8db;
}

.subtitle {
  color: #888;
  margin-top: 5px;
  margin-bottom: 20px;
}

h2 {
  font-size: 1.2rem;
  margin-bottom: 10px;
  margin-top: 0;
}

.warning-box,
.error-box {
  padding: 15px;
  border-radius: 8px;
  margin-bottom: 20px;
}

.warning-box {
  background-color: #fff3cd;
  border: 1px solid #ffc107;
  color: #856404;
}

.error-box {
  background-color: #f8d7da;
  border: 1px solid #f5c6cb;
  color: #721c24;
}

@media (prefers-color-scheme: dark) {
  .warning-box {
    background-color: #332701;
    border-color: #665200;
    color: #ffc107;
  }
  .error-box {
    background-color: #2c0b0e;
    border-color: #491217;
    color: #f5c6cb;
  }
}

.warning-box button {
  margin-top: 10px;
}

.management-section {
  margin-bottom: 24px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.primary-button {
  background-color: #24c8db;
  color: #fff;
  padding: 10px 20px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.primary-button:hover:not(:disabled) {
  background-color: #1ba8b8;
}

.primary-button:disabled {
  background-color: #999;
  cursor: not-allowed;
}

.execution-controls {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 16px;
  padding: 16px;
  background: #f8f9fa;
  border-radius: 8px;
}

@media (prefers-color-scheme: dark) {
  .execution-controls {
    background: #2a2a2a;
  }
}

.selected-count {
  font-weight: 500;
  color: #666;
}

@media (prefers-color-scheme: dark) {
  .selected-count {
    color: #aaa;
  }
}

.execute-button {
  background-color: #28a745;
  color: #fff;
  padding: 12px 24px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.execute-button:hover:not(:disabled) {
  background-color: #218838;
}

.execute-button:disabled {
  background-color: #999;
  cursor: not-allowed;
}

.danger-button {
  background-color: #dc3545;
  color: #fff;
  padding: 12px 24px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.danger-button:hover {
  background-color: #c82333;
}

.log-section {
  margin-bottom: 20px;
}

.log-container {
  height: 200px;
  overflow-y: auto;
  padding: 12px;
  border: 1px solid #ddd;
  border-radius: 8px;
  background-color: #1a1a1a;
  color: #0f0;
  font-family: 'Courier New', monospace;
  font-size: 12px;
}

.log-item {
  margin-bottom: 4px;
}

.log-empty {
  color: #666;
  font-style: italic;
}
</style>
