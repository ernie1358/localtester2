/**
 * Database type definitions for scenario management
 */

/**
 * Executed action record for tracking action history
 * Note: timestamp is Date in memory but becomes string when serialized via Tauri events
 */
export interface ExecutedAction {
  index: number;
  action: string;
  description: string;
  success: boolean;
  /** Date object in memory, ISO string when serialized */
  timestamp: Date | string;
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

/** Step image hint attached to a test step */
export interface StepImage {
  id: string;
  scenario_id: string;
  image_data: string; // Raw Base64 (without data: prefix)
  file_name: string;
  mime_type: string;
  order_index: number;
  created_at: string;
}

/** Form image data for handling new/existing images */
export interface FormImageData {
  /** Existing image ID (undefined for new images) */
  existingId?: string;
  /** Raw Base64 data (without data: prefix) */
  base64: string;
  fileName: string;
  mimeType: string;
  /** Deletion flag for existing images during edit */
  markedForDeletion?: boolean;
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

/**
 * Result of batch scenario execution
 * Note: executedAt is Date in memory but becomes string when serialized via Tauri events
 */
export interface BatchExecutionResult {
  totalScenarios: number;
  successCount: number;
  failureCount: number;
  results: ScenarioExecutionResult[];
  /** Date object in memory, ISO string when serialized */
  executedAt: Date | string;
}

/**
 * Convert a Date or string to Date object
 * Useful for handling serialized dates from Tauri events
 */
export function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
