/**
 * Stop Button State Tests
 * Tests for stop button UI behavior during execution and stopping states.
 *
 * These tests verify:
 * 1. Button state transitions (execute → stopping → execute)
 * 2. Button disabled state during stopping
 * 3. Button label changes (停止 → 停止中...)
 * 4. Emergency stop event handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ref, nextTick } from 'vue';

// Mock the Tauri event API
const mockListeners = new Map<string, (event: { payload: unknown }) => void>();
const mockListen = vi.fn((eventName: string, handler: (event: { payload: unknown }) => void) => {
  mockListeners.set(eventName, handler);
  // Return an unlisten function
  return Promise.resolve(() => {
    mockListeners.delete(eventName);
  });
});

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen,
}));

// Helper to simulate emitting an event
function emitEvent(eventName: string, payload: unknown = undefined) {
  const handler = mockListeners.get(eventName);
  if (handler) {
    handler({ payload });
  }
}

describe('Stop Button State Management', () => {
  // Simulate the reactive state from App.vue
  let isRunning: { value: boolean };
  let isStopping: { value: boolean };
  let logs: { value: string[] };

  // Simulate the stopExecution function from App.vue
  function stopExecution() {
    if (isStopping.value) return;
    isStopping.value = true;
    logs.value.push('停止処理を開始しています...');
  }

  // Simulate the computed canExecute from App.vue
  function canExecute(selectedCount: number, apiKeyConfigured: boolean) {
    return selectedCount > 0 && !isRunning.value && !isStopping.value && apiKeyConfigured;
  }

  // Simulate button disabled state
  function isStopButtonDisabled() {
    return isStopping.value;
  }

  // Simulate button label
  function getStopButtonLabel() {
    return isStopping.value ? '停止中...' : '停止 (Shift+Esc)';
  }

  beforeEach(() => {
    isRunning = ref(false);
    isStopping = ref(false);
    logs = ref<string[]>([]);
    mockListeners.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockListeners.clear();
  });

  describe('Initial State', () => {
    it('should not be in stopping state initially', () => {
      expect(isStopping.value).toBe(false);
    });

    it('should show normal stop button label when not stopping', () => {
      isRunning.value = true;
      expect(getStopButtonLabel()).toBe('停止 (Shift+Esc)');
    });

    it('should have stop button enabled when running', () => {
      isRunning.value = true;
      expect(isStopButtonDisabled()).toBe(false);
    });
  });

  describe('Stop Button Click', () => {
    it('should immediately set isStopping to true when clicked', () => {
      isRunning.value = true;

      stopExecution();

      expect(isStopping.value).toBe(true);
    });

    it('should add log message when stop is initiated', () => {
      isRunning.value = true;

      stopExecution();

      expect(logs.value).toContain('停止処理を開始しています...');
    });

    it('should disable the button when stopping', () => {
      isRunning.value = true;

      stopExecution();

      expect(isStopButtonDisabled()).toBe(true);
    });

    it('should change button label to "停止中..." when stopping', () => {
      isRunning.value = true;

      stopExecution();

      expect(getStopButtonLabel()).toBe('停止中...');
    });

    it('should prevent double-click when already stopping', () => {
      isRunning.value = true;

      stopExecution();
      const logCountAfterFirstClick = logs.value.length;

      stopExecution(); // Second click

      // Should not add another log
      expect(logs.value.length).toBe(logCountAfterFirstClick);
    });
  });

  describe('Execute Button Disabled During Stopping', () => {
    it('should disable execute button when isStopping is true', () => {
      isRunning.value = false;
      isStopping.value = true;

      expect(canExecute(1, true)).toBe(false);
    });

    it('should disable execute button when both isRunning and isStopping are true', () => {
      isRunning.value = true;
      isStopping.value = true;

      expect(canExecute(1, true)).toBe(false);
    });

    it('should enable execute button when nothing is running or stopping', () => {
      isRunning.value = false;
      isStopping.value = false;

      expect(canExecute(1, true)).toBe(true);
    });
  });

  describe('Emergency Stop Event', () => {
    it('should set isStopping when emergency-stop event is received during execution', async () => {
      // Set up the listener as App.vue does
      await mockListen('emergency-stop', () => {
        if (isRunning.value && !isStopping.value) {
          isStopping.value = true;
          logs.value.push('緊急停止が発動しました...');
        }
      });

      isRunning.value = true;

      emitEvent('emergency-stop');
      await nextTick();

      expect(isStopping.value).toBe(true);
    });

    it('should add emergency stop log when event is received', async () => {
      await mockListen('emergency-stop', () => {
        if (isRunning.value && !isStopping.value) {
          isStopping.value = true;
          logs.value.push('緊急停止が発動しました...');
        }
      });

      isRunning.value = true;

      emitEvent('emergency-stop');
      await nextTick();

      expect(logs.value).toContain('緊急停止が発動しました...');
    });

    it('should not set isStopping when not running', async () => {
      await mockListen('emergency-stop', () => {
        if (isRunning.value && !isStopping.value) {
          isStopping.value = true;
          logs.value.push('緊急停止が発動しました...');
        }
      });

      isRunning.value = false;

      emitEvent('emergency-stop');
      await nextTick();

      expect(isStopping.value).toBe(false);
    });

    it('should not trigger twice if already stopping', async () => {
      await mockListen('emergency-stop', () => {
        if (isRunning.value && !isStopping.value) {
          isStopping.value = true;
          logs.value.push('緊急停止が発動しました...');
        }
      });

      isRunning.value = true;
      isStopping.value = true; // Already stopping

      emitEvent('emergency-stop');
      await nextTick();

      // Should not add the log since already stopping
      expect(logs.value).not.toContain('緊急停止が発動しました...');
    });
  });

  describe('State Reset After Execution', () => {
    it('should reset isStopping after execution completes', () => {
      isRunning.value = true;
      isStopping.value = true;

      // Simulate execution completion (as in executeSelected's finally block)
      isRunning.value = false;
      if (isStopping.value) {
        isStopping.value = false;
        logs.value.push('停止処理が完了しました');
      }

      expect(isStopping.value).toBe(false);
    });

    it('should add completion log when stopping is finished', () => {
      isRunning.value = true;
      isStopping.value = true;

      // Simulate execution completion
      isRunning.value = false;
      if (isStopping.value) {
        isStopping.value = false;
        logs.value.push('停止処理が完了しました');
      }

      expect(logs.value).toContain('停止処理が完了しました');
    });

    it('should return button to normal state after completion', () => {
      isRunning.value = true;
      isStopping.value = true;

      // Simulate execution completion
      isRunning.value = false;
      isStopping.value = false;

      expect(isStopButtonDisabled()).toBe(false);
      expect(getStopButtonLabel()).toBe('停止 (Shift+Esc)');
    });
  });

  describe('Button Visibility', () => {
    // Simulates the v-if logic in App.vue
    function showExecuteButton() {
      return !isRunning.value && !isStopping.value;
    }

    function showStopButton() {
      return isRunning.value || isStopping.value;
    }

    it('should show execute button when not running and not stopping', () => {
      isRunning.value = false;
      isStopping.value = false;

      expect(showExecuteButton()).toBe(true);
      expect(showStopButton()).toBe(false);
    });

    it('should show stop button when running', () => {
      isRunning.value = true;
      isStopping.value = false;

      expect(showExecuteButton()).toBe(false);
      expect(showStopButton()).toBe(true);
    });

    it('should show stop button (disabled) when stopping', () => {
      isRunning.value = true;
      isStopping.value = true;

      expect(showExecuteButton()).toBe(false);
      expect(showStopButton()).toBe(true);
    });

    it('should show stop button during stopping transition even if isRunning becomes false', () => {
      // This can happen briefly during the stop process
      isRunning.value = false;
      isStopping.value = true;

      // Should still show stop button since we're in stopping state
      expect(showStopButton()).toBe(true);
    });
  });
});
