/**
 * Database type definitions for scenario management
 */

/** Executed action record for tracking action history */
export interface ExecutedAction {
  index: number;
  action: string;
  description: string;
  success: boolean;
  timestamp: Date;
}

/** Stored scenario in SQLite database */
export interface StoredScenario {
  id: string;
  title: string;
  description: string;
  order_index: number;
  created_at: string;
  updated_at: string;
}

/** Result of a single scenario execution */
export interface ScenarioExecutionResult {
  scenarioId: string;
  title: string;
  success: boolean;
  error?: string;
  /** Number of completed actions */
  completedActions: number;
  /** Total number of actions (if known) */
  totalActions?: number;
  /** Description of the failed action */
  failedAtAction?: string;
  /** Executed action history */
  actionHistory: ExecutedAction[];
  /** Last successfully completed action */
  lastSuccessfulAction?: string;
}

/** Result of batch scenario execution */
export interface BatchExecutionResult {
  totalScenarios: number;
  successCount: number;
  failureCount: number;
  results: ScenarioExecutionResult[];
  executedAt: Date;
}
