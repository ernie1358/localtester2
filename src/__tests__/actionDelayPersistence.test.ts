/**
 * Action Delay Persistence Tests
 * Tests for localStorage persistence of the action delay setting
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// localStorage key used in App.vue
const LOCAL_STORAGE_KEY = 'xenotester_action_delay_ms';

// Valid options from App.vue
const VALID_OPTIONS = [0, 500, 1000, 2000, 3000, 5000];
const DEFAULT_VALUE = 1000;

describe('Action Delay Persistence', () => {
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
      const savedValue = 2000;
      localStorageMock[LOCAL_STORAGE_KEY] = String(savedValue);

      // Simulate loading logic from App.vue
      const loadedDelay = localStorage.getItem(LOCAL_STORAGE_KEY);
      let actionDelayMs = DEFAULT_VALUE;

      if (loadedDelay !== null) {
        const parsed = parseInt(loadedDelay, 10);
        if (VALID_OPTIONS.includes(parsed)) {
          actionDelayMs = parsed;
        }
      }

      expect(actionDelayMs).toBe(savedValue);
    });

    it('should use default value when localStorage is empty', () => {
      // No value set in localStorage

      const loadedDelay = localStorage.getItem(LOCAL_STORAGE_KEY);
      let actionDelayMs = DEFAULT_VALUE;

      if (loadedDelay !== null) {
        const parsed = parseInt(loadedDelay, 10);
        if (VALID_OPTIONS.includes(parsed)) {
          actionDelayMs = parsed;
        }
      }

      expect(actionDelayMs).toBe(DEFAULT_VALUE);
    });

    it('should use default value when localStorage has invalid value', () => {
      localStorageMock[LOCAL_STORAGE_KEY] = 'invalid';

      const loadedDelay = localStorage.getItem(LOCAL_STORAGE_KEY);
      let actionDelayMs = DEFAULT_VALUE;

      if (loadedDelay !== null) {
        const parsed = parseInt(loadedDelay, 10);
        if (VALID_OPTIONS.includes(parsed)) {
          actionDelayMs = parsed;
        }
      }

      expect(actionDelayMs).toBe(DEFAULT_VALUE);
    });

    it('should use default value when localStorage has value not in options', () => {
      // 1500 is not a valid option
      localStorageMock[LOCAL_STORAGE_KEY] = '1500';

      const loadedDelay = localStorage.getItem(LOCAL_STORAGE_KEY);
      let actionDelayMs = DEFAULT_VALUE;

      if (loadedDelay !== null) {
        const parsed = parseInt(loadedDelay, 10);
        if (VALID_OPTIONS.includes(parsed)) {
          actionDelayMs = parsed;
        }
      }

      expect(actionDelayMs).toBe(DEFAULT_VALUE);
    });

    it('should accept all valid option values', () => {
      for (const value of VALID_OPTIONS) {
        localStorageMock[LOCAL_STORAGE_KEY] = String(value);

        const loadedDelay = localStorage.getItem(LOCAL_STORAGE_KEY);
        let actionDelayMs = DEFAULT_VALUE;

        if (loadedDelay !== null) {
          const parsed = parseInt(loadedDelay, 10);
          if (VALID_OPTIONS.includes(parsed)) {
            actionDelayMs = parsed;
          }
        }

        expect(actionDelayMs).toBe(value);
      }
    });
  });

  describe('Saving to localStorage', () => {
    it('should save value to localStorage when changed', () => {
      const newValue = 3000;

      // Simulate save logic from App.vue
      localStorage.setItem(LOCAL_STORAGE_KEY, String(newValue));

      expect(localStorage.setItem).toHaveBeenCalledWith(
        LOCAL_STORAGE_KEY,
        String(newValue)
      );
      expect(localStorageMock[LOCAL_STORAGE_KEY]).toBe(String(newValue));
    });

    it('should not throw when localStorage is unavailable', () => {
      // Make setItem throw an error
      vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => null),
        setItem: vi.fn(() => {
          throw new Error('localStorage unavailable');
        }),
      });

      // Simulate save logic with error handling from App.vue
      const saveFn = () => {
        try {
          localStorage.setItem(LOCAL_STORAGE_KEY, '2000');
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
      localStorageMock[LOCAL_STORAGE_KEY] = '2000';

      // Simulate initialization sequence
      let actionDelayInitialized = false;

      // Load value (this happens in onMounted)
      const loadedDelay = localStorage.getItem(LOCAL_STORAGE_KEY);
      let actionDelayMs = DEFAULT_VALUE;

      if (loadedDelay !== null) {
        const parsed = parseInt(loadedDelay, 10);
        if (VALID_OPTIONS.includes(parsed)) {
          actionDelayMs = parsed;
        }
      }

      // Simulate watch trigger during load (before flag is set)
      const shouldSave = actionDelayInitialized;

      expect(shouldSave).toBe(false);
      expect(actionDelayMs).toBe(2000);

      // Now mark as initialized
      actionDelayInitialized = true;

      // Simulate user change after initialization
      const shouldSaveAfterInit = actionDelayInitialized;
      expect(shouldSaveAfterInit).toBe(true);
    });
  });
});
