<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import ScenarioList from './components/ScenarioList.vue';
import ScenarioForm from './components/ScenarioForm.vue';
import DeleteConfirmDialog from './components/DeleteConfirmDialog.vue';
import LoginPage from './components/LoginPage.vue';
import StopButton from './components/StopButton.vue';
import { checkAuth, getSupabaseClient } from './services/authService';
import {
  getAllScenarios,
  createScenario,
  updateScenario,
  deleteScenario,
  updateScenarioOrders,
  getStepImages,
  addStepImage,
  deleteStepImage,
} from './services/scenarioDatabase';
import { runSelectedScenarios, scenarioRunner } from './services/scenarioRunner';
import { openResultWindow } from './services/resultWindowService';
import type { StoredScenario, PermissionStatus, StepImage, FormImageData } from './types';
import { useActionDelay } from './composables/useActionDelay';

// Authentication state
const isAuthenticated = ref(false);
const isCheckingAuth = ref(true);

// State
const scenarios = ref<StoredScenario[]>([]);
const selectedIds = ref<Set<string>>(new Set());
const isRunning = ref(false);
const isStopping = ref(false);
const logs = ref<string[]>([]);

// Action delay setting (ms after click actions before capturing screenshot)
const { actionDelayMs, actionDelayOptions } = useActionDelay();

// Modal state
const showScenarioForm = ref(false);
const editingScenario = ref<StoredScenario | null>(null);
const editingScenarioImages = ref<StepImage[]>([]);
const scenarioFormSaveError = ref('');
const showDeleteConfirm = ref(false);
const deletingScenario = ref<StoredScenario | null>(null);

// Permission state
const permissionStatus = ref<PermissionStatus | null>(null);
const apiKeyConfigured = ref(false);
const errorMessage = ref('');

// ScenarioList ref
const scenarioListRef = ref<InstanceType<typeof ScenarioList> | null>(null);

// Auth subscription cleanup
let authSubscription: { unsubscribe: () => void } | null = null;

// Emergency stop listener cleanup
let emergencyStopUnlisten: UnlistenFn | null = null;

// Computed
const selectedCount = computed(() => selectedIds.value.size);
const canExecute = computed(
  () => selectedCount.value > 0 && !isRunning.value && !isStopping.value && apiKeyConfigured.value
);

// Lifecycle
onMounted(async () => {
  // Set up emergency stop listener for UI state update
  // This is registered outside the auth try-catch to ensure it's always available
  // even if authentication fails, so emergency stop can still update UI state
  try {
    emergencyStopUnlisten = await listen('emergency-stop', () => {
      if (isRunning.value && !isStopping.value) {
        isStopping.value = true;
        addLog('緊急停止が発動しました...');
      }
    });
  } catch (error) {
    console.error('Failed to set up emergency stop listener:', error);
  }

  try {
    // Check authentication state
    isAuthenticated.value = await checkAuth();

    if (isAuthenticated.value) {
      // If authenticated, initialize the app
      await initializeApp();
    }

    // Watch for session changes
    const client = await getSupabaseClient();
    const { data } = client.auth.onAuthStateChange((event, session) => {
      isAuthenticated.value = session !== null;
      if (event === 'SIGNED_OUT') {
        // Clear state on sign out
        scenarios.value = [];
        selectedIds.value = new Set();
      }
    });
    authSubscription = data.subscription;
  } catch (error) {
    console.error('Auth check error:', error);
    // On auth check failure, keep as unauthenticated
    isAuthenticated.value = false;
  } finally {
    isCheckingAuth.value = false;
  }
});

async function initializeApp() {
  try {
    // Check permissions
    permissionStatus.value = await invoke<PermissionStatus>('check_permissions');
    // API key is now managed server-side via Edge Function
    // If authenticated, API is available
    apiKeyConfigured.value = true;
    // Load scenarios
    await loadScenarios();
  } catch (error) {
    console.error('Initialization error:', error);
    errorMessage.value =
      error instanceof Error ? error.message : String(error);
  }
}

async function handleAuthenticated() {
  isAuthenticated.value = true;
  await initializeApp();
}

onUnmounted(async () => {
  // Cleanup auth subscription
  if (authSubscription) {
    authSubscription.unsubscribe();
  }
  // Cleanup emergency stop listener
  if (emergencyStopUnlisten) {
    emergencyStopUnlisten();
  }
  await scenarioRunner.destroy();
});

