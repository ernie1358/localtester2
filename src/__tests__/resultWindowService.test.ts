/**
 * Result Window Service Tests
 * Tests for result window creation and event communication
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BatchExecutionResult } from '../types';

// Track WebviewWindow constructor calls
const windowConstructorCalls: { label: string; options: Record<string, unknown> }[] = [];
const mockClose = vi.fn();
const mockOnce = vi.fn();
const mockEmit = vi.fn();

// Create a proper class mock that tracks constructor calls
class MockWebviewWindow {
  label: string;
  options: Record<string, unknown>;
  close = mockClose;
  once = mockOnce;
  emit = mockEmit;

  constructor(label: string, options: Record<string, unknown>) {
    this.label = label;
    this.options = options;
    windowConstructorCalls.push({ label, options });
  }
}

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: MockWebviewWindow,
}));

// Mock listen
const mockUnlisten = vi.fn();
const mockListen = vi.fn();

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen,
}));

describe('ResultWindowService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    windowConstructorCalls.length = 0;

    // Setup default mock behaviors
    mockClose.mockResolvedValue(undefined);
    mockEmit.mockResolvedValue(undefined);
    mockListen.mockResolvedValue(mockUnlisten);

    // Mock window events - trigger 'created' immediately
    mockOnce.mockImplementation((event, callback) => {
      if (event === 'tauri://created') {
        setTimeout(() => callback(), 0);
      }
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('openResultWindow', () => {
    it('should create a new window with correct configuration', async () => {
      // Setup: trigger ready event
      mockListen.mockImplementation(async (event, callback) => {
        if (event === 'result-window-ready') {
          setTimeout(() => callback({}), 10);
        }
        return mockUnlisten;
      });

      const { openResultWindow } = await import('../services/resultWindowService');

      const result: BatchExecutionResult = {
        totalScenarios: 2,
        successCount: 1,
        failureCount: 1,
        results: [],
        executedAt: new Date(),
      };

      await openResultWindow(result);

      // Verify WebviewWindow was called with correct config
      expect(windowConstructorCalls.length).toBeGreaterThanOrEqual(1);
      const lastCall = windowConstructorCalls[windowConstructorCalls.length - 1];
      expect(lastCall.label).toBe('result');
      expect(lastCall.options).toEqual({
        url: '/result.html',
        title: '実行結果 - Xenotester',
        width: 700,
        height: 600,
        center: true,
        resizable: true,
        focus: true,
      });
    });

    it('should emit execution-result event with batch result data', async () => {
      // Setup: trigger ready event
      mockListen.mockImplementation(async (event, callback) => {
        if (event === 'result-window-ready') {
          setTimeout(() => callback({}), 10);
        }
        return mockUnlisten;
      });

      const { openResultWindow } = await import('../services/resultWindowService');

      const result: BatchExecutionResult = {
        totalScenarios: 3,
        successCount: 2,
        failureCount: 1,
        results: [
          { scenarioId: '1', title: 'S1', success: true, completedActions: 5, actionHistory: [] },
          { scenarioId: '2', title: 'S2', success: true, completedActions: 3, actionHistory: [] },
          { scenarioId: '3', title: 'S3', success: false, error: 'Error', completedActions: 2, actionHistory: [] },
        ],
        executedAt: new Date(),
      };

      await openResultWindow(result);

      // Verify emit was called with correct event and data
      expect(mockEmit).toHaveBeenCalledWith('execution-result', result);
    });

    it('should handle handshake timeout gracefully', async () => {
      // Don't trigger ready event - let it timeout
      mockListen.mockResolvedValue(mockUnlisten);

      const { openResultWindow } = await import('../services/resultWindowService');

      const result: BatchExecutionResult = {
        totalScenarios: 1,
        successCount: 1,
        failureCount: 0,
        results: [],
        executedAt: new Date(),
      };

      // This should complete even without ready signal (5s timeout in implementation)
      // For test, we use vi.useFakeTimers
      vi.useFakeTimers();

      const promise = openResultWindow(result);

      // Advance timers to trigger timeout
      await vi.advanceTimersByTimeAsync(5100);

      await promise;

      // Should still emit the result
      expect(mockEmit).toHaveBeenCalledWith('execution-result', result);

      vi.useRealTimers();
    });

    it('should close existing window before opening new one', async () => {
      // Setup: trigger ready event
      mockListen.mockImplementation(async (event, callback) => {
        if (event === 'result-window-ready') {
          setTimeout(() => callback({}), 10);
        }
        return mockUnlisten;
      });

      const { openResultWindow } = await import('../services/resultWindowService');

      const result: BatchExecutionResult = {
        totalScenarios: 1,
        successCount: 1,
        failureCount: 0,
        results: [],
        executedAt: new Date(),
      };

      // Open first window
      await openResultWindow(result);

      // Reset close mock
      mockClose.mockClear();

      // Open second window
      await openResultWindow(result);

      // Should have attempted to close the first window
      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe('closeResultWindow', () => {
    it('should close the window if open', async () => {
      // Setup: trigger ready event
      mockListen.mockImplementation(async (event, callback) => {
        if (event === 'result-window-ready') {
          setTimeout(() => callback({}), 10);
        }
        return mockUnlisten;
      });

      const { openResultWindow, closeResultWindow } = await import('../services/resultWindowService');

      const result: BatchExecutionResult = {
        totalScenarios: 1,
        successCount: 1,
        failureCount: 0,
        results: [],
        executedAt: new Date(),
      };

      await openResultWindow(result);
      mockClose.mockClear();

      await closeResultWindow();

      expect(mockClose).toHaveBeenCalled();
    });

    it('should handle close error gracefully', async () => {
      // Setup: trigger ready event
      mockListen.mockImplementation(async (event, callback) => {
        if (event === 'result-window-ready') {
          setTimeout(() => callback({}), 10);
        }
        return mockUnlisten;
      });

      const { openResultWindow, closeResultWindow } = await import('../services/resultWindowService');

      const result: BatchExecutionResult = {
        totalScenarios: 1,
        successCount: 1,
        failureCount: 0,
        results: [],
        executedAt: new Date(),
      };

      await openResultWindow(result);

      // Make close throw an error (window already closed)
      mockClose.mockRejectedValue(new Error('Window already closed'));

      // Should not throw
      await expect(closeResultWindow()).resolves.not.toThrow();
    });
  });
});
