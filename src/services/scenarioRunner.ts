/**
 * Scenario Runner - Orchestrate multiple scenario executions
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { runAgentLoop, type AgentLoopResult } from './agentLoop';
import { getStepImages } from './scenarioDatabase';
import type {
  Scenario,
  ScenarioRunnerState,
  AgentLoopConfig,
  StoredScenario,
  BatchExecutionResult,
  ScenarioExecutionResult,
} from '../types';
import { mapTestResultStatusToScenarioStatus } from '../types';
import { validateHintImages } from '../constants/hintImages';
import { sendFailureNotification } from './webhookService';

/** Options for scenario runner */
export interface ScenarioRunnerOptions {
  stopOnFailure?: boolean;
  onStateChange?: (state: ScenarioRunnerState) => void;
  onLog?: (message: string) => void;
  agentConfig?: Partial<AgentLoopConfig>;
}

/**
 * Scenario Runner class for orchestrating scenario execution
 */
export class ScenarioRunner {
  private state: ScenarioRunnerState = {
    scenarios: [],
    currentIndex: -1,
    isRunning: false,
    stopOnFailure: false,
  };

  private abortController: AbortController | null = null;
  private onStateChange?: (state: ScenarioRunnerState) => void;
  private onLog?: (message: string) => void;
  private emergencyStopUnlisten?: UnlistenFn;

  constructor() {
    // Set up emergency stop listener
    this.setupEmergencyStopListener();
  }

  /**
   * Set up listener for emergency stop event from Rust backend
   */
  private async setupEmergencyStopListener(): Promise<void> {
    this.emergencyStopUnlisten = await listen('emergency-stop', () => {
      this.log('[Scenario Runner] Emergency stop triggered');
      this.stop('stopped');
    });
  }

  /**
   * Clean up resources
   */
  public async destroy(): Promise<void> {
    if (this.emergencyStopUnlisten) {
      this.emergencyStopUnlisten();
    }
  }

  /**
   * Run a queue of scenarios
   */
  public async run(
    scenarios: Scenario[],
    options: ScenarioRunnerOptions = {}
  ): Promise<ScenarioRunnerState> {
    // Initialize state
    this.state = {
      scenarios: scenarios.map((s) => ({ ...s, status: 'pending' })),
      currentIndex: 0,
      isRunning: true,
      stopOnFailure: options.stopOnFailure ?? false,
    };

    this.onStateChange = options.onStateChange;
    this.onLog = options.onLog;
    this.abortController = new AbortController();

    // Clear any previous stop request
    await invoke('clear_stop');

    this.notifyStateChange();

    // Execute scenarios sequentially
    for (let i = 0; i < this.state.scenarios.length; i++) {
      if (!this.state.isRunning) break;

      this.state.currentIndex = i;
      const scenario = this.state.scenarios[i];

      // Skip if previous failed and stopOnFailure is set
      if (i > 0 && this.state.stopOnFailure) {
        const prevScenario = this.state.scenarios[i - 1];
        if (prevScenario.status === 'failed') {
          scenario.status = 'skipped';
          this.notifyStateChange();
          continue;
        }
      }

      // Execute scenario
      await this.executeScenario(scenario, options);
    }

    this.state.isRunning = false;
    this.notifyStateChange();

    return this.state;
  }

