/**
 * useActionDelay Composable Tests
 *
 * Tests for the action delay composable, including:
 * - Loading from localStorage
 * - Saving to localStorage on change
 * - NOT saving during initial load (critical bug prevention)
 * - Handling invalid/unavailable localStorage
 */

import { describe, it, expect, vi } from 'vitest';
import { useActionDelay } from '../composables/useActionDelay';
import {
  LOCAL_STORAGE_KEY_ACTION_DELAY,
  DEFAULT_ACTION_DELAY_MS,
  ACTION_DELAY_OPTIONS,
} from '../constants/actionDelay';

describe('useActionDelay', () => {
  // Create a mock storage that tracks all operations
  function createMockStorage(initialData: Record<string, string> = {}) {
    const data = { ...initialData };
    return {
      getItem: vi.fn((key: string) => data[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        data[key] = value;
      }),
      getData: () => ({ ...data }),
    };
  }

  describe('Loading from localStorage', () => {
    it('should load saved value from localStorage on initialization', () => {
      const storage = createMockStorage({
        [LOCAL_STORAGE_KEY_ACTION_DELAY]: '2000',
      });

      const { actionDelayMs } = useActionDelay({ storage });

      expect(storage.getItem).toHaveBeenCalledWith(LOCAL_STORAGE_KEY_ACTION_DELAY);
      expect(actionDelayMs.value).toBe(2000);
    });

    it('should use default value when localStorage is empty', () => {
      const storage = createMockStorage();

      const { actionDelayMs } = useActionDelay({ storage });

      expect(actionDelayMs.value).toBe(DEFAULT_ACTION_DELAY_MS);
    });

    it('should use default value when localStorage has invalid value', () => {
      const storage = createMockStorage({
        [LOCAL_STORAGE_KEY_ACTION_DELAY]: 'invalid',
      });

      const { actionDelayMs } = useActionDelay({ storage });

      expect(actionDelayMs.value).toBe(DEFAULT_ACTION_DELAY_MS);
    });

    it('should use default value when localStorage has value not in options', () => {
      // 1500 is not a valid option
      const storage = createMockStorage({
        [LOCAL_STORAGE_KEY_ACTION_DELAY]: '1500',
      });

      const { actionDelayMs } = useActionDelay({ storage });

      expect(actionDelayMs.value).toBe(DEFAULT_ACTION_DELAY_MS);
    });

    it('should accept all valid option values', () => {
      for (const option of ACTION_DELAY_OPTIONS) {
        const storage = createMockStorage({
          [LOCAL_STORAGE_KEY_ACTION_DELAY]: String(option.value),
        });

        const { actionDelayMs } = useActionDelay({ storage });

        expect(actionDelayMs.value).toBe(option.value);
      }
    });
  });

  describe('Saving to localStorage', () => {
    it('should save value to localStorage when changed after initialization', () => {
      const storage = createMockStorage();

      const { actionDelayMs } = useActionDelay({ storage });

      // Change value after initialization
      actionDelayMs.value = 3000;

      expect(storage.setItem).toHaveBeenCalledWith(
        LOCAL_STORAGE_KEY_ACTION_DELAY,
        '3000'
      );
    });

    it('should handle multiple value changes', () => {
      const storage = createMockStorage();

      const { actionDelayMs } = useActionDelay({ storage });

      actionDelayMs.value = 500;
      actionDelayMs.value = 2000;
      actionDelayMs.value = 5000;

      expect(storage.setItem).toHaveBeenCalledTimes(3);
      expect(storage.setItem).toHaveBeenLastCalledWith(
        LOCAL_STORAGE_KEY_ACTION_DELAY,
        '5000'
      );
    });
  });

  describe('Initial load protection (CRITICAL)', () => {
    /**
     * This test verifies the critical behavior that prevents the bug where
     * loading a saved value would immediately write it back to localStorage.
     *
     * The issue was that Vue's watch would trigger when the ref value was
     * set during initialization, causing an unnecessary (and potentially
     * problematic) write back to localStorage.
     */
    it('should NOT save to localStorage during initial load when loading saved value', () => {
      const storage = createMockStorage({
        [LOCAL_STORAGE_KEY_ACTION_DELAY]: '2000',
      });

      // Initialize the composable - this should load the value but NOT save it back
      const { actionDelayMs } = useActionDelay({ storage });

      // Verify value was loaded
      expect(actionDelayMs.value).toBe(2000);

      // Verify setItem was NOT called during initialization
      expect(storage.setItem).not.toHaveBeenCalled();
    });

    it('should NOT save to localStorage during initial load with default value', () => {
      const storage = createMockStorage();

      // Initialize with default value
      const { actionDelayMs } = useActionDelay({ storage });

      expect(actionDelayMs.value).toBe(DEFAULT_ACTION_DELAY_MS);

      // Verify setItem was NOT called during initialization
      expect(storage.setItem).not.toHaveBeenCalled();
    });

    it('should save to localStorage ONLY after user interaction (value change)', () => {
      const storage = createMockStorage({
        [LOCAL_STORAGE_KEY_ACTION_DELAY]: '2000',
      });

      const { actionDelayMs } = useActionDelay({ storage });

      // Verify no save during init
      expect(storage.setItem).not.toHaveBeenCalled();

      // Simulate user changing the value
      actionDelayMs.value = 3000;

      // Now setItem should be called exactly once
      expect(storage.setItem).toHaveBeenCalledTimes(1);
      expect(storage.setItem).toHaveBeenCalledWith(
        LOCAL_STORAGE_KEY_ACTION_DELAY,
        '3000'
      );
    });

    it('should correctly track initialization state', () => {
      const storage = createMockStorage();

      const result = useActionDelay({ storage });

      // isInitialized should be true after composable returns
      expect(result.isInitialized).toBe(true);
    });
  });

  describe('Error handling', () => {
    it('should handle getItem throwing an error', () => {
      const storage = {
        getItem: vi.fn(() => {
          throw new Error('Storage unavailable');
        }),
        setItem: vi.fn(),
      };

      // Should not throw
      const { actionDelayMs } = useActionDelay({ storage });

      // Should use default value
      expect(actionDelayMs.value).toBe(DEFAULT_ACTION_DELAY_MS);
    });

    it('should handle setItem throwing an error', () => {
      const storage = {
        getItem: vi.fn(() => null),
        setItem: vi.fn(() => {
          throw new Error('Storage full');
        }),
      };

      const { actionDelayMs } = useActionDelay({ storage });

      // Should not throw when saving
      expect(() => {
        actionDelayMs.value = 3000;
      }).not.toThrow();
    });
  });

  describe('Options export', () => {
    it('should export actionDelayOptions', () => {
      const storage = createMockStorage();

      const { actionDelayOptions } = useActionDelay({ storage });

      expect(actionDelayOptions).toBe(ACTION_DELAY_OPTIONS);
      expect(actionDelayOptions).toHaveLength(6);
    });
  });
});
