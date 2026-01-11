<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { parseScenarios } from './services/scenarioParser';
import { scenarioRunner } from './services/scenarioRunner';
import type { Scenario, ScenarioRunnerState, PermissionStatus, FailureReason } from './types';

// State
const scenarioInput = ref('');
const isRunning = ref(false);
const scenarios = ref<Scenario[]>([]);
const currentScenarioIndex = ref(-1);
const logs = ref<string[]>([]);
const permissionStatus = ref<PermissionStatus | null>(null);
const apiKeyConfigured = ref(false);
const errorMessage = ref('');

// Computed: Test summary counts
const testSummary = computed(() => {
  const passed = scenarios.value.filter((s) => s.status === 'completed').length;
  const failed = scenarios.value.filter((s) => s.status === 'failed').length;
  const stopped = scenarios.value.filter((s) => s.status === 'stopped').length;
  const pending = scenarios.value.filter(
    (s) => s.status === 'pending' || s.status === 'running' || s.status === 'skipped'
  ).length;
  return { passed, failed, stopped, pending, total: scenarios.value.length };
});

// Check permissions and API key on mount
onMounted(async () => {
  try {
    // Check permissions (macOS)
    permissionStatus.value = await invoke<PermissionStatus>('check_permissions');

    // Check API key
    apiKeyConfigured.value = await invoke<boolean>('is_api_key_configured', {
      keyName: 'anthropic',
    });
  } catch (error) {
    console.error('Initialization error:', error);
  }
});

// Cleanup on unmount
onUnmounted(async () => {
  await scenarioRunner.destroy();
});

// Request permissions
async function requestPermissions() {
  try {
    await invoke('request_screen_recording_permission');
    await invoke('request_accessibility_permission');
    // Re-check permissions
    permissionStatus.value = await invoke<PermissionStatus>('check_permissions');
  } catch (error) {
    console.error('Permission request error:', error);
  }
}

// Start test execution
async function startTest() {
  if (!scenarioInput.value.trim()) {
    errorMessage.value = 'Please enter a test scenario';
    return;
  }

  errorMessage.value = '';
  logs.value = [];
  isRunning.value = true;

  try {
    // Parse scenarios
    addLog('Parsing scenarios...');
    const parsedScenarios = await parseScenarios(scenarioInput.value);
    scenarios.value = parsedScenarios;
    addLog(`Found ${parsedScenarios.length} scenario(s)`);

    // Run scenarios
    await scenarioRunner.run(parsedScenarios, {
      stopOnFailure: false,
      onStateChange: handleStateChange,
      onLog: addLog,
    });

    addLog('All scenarios completed');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    errorMessage.value = msg;
    addLog(`Error: ${msg}`);
  } finally {
    isRunning.value = false;
  }
}

// Stop test execution
function stopTest() {
  scenarioRunner.stop();
  addLog('Test execution stopped by user');
}

// Handle state changes from runner
function handleStateChange(state: ScenarioRunnerState) {
  scenarios.value = state.scenarios;
  currentScenarioIndex.value = state.currentIndex;
  isRunning.value = state.isRunning;
}

// Add log message
function addLog(message: string) {
  const timestamp = new Date().toLocaleTimeString();
  logs.value.push(`[${timestamp}] ${message}`);

  // Auto-scroll to bottom
  setTimeout(() => {
    const logContainer = document.querySelector('.log-container');
    if (logContainer) {
      logContainer.scrollTop = logContainer.scrollHeight;
    }
  }, 0);
}

// Get status class for scenario
function getStatusClass(status: string): string {
  switch (status) {
    case 'completed':
      return 'status-completed';
    case 'failed':
      return 'status-failed';
    case 'running':
      return 'status-running';
    case 'stopped':
      return 'status-stopped';
    case 'skipped':
      return 'status-skipped';
    default:
      return 'status-pending';
  }
}

// Get status label
function getStatusLabel(status: string): string {
  switch (status) {
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'running':
      return 'Running...';
    case 'stopped':
      return 'Stopped';
    case 'skipped':
      return 'Skipped';
    default:
      return 'Pending';
  }
}

// Get result icon for scenario status
function getResultIcon(status: string): string {
  switch (status) {
    case 'completed':
      return '✓';
    case 'failed':
      return '✗';
    case 'running':
      return '⏳';
    case 'stopped':
      return '⏹';
    case 'skipped':
      return '⏭';
    default:
      return '○';
  }
}

// Get failure reason label in Japanese
function getFailureReasonLabel(reason: FailureReason | undefined): string {
  if (!reason) return '';
  const labels: Record<FailureReason, string> = {
    element_not_found: '要素が見つからない',
    action_no_effect: '操作が効果なし',
    action_execution_error: 'アクション実行エラー',
    stuck_in_loop: 'ループにスタック',
    unexpected_state: '予期しない画面状態',
    action_mismatch: 'アクション不一致',
    incomplete_actions: '未完了アクション',
    invalid_result_format: '無効な結果形式',
    max_iterations: '最大反復回数超過',
    api_error: 'APIエラー',
    user_stopped: 'ユーザー停止',
    aborted: '中断',
    unknown: '不明',
  };
  return labels[reason] || reason;
}