  /**
   * Execute a single scenario
   */
  private async executeScenario(
    scenario: Scenario,
    options: ScenarioRunnerOptions
  ): Promise<void> {
    scenario.status = 'running';
    scenario.startedAt = new Date();
    scenario.iterations = 0;
    this.notifyStateChange();

    this.log(`[Scenario Runner] Starting scenario: ${scenario.title}`);

    try {
      // Load hint images for this scenario (optional - continue without images on failure)
      let hintImages: import('../types').StepImage[] = [];
      try {
        hintImages = await getStepImages(scenario.id);
        if (hintImages.length > 0) {
          this.log(`[Scenario Runner] ${hintImages.length}枚のヒント画像を読み込みました`);

          // Validate hint images against API constraints
          const validation = validateHintImages(hintImages);
          if (!validation.valid && validation.error) {
            // Images exceed API limits - stop execution and ask user to reduce images
            const errorMsg = `ヒント画像がAPI制限を超えています。実行を中止しました。\n${validation.error}\nテストステップを編集して画像を減らすか、5MB以下の画像に置き換えてください。`;
            this.log(`[Scenario Runner] エラー: ${errorMsg}`);
            throw new Error(errorMsg);
          }
        }
      } catch (imageError) {
        // Re-throw validation errors (these should stop execution)
        if (imageError instanceof Error && imageError.message.includes('API制限を超えています')) {
          throw imageError;
        }
        // DB read failure is also a critical error - stop execution to prevent running without expected hints
        const errorMsg = `ヒント画像の読み込みに失敗しました: ${imageError instanceof Error ? imageError.message : String(imageError)}`;
        this.log(`[Scenario Runner] エラー: ${errorMsg}`);
        throw new Error(errorMsg);
      }

      const result: AgentLoopResult = await runAgentLoop({
        scenario,
        hintImages,
        abortSignal: this.abortController!.signal,
        onIteration: (iteration) => {
          scenario.iterations = iteration;
          this.notifyStateChange();
        },
        onLog: this.log.bind(this),
        config: options.agentConfig,
      });

      // Store TestResult and expectedActions in Scenario
      scenario.result = result.testResult;
      scenario.expectedActions = result.expectedActions;
      // Use mapTestResultStatusToScenarioStatus for consistent status mapping
      scenario.status = mapTestResultStatusToScenarioStatus(result.testResult.status);
      scenario.error = result.testResult.failureDetails;
      scenario.iterations = result.iterations;
      scenario.completedAt = new Date();

      const statusEmoji = result.testResult.status === 'success' ? '✓' : '✗';
      this.log(
        `[Scenario Runner] ${statusEmoji} Scenario ${result.testResult.status}: ${scenario.title} - ${result.testResult.claudeAnalysis || result.testResult.failureDetails || ''}`
      );

      // Send webhook notification on failure
      if (result.testResult.status !== 'success') {
        sendFailureNotification(scenario.id, scenario.title, {
          scenarioId: scenario.id,
          title: scenario.title,
          success: false,
          error: result.testResult.failureDetails || 'Unknown error',
          completedActions: result.completedActionCount ?? 0,
          failedAtAction: result.failedAtAction,
          lastSuccessfulAction: result.lastSuccessfulAction,
          actionHistory: result.executedActions.map((a) => ({
            index: a.index,
            action: a.action,
            description: a.description,
            success: a.success,
            timestamp: a.timestamp,
          })),
        }).catch((err) => {
          this.log(`[Scenario Runner] Webhook通知の送信に失敗: ${err}`);
        });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        scenario.status = 'stopped';
      } else {
        scenario.status = 'failed';
        scenario.error = error instanceof Error ? error.message : String(error);

        // Send webhook notification on exception
        sendFailureNotification(scenario.id, scenario.title, {
          scenarioId: scenario.id,
          title: scenario.title,
          success: false,
          error: scenario.error,
          completedActions: 0,
          actionHistory: [],
        }).catch((err) => {
          this.log(`[Scenario Runner] Webhook通知の送信に失敗: ${err}`);
        });
      }
      scenario.completedAt = new Date();
    }

    this.notifyStateChange();
  }