// Methods
async function loadScenarios() {
  try {
    scenarios.value = await getAllScenarios();
  } catch (error) {
    console.error('Failed to load scenarios:', error);
    addLog(
      `テストステップ読み込みエラー: ${error instanceof Error ? error.message : String(error)}`
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
  editingScenarioImages.value = [];
  scenarioFormSaveError.value = '';
  showScenarioForm.value = true;
}

async function openEditForm(scenario: StoredScenario) {
  editingScenario.value = scenario;
  scenarioFormSaveError.value = '';
  // Load existing images for this scenario with error handling
  try {
    editingScenarioImages.value = await getStepImages(scenario.id);
  } catch (error) {
    console.error('Failed to load step images:', error);
    // Fallback: open form without images
    editingScenarioImages.value = [];
    addLog(
      `ヒント画像の読み込みに失敗しました: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  showScenarioForm.value = true;
}

async function handleSaveScenario(
  title: string,
  description: string,
  images: FormImageData[]
) {
  try {
    let scenarioId: string;

    // 1. Save scenario (new/update)
    if (editingScenario.value) {
      // Update existing scenario
      scenarioId = editingScenario.value.id;
      await updateScenario(scenarioId, title, description);
      addLog(`テストステップを更新しました: ${title}`);
    } else {
      // Create new scenario
      const newScenario = await createScenario(title, description);
      scenarioId = newScenario.id;
      // Store the new scenario ID to allow retry as update if image save fails
      editingScenario.value = newScenario;
      addLog(`テストステップを登録しました: ${title}`);
    }

    // 2. Process image diff with error tracking
    const imageErrors: string[] = [];
    for (const image of images) {
      try {
        if (image.existingId && image.markedForDeletion) {
          // Delete existing image marked for deletion
          await deleteStepImage(image.existingId);
        } else if (!image.existingId && !image.markedForDeletion) {
          // Add new image
          await addStepImage(scenarioId, image.base64, image.fileName, image.mimeType);
        }
        // Existing images without deletion flag are kept (no action needed)
      } catch (imgError) {
        const errorMsg = imgError instanceof Error ? imgError.message : String(imgError);
        imageErrors.push(`${image.fileName}: ${errorMsg}`);
      }
    }

    // If image errors occurred, show error in modal and don't close
    if (imageErrors.length > 0) {
      const errorMsg = `画像の保存に失敗しました:\n${imageErrors.join('\n')}\n\nテストステップ自体は保存されています。再度保存を試すか、画像を削除してください。`;
      scenarioFormSaveError.value = errorMsg;
      addLog(`エラー: 一部の画像保存に失敗しました: ${imageErrors.join(', ')}`);
      // Reload images to reflect current state (partially saved images)
      editingScenarioImages.value = await getStepImages(scenarioId);
      // Don't close the modal - let user retry or remove problematic images
      return;
    }

    await loadScenarios();
    showScenarioForm.value = false;
    editingScenario.value = null;
    editingScenarioImages.value = [];
    scenarioFormSaveError.value = '';
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : String(error);
  }
}

async function handleCancelForm() {
  // If there was a save error, the scenario might have been saved but images failed.
  // Reload the list to ensure the saved scenario is visible.
  if (scenarioFormSaveError.value) {
    await loadScenarios();
  }
  showScenarioForm.value = false;
  editingScenario.value = null;
  editingScenarioImages.value = [];
  scenarioFormSaveError.value = '';
}

function openDeleteConfirm(scenario: StoredScenario) {
  deletingScenario.value = scenario;
  showDeleteConfirm.value = true;
}

async function handleDeleteScenario() {
  if (!deletingScenario.value) return;
  try {
    await deleteScenario(deletingScenario.value.id);
    // Create new Set to trigger Vue reactivity (Set.delete doesn't trigger)
    const newSelectedIds = new Set(selectedIds.value);
    newSelectedIds.delete(deletingScenario.value.id);
    selectedIds.value = newSelectedIds;
    addLog(`テストステップを削除しました: ${deletingScenario.value.title}`);
    await loadScenarios();
    showDeleteConfirm.value = false;
    deletingScenario.value = null;
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : String(error);
  }
}

async function handleOrderUpdate(newOrder: StoredScenario[]) {
  // Store previous order for rollback (deep copy to ensure isolation)
  const previousOrder = scenarios.value.map((s) => ({ ...s }));
  // Optimistically update UI with new order
  scenarios.value = newOrder;

  const orders = newOrder.map((s, i) => ({ id: s.id, orderIndex: i }));
  try {
    await updateScenarioOrders(orders);
  } catch (error) {
    console.error('Failed to update order:', error);
    // Rollback to previous order on failure
    scenarios.value = previousOrder;
    // Show error to user
    errorMessage.value = `並び替えの保存に失敗しました: ${error instanceof Error ? error.message : String(error)}`;
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

    addLog(`${orderedIds.length}個のテストステップを実行開始...`);

    const result = await runSelectedScenarios(orderedIds, scenarios.value, {
      stopOnFailure: false,
      onLog: addLog,
      agentConfig: {
        actionDelayMs: actionDelayMs.value,
      },
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
    // Reset stopping state after execution completes
    if (isStopping.value) {
      isStopping.value = false;
      addLog('停止処理が完了しました');
    }
  }
}

function stopExecution() {
  // Prevent double-click
  if (isStopping.value) return;

  isStopping.value = true;
  addLog('停止処理を開始しています...');

  // stop() sends stop signal and returns immediately
  scenarioRunner.stop();
  // Note: isStopping.value = false is set in executeSelected's finally block
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
  <!-- Loading state -->
  <div v-if="isCheckingAuth" class="loading-container">
    <div class="loading-spinner"></div>
    <p>読み込み中...</p>
  </div>

  <!-- Login page -->
  <LoginPage
    v-else-if="!isAuthenticated"
    @authenticated="handleAuthenticated"
  />

  <!-- Main application -->
  <main v-else class="container">
    <img src="/logo.png" alt="Xenotester" class="app-logo" />

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


    <!-- Error Message -->
    <div v-if="errorMessage" class="error-box">
      {{ errorMessage }}
    </div>

    <!-- Scenario Management Section -->
    <section class="management-section">
      <div class="section-header">
        <p class="tagline">AI-Powered E2E Test Automation Tool</p>
        <button
          @click="openNewScenarioForm"
          :disabled="isRunning"
          class="primary-button"
        >
          + 新規テストステップ登録
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
        <div class="action-delay-setting">
          <label for="action-delay">各アクション後の待機時間:</label>
          <select
            id="action-delay"
            v-model="actionDelayMs"
            :disabled="isRunning"
          >
            <option
              v-for="option in actionDelayOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </div>
        <button
          v-if="!isRunning && !isStopping"
          @click="executeSelected"
          :disabled="!canExecute"
          class="execute-button"
        >
          チェックしたテストステップを実行
        </button>
        <StopButton
          v-else
          :is-stopping="isStopping"
          @stop="stopExecution"
        />
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
      :existing-images="editingScenarioImages"
      :save-error="scenarioFormSaveError"
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
  padding: 10px 20px;
}

.app-logo {
  width: 280px;
  margin-bottom: 0;
}

.tagline {
  font-size: 0.85rem;
  color: #888;
  margin: 0;
  margin-left: 10px;
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
  margin-top: 0;
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
  gap: 16px;
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

.action-delay-setting {
  display: flex;
  align-items: center;
  gap: 8px;
}

.action-delay-setting label {
  font-size: 13px;
  color: #666;
  white-space: nowrap;
}

.action-delay-setting select {
  padding: 6px 10px;
  border: 1px solid #ddd;
  border-radius: 4px;
  background: #fff;
  font-size: 13px;
  cursor: pointer;
}

.action-delay-setting select:disabled {
  background: #eee;
  cursor: not-allowed;
}

@media (prefers-color-scheme: dark) {
  .action-delay-setting label {
    color: #aaa;
  }

  .action-delay-setting select {
    background: #333;
    border-color: #555;
    color: #fff;
  }

  .action-delay-setting select:disabled {
    background: #444;
    color: #888;
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

.danger-button:hover:not(:disabled) {
  background-color: #c82333;
}

.danger-button:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.danger-button.stopping {
  background-color: #6c757d;
  cursor: wait;
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

.loading-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background-color: #f6f6f6;
  color: #666;
}

@media (prefers-color-scheme: dark) {
  .loading-container {
    background-color: #1a1a1a;
    color: #aaa;
  }
}

.loading-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid #ddd;
  border-top-color: #24c8db;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 16px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