// Get progress display text
function getProgressText(scenario: Scenario): string {
  if (!scenario.result) return '';
  const { completedActionIndex } = scenario.result;
  const totalSteps = scenario.expectedActions?.length || 0;
  if (totalSteps === 0) return '';
  return `${completedActionIndex}/${totalSteps} ステップ完了`;
}
</script>

<template>
  <main class="container">
    <h1>Xenotester</h1>
    <p class="subtitle">AI Desktop Agent for Automated Testing</p>

    <!-- Permission Warning -->
    <div
      v-if="permissionStatus && (!permissionStatus.screenRecording || !permissionStatus.accessibility)"
      class="warning-box"
    >
      <p>
        <strong>Permissions Required:</strong>
        Screen Recording and Accessibility permissions are required for this app to work.
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

    <!-- Scenario Input -->
    <div class="input-section">
      <label for="scenario-input">Test Scenarios (Natural Language)</label>
      <textarea
        id="scenario-input"
        v-model="scenarioInput"
        placeholder="Enter your test scenarios here...&#10;&#10;Example:&#10;1. Open Chrome and navigate to google.com&#10;2. Search for 'Tauri framework'&#10;3. Click the first result"
        :disabled="isRunning"
        rows="6"
      ></textarea>

      <div class="button-row">
        <button
          v-if="!isRunning"
          @click="startTest"
          :disabled="!apiKeyConfigured"
          class="primary-button"
        >
          Start Test
        </button>
        <button v-else @click="stopTest" class="danger-button">
          Stop (Shift+Esc)
        </button>
      </div>
    </div>

    <!-- Test Summary -->
    <div v-if="scenarios.length > 0 && !isRunning" class="test-summary">
      <h2>Test Results</h2>
      <div class="summary-grid">
        <div class="summary-item summary-passed">
          <span class="summary-count">{{ testSummary.passed }}</span>
          <span class="summary-label">Passed</span>
        </div>
        <div class="summary-item summary-failed">
          <span class="summary-count">{{ testSummary.failed }}</span>
          <span class="summary-label">Failed</span>
        </div>
        <div class="summary-item summary-stopped">
          <span class="summary-count">{{ testSummary.stopped }}</span>
          <span class="summary-label">Stopped</span>
        </div>
        <div class="summary-item summary-pending">
          <span class="summary-count">{{ testSummary.pending }}</span>
          <span class="summary-label">Pending</span>
        </div>
      </div>
    </div>

    <!-- Scenario List -->
    <div v-if="scenarios.length > 0" class="scenario-list">
      <h2>Scenarios</h2>
      <div
        v-for="(scenario, index) in scenarios"
        :key="scenario.id"
        class="scenario-item"
        :class="[
          { active: index === currentScenarioIndex },
          `result-${scenario.status}`
        ]"
      >
        <div class="scenario-header">
          <span class="scenario-icon" :class="getStatusClass(scenario.status)">
            {{ getResultIcon(scenario.status) }}
          </span>
          <span class="scenario-title">{{ scenario.title }}</span>
          <span :class="['scenario-status', getStatusClass(scenario.status)]">
            {{ getStatusLabel(scenario.status) }}
          </span>
        </div>
        <div class="scenario-details">
          <span v-if="scenario.iterations" class="detail-item">
            Iterations: {{ scenario.iterations }}
          </span>
          <span v-if="getProgressText(scenario)" class="detail-item">
            {{ getProgressText(scenario) }}
          </span>
        </div>
        <!-- Failure Details -->
        <div v-if="scenario.result && scenario.status === 'failed'" class="failure-details">
          <div v-if="scenario.result.failureReason" class="failure-reason">
            <span class="failure-label">Reason:</span>
            <span class="failure-value">{{ getFailureReasonLabel(scenario.result.failureReason) }}</span>
          </div>
          <div v-if="scenario.result.failureDetails" class="failure-message">
            {{ scenario.result.failureDetails }}
          </div>
          <div v-if="scenario.result.claudeAnalysis" class="claude-analysis">
            <span class="analysis-label">Claude Analysis:</span>
            {{ scenario.result.claudeAnalysis }}
          </div>
        </div>
        <!-- Error (legacy fallback) -->
        <div v-else-if="scenario.error" class="scenario-error">
          {{ scenario.error }}
        </div>
      </div>
    </div>

    <!-- Execution Log -->
    <div class="log-section">
      <h2>Execution Log</h2>
      <div class="log-container">
        <div v-for="(log, index) in logs" :key="index" class="log-item">
          {{ log }}
        </div>
        <div v-if="logs.length === 0" class="log-empty">No logs yet...</div>
      </div>
    </div>
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