  /**
   * Stop execution
   */
  public stop(finalStatus: 'stopped' | 'failed' = 'stopped'): void {
    this.state.isRunning = false;

    // Notify Rust backend to stop any ongoing operations (e.g., wait)
    invoke('request_stop').catch((err) => {
      console.error('[Scenario Runner] Failed to request stop:', err);
    });

    if (this.abortController) {
      this.abortController.abort();
    }

    // Update current scenario status
    const current = this.state.scenarios[this.state.currentIndex];
    if (current && current.status === 'running') {
      current.status = finalStatus;
      current.completedAt = new Date();
    }

    // Mark pending scenarios as skipped
    for (let i = this.state.currentIndex + 1; i < this.state.scenarios.length; i++) {
      if (this.state.scenarios[i].status === 'pending') {
        this.state.scenarios[i].status = 'skipped';
      }
    }

    this.notifyStateChange();
  }

  /**
   * Get current state
   */
  public getState(): ScenarioRunnerState {
    return { ...this.state };
  }

  /**
   * Check if running
   */
  public isRunning(): boolean {
    return this.state.isRunning;
  }

  private notifyStateChange(): void {
    if (this.onStateChange) {
      this.onStateChange({ ...this.state });
    }
  }

  private log(message: string): void {
    if (this.onLog) {
      this.onLog(message);
    } else {
      console.log(message);
    }
  }

