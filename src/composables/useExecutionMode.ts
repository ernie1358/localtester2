/**
 * Composable for managing execution mode setting with localStorage persistence
 *
 * Features:
 * - Loads saved value from localStorage on initialization
 * - Saves changes to localStorage (only after initialization completes)
 * - Validates that loaded values are valid options
 * - Gracefully handles localStorage unavailability
 */

import { ref, watch } from 'vue';
import {
  LOCAL_STORAGE_KEY_EXECUTION_MODE,
  DEFAULT_EXECUTION_MODE,
  EXECUTION_MODE_OPTIONS,
  type ExecutionModeValue,
} from '../constants/executionMode';

export interface UseExecutionModeOptions {
  /**
   * Custom storage implementation for testing
   */
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
}

export interface UseExecutionModeReturn {
  executionMode: ReturnType<typeof ref<ExecutionModeValue>>;
  executionModeOptions: typeof EXECUTION_MODE_OPTIONS;
  isInitialized: boolean;
}

/**
 * Creates an execution mode composable with localStorage persistence
 *
 * The composable loads the saved value from localStorage immediately,
 * but does NOT save back to localStorage during this initial load.
 * This prevents the watch from triggering a save when the ref is
 * initialized with the loaded value.
 *
 * @param options - Configuration options
 * @returns The execution mode ref and options
 */
export function useExecutionMode(
  options: UseExecutionModeOptions = {}
): UseExecutionModeReturn {
  const storage = options.storage ?? localStorage;

  // Track initialization state - start as false
  let isInitialized = false;

  // Create ref with default value
  const executionMode = ref<ExecutionModeValue>(DEFAULT_EXECUTION_MODE);

  // Load from storage
  try {
    const saved = storage.getItem(LOCAL_STORAGE_KEY_EXECUTION_MODE);
    if (saved !== null) {
      const isValidOption = EXECUTION_MODE_OPTIONS.some(
        (opt) => opt.value === saved
      );
      if (isValidOption) {
        executionMode.value = saved as ExecutionModeValue;
      }
    }
  } catch (e) {
    console.warn('Failed to load execution mode setting from localStorage:', e);
  }

  // Set up watch to save changes - but only after initialization
  // Using flush: 'sync' ensures the watch callback runs synchronously
  // when executionMode changes, so the isInitialized check works correctly
  watch(
    executionMode,
    (newValue) => {
      if (!isInitialized) return;
      try {
        storage.setItem(LOCAL_STORAGE_KEY_EXECUTION_MODE, newValue);
      } catch (e) {
        console.warn('Failed to save execution mode setting to localStorage:', e);
      }
    },
    { flush: 'sync' }
  );

  // Mark as initialized - future changes will now be saved
  isInitialized = true;

  return {
    executionMode,
    executionModeOptions: EXECUTION_MODE_OPTIONS,
    isInitialized,
  };
}
