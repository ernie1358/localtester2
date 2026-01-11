/**
 * Scenario type definitions
 */

import type { TestResult, ExpectedAction, TestResultStatus } from './testResult';

/** Status of a scenario execution */
export type ScenarioStatus =
  | 'pending'      // Waiting to be executed
  | 'running'      // Currently executing
  | 'completed'    // Successfully completed
  | 'failed'       // Failed (loop detection, error, etc.)
  | 'stopped'      // Stopped by user
  | 'skipped';     // Skipped (e.g., previous scenario failed)

/** A test scenario parsed from user input */
export interface Scenario {
  id: string;
  title: string;
  description: string;
  status: ScenarioStatus;
  /** Order index for sorting (optional for runtime scenarios) */
  orderIndex?: number;
  error?: string;
  iterations?: number;
  startedAt?: Date;
  completedAt?: Date;
  /** Detailed test result */
  result?: TestResult;
  /** Expected actions extracted from scenario description */
  expectedActions?: ExpectedAction[];
}

/**
 * Map TestResultStatus to ScenarioStatus
 * - success → completed
 * - stopped → stopped (preserve user stop)
 * - failure/timeout/error/others → failed
 */
export function mapTestResultStatusToScenarioStatus(
  testResultStatus: TestResultStatus
): ScenarioStatus {
  switch (testResultStatus) {
    case 'success':
      return 'completed';
    case 'stopped':
      return 'stopped';
    case 'failure':
    case 'timeout':
    case 'error':
    default:
      return 'failed';
  }
}

/** Result of scenario parsing */
export interface ScenarioSplitResult {
  scenarios: Array<{
    id: string;
    title: string;
    description: string;
  }>;
  analysis: {
    total_count: number;
    is_single: boolean;
  };
}

/** State of the scenario runner */
export interface ScenarioRunnerState {
  scenarios: Scenario[];
  currentIndex: number;
  isRunning: boolean;
  stopOnFailure: boolean;
}