  /**
   * Run selected scenarios from StoredScenario list in order
   * Uses existing emergency-stop listener
   * @param orderedScenarioIds - Scenario IDs in execution order
   * @param scenarios - All scenario data
   */
  public async runSelected(
    orderedScenarioIds: string[],
    scenarios: StoredScenario[],
    options: ScenarioRunnerOptions = {}
  ): Promise<BatchExecutionResult> {
    const results: ScenarioExecutionResult[] = [];
    let successCount = 0;
    let failureCount = 0;

    // Initialize state using existing state management
    this.state = {
      scenarios: [],
      currentIndex: 0,
      isRunning: true,
      stopOnFailure: options.stopOnFailure ?? false,
    };

    this.onStateChange = options.onStateChange;
    this.onLog = options.onLog;
    this.abortController = new AbortController();

    // Clear any previous stop request
    await invoke('clear_stop');

    // Notify initial state
    this.notifyStateChange();

    // Execute in orderedScenarioIds order (order guarantee)
    for (let i = 0; i < orderedScenarioIds.length; i++) {
      const scenarioId = orderedScenarioIds[i];

      // Stop check (including emergency-stop listener setting isRunning to false)
      if (!this.state.isRunning) {
        this.log('[Batch Runner] Execution stopped');
        break;
      }

      const stopRequested = await invoke<boolean>('is_stop_requested');
      if (stopRequested || this.abortController.signal.aborted) {
        this.log('[Batch Runner] Stop requested');
        break;
      }

      const scenario = scenarios.find((s) => s.id === scenarioId);
      if (!scenario) continue;

      this.state.currentIndex = i;
      this.notifyStateChange();
      this.log(
        `[Batch Runner] テストステップ開始 (${i + 1}/${orderedScenarioIds.length}): ${scenario.title}`
      );

      // Load hint images for this scenario (optional - continue without images on failure)
      let hintImages: import('../types').StepImage[] = [];
      try {
        hintImages = await getStepImages(scenario.id);
        if (hintImages.length > 0) {
          this.log(`[Batch Runner] ${hintImages.length}枚のヒント画像を読み込みました`);

          // Validate hint images against API constraints (same as executeScenario)
          const validation = validateHintImages(hintImages);
          if (!validation.valid && validation.error) {
            // Images exceed API limits - stop execution and ask user to reduce images
            const errorMsg = `ヒント画像がAPI制限を超えています。実行を中止しました。\n${validation.error}\nテストステップを編集して画像を減らすか、5MB以下の画像に置き換えてください。`;
            this.log(`[Batch Runner] エラー: ${errorMsg}`);

            // Webhook通知用の結果オブジェクトを作成
            const validationFailureResult: ScenarioExecutionResult = {
              scenarioId: scenario.id,
              title: scenario.title,
              success: false,
              error: errorMsg,
              completedActions: 0,
              actionHistory: [],
            };

            // Webhook通知を送信（非同期、エラーは握りつぶす）
            sendFailureNotification(scenario.id, scenario.title, validationFailureResult).catch((err) => {
              this.log(`[Batch Runner] Webhook通知の送信に失敗: ${err}`);
            });

            // Record failure for this scenario and stop batch execution
            results.push(validationFailureResult);
            failureCount++;
            if (this.state.stopOnFailure) {
              this.log('[Batch Runner] stopOnFailure enabled - stopping');
              break;
            }
            continue;
          }
        }
      } catch (imageError) {
        // DB read failure is a critical error - stop this scenario to prevent running without expected hints
        const errorMsg = `ヒント画像の読み込みに失敗しました: ${imageError instanceof Error ? imageError.message : String(imageError)}`;
        this.log(`[Batch Runner] エラー: ${errorMsg}`);

        const imageLoadFailureResult: ScenarioExecutionResult = {
          scenarioId: scenario.id,
          title: scenario.title,
          success: false,
          error: errorMsg,
          completedActions: 0,
          actionHistory: [],
        };

        // Webhook通知を送信（非同期、エラーは握りつぶす）
        sendFailureNotification(scenario.id, scenario.title, imageLoadFailureResult).catch((err) => {
          this.log(`[Batch Runner] Webhook通知の送信に失敗: ${err}`);
        });

        results.push(imageLoadFailureResult);
        failureCount++;
        if (this.state.stopOnFailure) {
          this.log('[Batch Runner] stopOnFailure enabled - stopping');
          break;
        }
        continue;
      }

      // Execute scenario
      const agentResult = await runAgentLoop({
        scenario: {
          id: scenario.id,
          title: scenario.title,
          description: scenario.description,
          status: 'pending',
        },
        hintImages,
        abortSignal: this.abortController.signal,
        onLog: this.log.bind(this),
        config: options.agentConfig,
      });

      // Convert result
      const executionResult: ScenarioExecutionResult = {
        scenarioId: scenario.id,
        title: scenario.title,
        success: agentResult.success,
        error: agentResult.error,
        completedActions: agentResult.completedActionCount ?? 0,
        failedAtAction: agentResult.failedAtAction,
        actionHistory: agentResult.executedActions.map((a) => ({
          index: a.index,
          action: a.action,
          description: a.description,
          success: a.success,
          timestamp: a.timestamp,
        })),
        lastSuccessfulAction: agentResult.lastSuccessfulAction,
      };

      results.push(executionResult);

      if (agentResult.success) {
        successCount++;
        this.log(`[Batch Runner] テストステップ成功: ${scenario.title}`);
      } else {
        failureCount++;
        this.log(
          `[Batch Runner] テストステップ失敗: ${scenario.title} - ${agentResult.error}`
        );

        // Webhook通知を送信（非同期、エラーは握りつぶす）
        sendFailureNotification(scenario.id, scenario.title, executionResult).catch((err) => {
          this.log(`[Batch Runner] Webhook通知の送信に失敗: ${err}`);
        });

        // Stop if stopOnFailure is set
        if (this.state.stopOnFailure) {
          this.log('[Batch Runner] stopOnFailure enabled - stopping');
          break;
        }
      }
    }

    this.state.isRunning = false;
    this.notifyStateChange();

    return {
      totalScenarios: orderedScenarioIds.length,
      successCount,
      failureCount,
      results,
      executedAt: new Date(),
    };
  }
}

// Singleton instance
export const scenarioRunner = new ScenarioRunner();

/**
 * Convenience function: run selected scenarios using singleton
 */
export async function runSelectedScenarios(
  orderedScenarioIds: string[],
  scenarios: StoredScenario[],
  options: ScenarioRunnerOptions = {}
): Promise<BatchExecutionResult> {
  return scenarioRunner.runSelected(orderedScenarioIds, scenarios, options);
}
