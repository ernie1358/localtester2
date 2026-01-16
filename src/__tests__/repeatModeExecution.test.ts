/**
 * Repeat Mode Execution Tests
 *
 * Tests for repeat mode loop behavior in scenario execution.
 * This tests the loop logic pattern used in App.vue's executeSelected function.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ref } from 'vue';
import {
  EXECUTION_MODE_ONCE,
  EXECUTION_MODE_REPEAT,
} from '../constants/executionMode';

// Mock Tauri API
const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));

/**
 * Simulates the repeat mode loop logic from App.vue's executeSelected function.
 * This is extracted for testability.
 */
async function executeWithRepeatMode(options: {
  executionMode: typeof EXECUTION_MODE_ONCE | typeof EXECUTION_MODE_REPEAT;
  isStoppingRef: { value: boolean };
  onLoop: (loopCount: number) => Promise<void>;
  checkStopRequested: () => Promise<boolean>;
}): Promise<{ loopCount: number; stoppedReason?: string }> {
  const { executionMode, isStoppingRef, onLoop, checkStopRequested } = options;
  const shouldRepeat = executionMode === EXECUTION_MODE_REPEAT;
  let loopCount = 0;

  do {
    // Check for stop request before starting next loop (effective from 2nd loop onwards)
    if (loopCount > 0) {
      if (isStoppingRef.value) {
        return { loopCount, stoppedReason: 'isStopping' };
      }
      const stopRequested = await checkStopRequested();
      if (stopRequested) {
        return { loopCount, stoppedReason: 'stopRequested' };
      }
    }

    loopCount++;
    await onLoop(loopCount);

    // Check for stop request after loop completion
    if (isStoppingRef.value) {
      return { loopCount, stoppedReason: 'isStopping' };
    }
  } while (shouldRepeat);

  return { loopCount };
}

