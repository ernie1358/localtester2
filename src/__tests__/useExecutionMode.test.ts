/**
 * useExecutionMode Composable Tests
 *
 * Tests for the execution mode composable, including:
 * - Loading from localStorage
 * - Saving to localStorage on change
 * - NOT saving during initial load (critical bug prevention)
 * - Handling invalid/unavailable localStorage
 */

import { describe, it, expect, vi } from 'vitest';
import { useExecutionMode } from '../composables/useExecutionMode';
import {
  LOCAL_STORAGE_KEY_EXECUTION_MODE,
  DEFAULT_EXECUTION_MODE,
  EXECUTION_MODE_OPTIONS,
  EXECUTION_MODE_ONCE,
  EXECUTION_MODE_REPEAT,
} from '../constants/executionMode';

describe('useExecutionMode', () => {
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
        [LOCAL_STORAGE_KEY_EXECUTION_MODE]: EXECUTION_MODE_REPEAT,
      });

      const { executionMode } = useExecutionMode({ storage });

      expect(storage.getItem).toHaveBeenCalledWith(LOCAL_STORAGE_KEY_EXECUTION_MODE);
      expect(executionMode.value).toBe(EXECUTION_MODE_REPEAT);
    });

    it('should use default value when localStorage is empty', () => {
      const storage = createMockStorage();

      const { executionMode } = useExecutionMode({ storage });

      expect(executionMode.value).toBe(DEFAULT_EXECUTION_MODE);
    });

    it('should use default value when localStorage has invalid value', () => {
      const storage = createMockStorage({
        [LOCAL_STORAGE_KEY_EXECUTION_MODE]: 'invalid',
      });

      const { executionMode } = useExecutionMode({ storage });

      expect(executionMode.value).toBe(DEFAULT_EXECUTION_MODE);
    });

    it('should use default value when localStorage has value not in options', () => {
      // 'unknown' is not a valid option
      const storage = createMockStorage({
        [LOCAL_STORAGE_KEY_EXECUTION_MODE]: 'unknown',
      });

      const { executionMode } = useExecutionMode({ storage });

      expect(executionMode.value).toBe(DEFAULT_EXECUTION_MODE);
    });

    it('should accept all valid option values', () => {
      for (const option of EXECUTION_MODE_OPTIONS) {
        const storage = createMockStorage({
          [LOCAL_STORAGE_KEY_EXECUTION_MODE]: option.value,
        });

        const { executionMode } = useExecutionMode({ storage });

        expect(executionMode.value).toBe(option.value);
      }
    });

    it('should load "once" mode correctly', () => {
      const storage = createMockStorage({
        [LOCAL_STORAGE_KEY_EXECUTION_MODE]: EXECUTION_MODE_ONCE,
      });

      const { executionMode } = useExecutionMode({ storage });

      expect(executionMode.value).toBe(EXECUTION_MODE_ONCE);
    });

    it('should load "repeat" mode correctly', () => {
      const storage = createMockStorage({
        [LOCAL_STORAGE_KEY_EXECUTION_MODE]: EXECUTION_MODE_REPEAT,
      });

      const { executionMode } = useExecutionMode({ storage });

      expect(executionMode.value).toBe(EXECUTION_MODE_REPEAT);
    });
  });

  describe('Saving to localStorage', () => {
    it('should save value to localStorage when changed after initialization', () => {
      const storage = createMockStorage();

      const { executionMode } = useExecutionMode({ storage });

      // Change value after initialization
      executionMode.value = EXECUTION_MODE_REPEAT;

      expect(storage.setItem).toHaveBeenCalledWith(
        LOCAL_STORAGE_KEY_EXECUTION_MODE,
        EXECUTION_MODE_REPEAT
      );
    });

    it('should handle multiple value changes', () => {
      const storage = createMockStorage();

      const { executionMode } = useExecutionMode({ storage });

      executionMode.value = EXECUTION_MODE_REPEAT;
      executionMode.value = EXECUTION_MODE_ONCE;
      executionMode.value = EXECUTION_MODE_REPEAT;

      expect(storage.setItem).toHaveBeenCalledTimes(3);
      expect(storage.setItem).toHaveBeenLastCalledWith(
        LOCAL_STORAGE_KEY_EXECUTION_MODE,
        EXECUTION_MODE_REPEAT
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
        [LOCAL_STORAGE_KEY_EXECUTION_MODE]: EXECUTION_MODE_REPEAT,
      });

      // Initialize the composable - this should load the value but NOT save it back
      const { executionMode } = useExecutionMode({ storage });

      // Verify value was loaded
      expect(executionMode.value).toBe(EXECUTION_MODE_REPEAT);

      // Verify setItem was NOT called during initialization
      expect(storage.setItem).not.toHaveBeenCalled();
    });

    it('should NOT save to localStorage during initial load with default value', () => {
      const storage = createMockStorage();

      // Initialize with default value
      const { executionMode } = useExecutionMode({ storage });

      expect(executionMode.value).toBe(DEFAULT_EXECUTION_MODE);

      // Verify setItem was NOT called during initialization
      expect(storage.setItem).not.toHaveBeenCalled();
    });

    it('should save to localStorage ONLY after user interaction (value change)', () => {
      const storage = createMockStorage({
        [LOCAL_STORAGE_KEY_EXECUTION_MODE]: EXECUTION_MODE_ONCE,
      });

      const { executionMode } = useExecutionMode({ storage });

      // Verify no save during init
      expect(storage.setItem).not.toHaveBeenCalled();

      // Simulate user changing the value
      executionMode.value = EXECUTION_MODE_REPEAT;

      // Now setItem should be called exactly once
      expect(storage.setItem).toHaveBeenCalledTimes(1);
      expect(storage.setItem).toHaveBeenCalledWith(
        LOCAL_STORAGE_KEY_EXECUTION_MODE,
        EXECUTION_MODE_REPEAT
      );
    });

    it('should correctly track initialization state', () => {
      const storage = createMockStorage();

      const result = useExecutionMode({ storage });

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
      const { executionMode } = useExecutionMode({ storage });

      // Should use default value
      expect(executionMode.value).toBe(DEFAULT_EXECUTION_MODE);
    });

    it('should handle setItem throwing an error', () => {
      const storage = {
        getItem: vi.fn(() => null),
        setItem: vi.fn(() => {
          throw new Error('Storage full');
        }),
      };

      const { executionMode } = useExecutionMode({ storage });

      // Should not throw when saving
      expect(() => {
        executionMode.value = EXECUTION_MODE_REPEAT;
      }).not.toThrow();
    });
  });

  describe('Options export', () => {
    it('should export executionModeOptions', () => {
      const storage = createMockStorage();

      const { executionModeOptions } = useExecutionMode({ storage });

      expect(executionModeOptions).toBe(EXECUTION_MODE_OPTIONS);
      expect(executionModeOptions).toHaveLength(2);
    });

    it('should have correct labels for options', () => {
      const storage = createMockStorage();

      const { executionModeOptions } = useExecutionMode({ storage });

      expect(executionModeOptions[0].label).toBe('1回のみ実行');
      expect(executionModeOptions[1].label).toBe('停止するまで繰り返す');
    });
  });
});
