/**
 * Execution Mode constants and options
 * Used for persisting execution mode setting to localStorage
 */

export const LOCAL_STORAGE_KEY_EXECUTION_MODE = 'xenotester_execution_mode';

export const EXECUTION_MODE_ONCE = 'once' as const;
export const EXECUTION_MODE_REPEAT = 'repeat' as const;

export const DEFAULT_EXECUTION_MODE = EXECUTION_MODE_ONCE;

export const EXECUTION_MODE_OPTIONS = [
  { value: EXECUTION_MODE_ONCE, label: '1回のみ' },
  { value: EXECUTION_MODE_REPEAT, label: '繰り返す' },
] as const;

export type ExecutionModeValue = typeof EXECUTION_MODE_ONCE | typeof EXECUTION_MODE_REPEAT;
