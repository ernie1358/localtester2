/**
 * Scenario Runner - Orchestrate multiple scenario executions
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { runAgentLoop, type AgentLoopResult } from './agentLoop';
import type { Scenario, ScenarioRunnerState, AgentLoopConfig } from '../types';
import { mapTestResultStatusToScenarioStatus } from '../types';

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
      const result: AgentLoopResult = await runAgentLoop({
        scenario,
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
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        scenario.status = 'stopped';
      } else {
        scenario.status = 'failed';
        scenario.error = error instanceof Error ? error.message : String(error);
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
}

// Singleton instance
export const scenarioRunner = new ScenarioRunner();
