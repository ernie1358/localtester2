/**
 * Scenario type definitions
 */

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
  id: number;
  title: string;
  description: string;
  status: ScenarioStatus;
  error?: string;
  iterations?: number;
  startedAt?: Date;
  completedAt?: Date;
}

/** Result of scenario parsing */
export interface ScenarioSplitResult {
  scenarios: Array<{
    id: number;
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
