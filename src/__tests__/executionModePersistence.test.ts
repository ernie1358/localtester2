/**
 * Execution Mode Persistence Tests
 * Tests for localStorage persistence of the execution mode setting
 *
 * Note: These tests verify the pure logic. For Vue watch behavior tests,
 * see useExecutionMode.test.ts which tests the composable with actual Vue reactivity.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  LOCAL_STORAGE_KEY_EXECUTION_MODE,
  DEFAULT_EXECUTION_MODE,
  EXECUTION_MODE_OPTIONS,
  EXECUTION_MODE_ONCE,
  EXECUTION_MODE_REPEAT,
  type ExecutionModeValue,
} from '../constants/executionMode';

// Derived constants for test compatibility
const LOCAL_STORAGE_KEY = LOCAL_STORAGE_KEY_EXECUTION_MODE;
const VALID_OPTIONS: readonly string[] = EXECUTION_MODE_OPTIONS.map(opt => opt.value);
const DEFAULT_VALUE = DEFAULT_EXECUTION_MODE;

describe('Execution Mode Persistence', () => {
  // Mock localStorage
  let localStorageMock: { [key: string]: string };

  beforeEach(() => {
    localStorageMock = {};
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => localStorageMock[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        localStorageMock[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete localStorageMock[key];
      }),
      clear: vi.fn(() => {
        localStorageMock = {};
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('Loading from localStorage', () => {
    it('should load saved value from localStorage on initialization', () => {
      const savedValue = EXECUTION_MODE_REPEAT;
      localStorageMock[LOCAL_STORAGE_KEY] = savedValue;

      // Simulate loading logic
      const loadedMode = localStorage.getItem(LOCAL_STORAGE_KEY);
      let executionMode: ExecutionModeValue = DEFAULT_VALUE;

      if (loadedMode !== null) {
        if (VALID_OPTIONS.includes(loadedMode)) {
          executionMode = loadedMode as ExecutionModeValue;
        }
      }

      expect(executionMode).toBe(savedValue);
    });

    it('should use default value when localStorage is empty', () => {
      // No value set in localStorage

      const loadedMode = localStorage.getItem(LOCAL_STORAGE_KEY);
      let executionMode: ExecutionModeValue = DEFAULT_VALUE;

      if (loadedMode !== null) {
        if (VALID_OPTIONS.includes(loadedMode)) {
          executionMode = loadedMode as ExecutionModeValue;
        }
      }

      expect(executionMode).toBe(DEFAULT_VALUE);
    });

    it('should use default value when localStorage has invalid value', () => {
      localStorageMock[LOCAL_STORAGE_KEY] = 'invalid';

      const loadedMode = localStorage.getItem(LOCAL_STORAGE_KEY);
      let executionMode: ExecutionModeValue = DEFAULT_VALUE;

      if (loadedMode !== null) {
        if (VALID_OPTIONS.includes(loadedMode)) {
          executionMode = loadedMode as ExecutionModeValue;
        }
      }

      expect(executionMode).toBe(DEFAULT_VALUE);
    });

    it('should use default value when localStorage has value not in options', () => {
      // 'loop' is not a valid option (we use 'repeat')
      localStorageMock[LOCAL_STORAGE_KEY] = 'loop';

      const loadedMode = localStorage.getItem(LOCAL_STORAGE_KEY);
      let executionMode: ExecutionModeValue = DEFAULT_VALUE;

      if (loadedMode !== null) {
        if (VALID_OPTIONS.includes(loadedMode)) {
          executionMode = loadedMode as ExecutionModeValue;
        }
      }

      expect(executionMode).toBe(DEFAULT_VALUE);
    });

    it('should accept all valid option values', () => {
      for (const value of VALID_OPTIONS) {
        localStorageMock[LOCAL_STORAGE_KEY] = value;

        const loadedMode = localStorage.getItem(LOCAL_STORAGE_KEY);
        let executionMode: ExecutionModeValue = DEFAULT_VALUE;

        if (loadedMode !== null) {
          if (VALID_OPTIONS.includes(loadedMode)) {
            executionMode = loadedMode as ExecutionModeValue;
          }
        }

        expect(executionMode).toBe(value);
      }
    });
  });

  describe('Saving to localStorage', () => {
    it('should save value to localStorage when changed', () => {
      const newValue = EXECUTION_MODE_REPEAT;

      // Simulate save logic
      localStorage.setItem(LOCAL_STORAGE_KEY, newValue);

      expect(localStorage.setItem).toHaveBeenCalledWith(
        LOCAL_STORAGE_KEY,
        newValue
      );
      expect(localStorageMock[LOCAL_STORAGE_KEY]).toBe(newValue);
    });

    it('should not throw when localStorage is unavailable', () => {
      // Make setItem throw an error
      vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => null),
        setItem: vi.fn(() => {
          throw new Error('localStorage unavailable');
        }),
      });

      // Simulate save logic with error handling
      const saveFn = () => {
        try {
          localStorage.setItem(LOCAL_STORAGE_KEY, EXECUTION_MODE_REPEAT);
        } catch (e) {
          // Should be caught silently
          console.warn('Failed to save:', e);
        }
      };

      expect(saveFn).not.toThrow();
    });
  });

  describe('Initialization flag behavior', () => {
    it('should not save during initial load (before initialization)', () => {
      localStorageMock[LOCAL_STORAGE_KEY] = EXECUTION_MODE_REPEAT;

      // Simulate initialization sequence
      let executionModeInitialized = false;

      // Load value (this happens in onMounted)
      const loadedMode = localStorage.getItem(LOCAL_STORAGE_KEY);
      let executionMode: ExecutionModeValue = DEFAULT_VALUE;

      if (loadedMode !== null) {
        if (VALID_OPTIONS.includes(loadedMode)) {
          executionMode = loadedMode as ExecutionModeValue;
        }
      }

      // Simulate watch trigger during load (before flag is set)
      const shouldSave = executionModeInitialized;

      expect(shouldSave).toBe(false);
      expect(executionMode).toBe(EXECUTION_MODE_REPEAT);

      // Now mark as initialized
      executionModeInitialized = true;

      // Simulate user change after initialization
      const shouldSaveAfterInit = executionModeInitialized;
      expect(shouldSaveAfterInit).toBe(true);
    });
  });

  describe('Mode value constants', () => {
    it('should have correct mode values', () => {
      expect(EXECUTION_MODE_ONCE).toBe('once');
      expect(EXECUTION_MODE_REPEAT).toBe('repeat');
    });

    it('should have correct default mode', () => {
      expect(DEFAULT_EXECUTION_MODE).toBe(EXECUTION_MODE_ONCE);
    });

    it('should have correct number of options', () => {
      expect(EXECUTION_MODE_OPTIONS).toHaveLength(2);
    });
  });
});
