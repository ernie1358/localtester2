/**
 * Composable for managing action delay setting with localStorage persistence
 *
 * Features:
 * - Loads saved value from localStorage on initialization
 * - Saves changes to localStorage (only after initialization completes)
 * - Validates that loaded values are valid options
 * - Gracefully handles localStorage unavailability
 */

import { ref, watch } from 'vue';
import {
  LOCAL_STORAGE_KEY_ACTION_DELAY,
  DEFAULT_ACTION_DELAY_MS,
  ACTION_DELAY_OPTIONS,
} from '../constants/actionDelay';

export interface UseActionDelayOptions {
  /**
   * Custom storage implementation for testing
   */
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
}

export interface UseActionDelayReturn {
  actionDelayMs: ReturnType<typeof ref<number>>;
  actionDelayOptions: typeof ACTION_DELAY_OPTIONS;
  isInitialized: boolean;
}

/**
 * Creates an action delay composable with localStorage persistence
 *
 * The composable loads the saved value from localStorage immediately,
 * but does NOT save back to localStorage during this initial load.
 * This prevents the watch from triggering a save when the ref is
 * initialized with the loaded value.
 *
 * @param options - Configuration options
 * @returns The action delay ref and options
 */
export function useActionDelay(
  options: UseActionDelayOptions = {}
): UseActionDelayReturn {
  const storage = options.storage ?? localStorage;

  // Track initialization state - start as false
  let isInitialized = false;

  // Create ref with default value
  const actionDelayMs = ref<number>(DEFAULT_ACTION_DELAY_MS);

  // Load from storage
  try {
    const saved = storage.getItem(LOCAL_STORAGE_KEY_ACTION_DELAY);
    if (saved !== null) {
      const parsed = parseInt(saved, 10);
      const isValidOption = ACTION_DELAY_OPTIONS.some(
        (opt) => opt.value === parsed
      );
      if (isValidOption) {
        actionDelayMs.value = parsed;
      }
    }
  } catch (e) {
    console.warn('Failed to load action delay setting from localStorage:', e);
  }

  // Set up watch to save changes - but only after initialization
  // Using flush: 'sync' ensures the watch callback runs synchronously
  // when actionDelayMs changes, so the isInitialized check works correctly
  watch(
    actionDelayMs,
    (newValue) => {
      if (!isInitialized) return;
      try {
        storage.setItem(LOCAL_STORAGE_KEY_ACTION_DELAY, String(newValue));
      } catch (e) {
        console.warn('Failed to save action delay setting to localStorage:', e);
      }
    },
    { flush: 'sync' }
  );

  // Mark as initialized - future changes will now be saved
  isInitialized = true;

  return {
    actionDelayMs,
    actionDelayOptions: ACTION_DELAY_OPTIONS,
    isInitialized,
  };
}