describe('Repeat Mode Execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('Once mode (single execution)', () => {
    it('should execute exactly once when mode is "once"', async () => {
      const loopExecutions: number[] = [];
      const isStopping = ref(false);

      const result = await executeWithRepeatMode({
        executionMode: EXECUTION_MODE_ONCE,
        isStoppingRef: isStopping,
        onLoop: async (count) => {
          loopExecutions.push(count);
        },
        checkStopRequested: async () => false,
      });

      expect(result.loopCount).toBe(1);
      expect(loopExecutions).toEqual([1]);
      expect(result.stoppedReason).toBeUndefined();
    });

    it('should not continue loop even if checkStopRequested returns false', async () => {
      const loopExecutions: number[] = [];
      const isStopping = ref(false);

      const result = await executeWithRepeatMode({
        executionMode: EXECUTION_MODE_ONCE,
        isStoppingRef: isStopping,
        onLoop: async (count) => {
          loopExecutions.push(count);
        },
        checkStopRequested: async () => false,
      });

      expect(result.loopCount).toBe(1);
      expect(loopExecutions.length).toBe(1);
    });
  });

  describe('Repeat mode (continuous execution)', () => {
    it('should continue looping until stop is requested via isStopping', async () => {
      const loopExecutions: number[] = [];
      const isStopping = ref(false);

      const result = await executeWithRepeatMode({
        executionMode: EXECUTION_MODE_REPEAT,
        isStoppingRef: isStopping,
        onLoop: async (count) => {
          loopExecutions.push(count);
          // Stop after 3 loops
          if (count >= 3) {
            isStopping.value = true;
          }
        },
        checkStopRequested: async () => false,
      });

      expect(result.loopCount).toBe(3);
      expect(loopExecutions).toEqual([1, 2, 3]);
      expect(result.stoppedReason).toBe('isStopping');
    });

    it('should stop before starting next loop when isStopping becomes true', async () => {
      const loopExecutions: number[] = [];
      const isStopping = ref(false);

      const result = await executeWithRepeatMode({
        executionMode: EXECUTION_MODE_REPEAT,
        isStoppingRef: isStopping,
        onLoop: async (count) => {
          loopExecutions.push(count);
          // After first loop completes, set isStopping (but don't return yet)
          // This simulates user pressing stop during execution
        },
        checkStopRequested: async () => {
          // Simulate stop request from Rust side after 2 loops
          return loopExecutions.length >= 2;
        },
      });

      // Should stop before loop 3 due to checkStopRequested
      expect(result.loopCount).toBe(2);
      expect(loopExecutions).toEqual([1, 2]);
      expect(result.stoppedReason).toBe('stopRequested');
    });

    it('should check stop request from Rust backend between loops', async () => {
      const loopExecutions: number[] = [];
      const isStopping = ref(false);
      let checkCount = 0;

      const result = await executeWithRepeatMode({
        executionMode: EXECUTION_MODE_REPEAT,
        isStoppingRef: isStopping,
        onLoop: async (count) => {
          loopExecutions.push(count);
        },
        checkStopRequested: async () => {
          checkCount++;
          // Stop after checking twice (before loop 3)
          return checkCount >= 2;
        },
      });

      // checkStopRequested is called before loop 2 and loop 3
      // It returns true on second call (before loop 3), so only 2 loops execute
      expect(result.loopCount).toBe(2);
      expect(loopExecutions).toEqual([1, 2]);
    });

    it('should not check stop request before first loop', async () => {
      let checkCalled = false;
      const isStopping = ref(false);

      await executeWithRepeatMode({
        executionMode: EXECUTION_MODE_REPEAT,
        isStoppingRef: isStopping,
        onLoop: async () => {
          // Stop immediately after first loop
          isStopping.value = true;
        },
        checkStopRequested: async () => {
          checkCalled = true;
          return false;
        },
      });

      // checkStopRequested should not be called before first loop
      // It would only be called if we tried to start loop 2
      // But we stop after loop 1 due to isStopping
      expect(checkCalled).toBe(false);
    });
  });

  describe('Stop request handling', () => {
    it('should prioritize isStopping check over checkStopRequested', async () => {
      const loopExecutions: number[] = [];
      const isStopping = ref(false);

      const result = await executeWithRepeatMode({
        executionMode: EXECUTION_MODE_REPEAT,
        isStoppingRef: isStopping,
        onLoop: async (count) => {
          loopExecutions.push(count);
        },
        checkStopRequested: async () => {
          // Set isStopping before this returns
          isStopping.value = true;
          return false; // This would allow continuing, but isStopping is already true
        },
      });

      // First loop executes, then isStopping is set before loop 2 can start
      // isStopping is checked first, so stoppedReason should be 'isStopping'
      expect(result.stoppedReason).toBe('isStopping');
    });

    it('should handle async stop request correctly', async () => {
      const loopExecutions: number[] = [];
      const isStopping = ref(false);

      const result = await executeWithRepeatMode({
        executionMode: EXECUTION_MODE_REPEAT,
        isStoppingRef: isStopping,
        onLoop: async (count) => {
          loopExecutions.push(count);
          // Simulate async operation
          await new Promise((resolve) => setTimeout(resolve, 1));
        },
        checkStopRequested: async () => {
          // Simulate async check
          await new Promise((resolve) => setTimeout(resolve, 1));
          return loopExecutions.length >= 2;
        },
      });

      expect(result.loopCount).toBe(2);
      expect(loopExecutions).toEqual([1, 2]);
    });
  });

  describe('Emergency stop integration', () => {
    it('should stop when isStopping is set during loop execution', async () => {
      const loopExecutions: number[] = [];
      const isStopping = ref(false);

      const result = await executeWithRepeatMode({
        executionMode: EXECUTION_MODE_REPEAT,
        isStoppingRef: isStopping,
        onLoop: async (count) => {
          loopExecutions.push(count);
          // Simulate emergency stop triggered during execution
          if (count === 2) {
            isStopping.value = true;
          }
        },
        checkStopRequested: async () => false,
      });

      expect(result.loopCount).toBe(2);
      expect(loopExecutions).toEqual([1, 2]);
      expect(result.stoppedReason).toBe('isStopping');
    });
  });

  describe('Loop counter', () => {
    it('should correctly track loop count in repeat mode', async () => {
      const loopCounts: number[] = [];
      const isStopping = ref(false);

      await executeWithRepeatMode({
        executionMode: EXECUTION_MODE_REPEAT,
        isStoppingRef: isStopping,
        onLoop: async (count) => {
          loopCounts.push(count);
          if (count >= 5) {
            isStopping.value = true;
          }
        },
        checkStopRequested: async () => false,
      });

      expect(loopCounts).toEqual([1, 2, 3, 4, 5]);
    });

    it('should return final loop count when stopped', async () => {
      const isStopping = ref(false);

      const result = await executeWithRepeatMode({
        executionMode: EXECUTION_MODE_REPEAT,
        isStoppingRef: isStopping,
        onLoop: async (count) => {
          if (count >= 10) {
            isStopping.value = true;
          }
        },
        checkStopRequested: async () => false,
      });

      expect(result.loopCount).toBe(10);
    });
  });
});

describe('Log trimming', () => {
  const MAX_LOG_ENTRIES = 500;

  function addLogWithTrim(logs: string[], message: string): string[] {
    logs.push(message);
    if (logs.length > MAX_LOG_ENTRIES) {
      return logs.slice(-MAX_LOG_ENTRIES);
    }
    return logs;
  }

  it('should not trim logs when under limit', () => {
    let logs: string[] = [];
    for (let i = 0; i < 100; i++) {
      logs = addLogWithTrim(logs, `Log ${i}`);
    }
    expect(logs.length).toBe(100);
    expect(logs[0]).toBe('Log 0');
  });

  it('should trim old logs when exceeding limit', () => {
    let logs: string[] = [];
    for (let i = 0; i < 600; i++) {
      logs = addLogWithTrim(logs, `Log ${i}`);
    }
    expect(logs.length).toBe(MAX_LOG_ENTRIES);
    // First log should be "Log 100" (600 - 500 = 100)
    expect(logs[0]).toBe('Log 100');
    // Last log should be "Log 599"
    expect(logs[logs.length - 1]).toBe('Log 599');
  });

  it('should keep most recent logs after trimming', () => {
    let logs: string[] = [];
    for (let i = 0; i < 505; i++) {
      logs = addLogWithTrim(logs, `Log ${i}`);
    }
    expect(logs.length).toBe(MAX_LOG_ENTRIES);
    // Should have logs 5-504
    expect(logs[0]).toBe('Log 5');
    expect(logs[logs.length - 1]).toBe('Log 504');
  });
});