.container {
  max-width: 800px;
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

.input-section {
  margin-bottom: 20px;
}

.input-section label {
  display: block;
  margin-bottom: 8px;
  font-weight: 500;
}

textarea {
  width: 100%;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid #ddd;
  font-family: inherit;
  font-size: 14px;
  resize: vertical;
  background-color: #fff;
}

@media (prefers-color-scheme: dark) {
  textarea {
    background-color: #2a2a2a;
    border-color: #444;
    color: #f6f6f6;
  }
}

textarea:disabled {
  opacity: 0.6;
}

.button-row {
  margin-top: 12px;
  display: flex;
  gap: 10px;
}

button {
  padding: 10px 20px;
  border-radius: 8px;
  border: none;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.primary-button {
  background-color: #24c8db;
  color: #fff;
}

.primary-button:hover:not(:disabled) {
  background-color: #1ba8b8;
}

.primary-button:disabled {
  background-color: #999;
  cursor: not-allowed;
}

.danger-button {
  background-color: #dc3545;
  color: #fff;
}

.danger-button:hover {
  background-color: #c82333;
}

.scenario-list {
  margin-bottom: 20px;
}

.scenario-item {
  padding: 12px;
  border: 1px solid #ddd;
  border-radius: 8px;
  margin-bottom: 8px;
  background-color: #fff;
}

@media (prefers-color-scheme: dark) {
  .scenario-item {
    background-color: #2a2a2a;
    border-color: #444;
  }
}

.scenario-item.active {
  border-color: #24c8db;
  border-width: 2px;
}

.scenario-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.scenario-title {
  font-weight: 500;
}

.scenario-status {
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
}

.status-pending {
  background-color: #e0e0e0;
  color: #666;
}

.status-running {
  background-color: #24c8db;
  color: #fff;
}

.status-completed {
  background-color: #28a745;
  color: #fff;
}

.status-failed {
  background-color: #dc3545;
  color: #fff;
}

.status-stopped {
  background-color: #ffc107;
  color: #000;
}

.status-skipped {
  background-color: #6c757d;
  color: #fff;
}

.scenario-details {
  margin-top: 8px;
  font-size: 12px;
  color: #888;
  display: flex;
  gap: 16px;
}

.detail-item {
  display: inline-block;
}

.scenario-error {
  color: #dc3545;
  display: block;
  margin-top: 4px;
}

/* Test Summary */
.test-summary {
  margin-bottom: 20px;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.summary-item {
  padding: 16px;
  border-radius: 8px;
  text-align: center;
  border: 1px solid #ddd;
}

@media (prefers-color-scheme: dark) {
  .summary-item {
    border-color: #444;
  }
}

.summary-count {
  display: block;
  font-size: 2rem;
  font-weight: bold;
}

.summary-label {
  display: block;
  font-size: 0.85rem;
  margin-top: 4px;
}

.summary-passed {
  background-color: rgba(40, 167, 69, 0.15);
  border-color: #28a745;
}

.summary-passed .summary-count {
  color: #28a745;
}

.summary-failed {
  background-color: rgba(220, 53, 69, 0.15);
  border-color: #dc3545;
}

.summary-failed .summary-count {
  color: #dc3545;
}

.summary-stopped {
  background-color: rgba(255, 193, 7, 0.15);
  border-color: #ffc107;
}

.summary-stopped .summary-count {
  color: #ffc107;
}

.summary-pending {
  background-color: rgba(108, 117, 125, 0.15);
  border-color: #6c757d;
}

.summary-pending .summary-count {
  color: #6c757d;
}

/* Scenario Icon */
.scenario-icon {
  font-size: 1.2rem;
  margin-right: 8px;
  width: 24px;
  text-align: center;
}

/* Result-based scenario styling */
.result-completed {
  border-left: 4px solid #28a745;
}

.result-failed {
  border-left: 4px solid #dc3545;
}

.result-stopped {
  border-left: 4px solid #ffc107;
}

.result-running {
  border-left: 4px solid #24c8db;
}

/* Failure Details */
.failure-details {
  margin-top: 12px;
  padding: 12px;
  background-color: rgba(220, 53, 69, 0.1);
  border-radius: 6px;
  font-size: 13px;
}

@media (prefers-color-scheme: dark) {
  .failure-details {
    background-color: rgba(220, 53, 69, 0.2);
  }
}

.failure-reason {
  margin-bottom: 8px;
}

.failure-label,
.analysis-label {
  font-weight: 600;
  color: #dc3545;
  margin-right: 8px;
}

.failure-value {
  color: #dc3545;
}

.failure-message {
  color: #888;
  margin-bottom: 8px;
  line-height: 1.4;
}

.claude-analysis {
  color: #666;
  font-style: italic;
  border-top: 1px solid rgba(220, 53, 69, 0.3);
  padding-top: 8px;
  margin-top: 8px;
}

@media (prefers-color-scheme: dark) {
  .failure-message {
    color: #aaa;
  }

  .claude-analysis {
    color: #999;
  }
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
