/**
 * Result Window Service Tests
 * Tests for result window creation and event communication
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// Mock listen - store callbacks so tests can trigger them
const mockUnlisten = vi.fn();
type ListenCallback = (payload: unknown) => void;
let registeredReadyCallbacks: ListenCallback[] = [];

const mockListen = vi.fn().mockImplementation(async (event: string, callback: ListenCallback) => {
  if (event === 'result-window-ready') {
    registeredReadyCallbacks.push(callback);
  }
  return mockUnlisten;
});

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen,
}));

// Helper to trigger ready event
function triggerReadyEvent() {
  registeredReadyCallbacks.forEach(cb => cb({}));
}

describe('ResultWindowService', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    windowConstructorCalls.length = 0;
    registeredReadyCallbacks = [];

    // Reset module state by re-importing
    vi.resetModules();

    // Setup default mock behaviors
    mockClose.mockResolvedValue(undefined);
    mockEmit.mockResolvedValue(undefined);

    // Mock window events - trigger 'created' immediately
    mockOnce.mockImplementation((event, callback) => {
      if (event === 'tauri://created') {
        setTimeout(() => callback(), 0);
      }
    });
  });

  describe('openResultWindow', () => {
    it('should create a new window with correct configuration', async () => {
      const { openResultWindow } = await import('../services/resultWindowService');

      const result: BatchExecutionResult = {
        totalScenarios: 2,
        successCount: 1,
        failureCount: 1,
        results: [],
        executedAt: new Date(),
      };

      // Start opening window
      const openPromise = openResultWindow(result);

      // Wait for listen to be called, then trigger ready event
      await vi.waitFor(() => {
        expect(registeredReadyCallbacks.length).toBeGreaterThan(0);
      });
      triggerReadyEvent();

      await openPromise;

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

      const openPromise = openResultWindow(result);

      await vi.waitFor(() => {
        expect(registeredReadyCallbacks.length).toBeGreaterThan(0);
      });
      triggerReadyEvent();

      await openPromise;

      // Verify emit was called with correct event and data
      expect(mockEmit).toHaveBeenCalledWith('execution-result', result);
    });

    it('should handle handshake timeout gracefully and send result when ready arrives later', async () => {
      vi.useFakeTimers();

      const { openResultWindow } = await import('../services/resultWindowService');

      const result: BatchExecutionResult = {
        totalScenarios: 1,
        successCount: 1,
        failureCount: 0,
        results: [],
        executedAt: new Date(),
      };

      const openPromise = openResultWindow(result);

      // Wait for listen to be set up
      await vi.waitFor(() => {
        expect(registeredReadyCallbacks.length).toBeGreaterThan(0);
      });

      // Advance timers to trigger timeout (5 seconds)
      await vi.advanceTimersByTimeAsync(5100);

      await openPromise;

      // After timeout, result should be buffered (not emitted yet because ready wasn't received)
      expect(mockEmit).not.toHaveBeenCalled();

      // Switch back to real timers for the async callback to work properly
      vi.useRealTimers();

      // Now simulate the ready event arriving after timeout
      triggerReadyEvent();

      // Wait for the async callback to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      // Now the buffered result should be emitted
      expect(mockEmit).toHaveBeenCalledWith('execution-result', result);
    });

    it('should close existing window before opening new one', async () => {
      const { openResultWindow } = await import('../services/resultWindowService');

      const result: BatchExecutionResult = {
        totalScenarios: 1,
        successCount: 1,
        failureCount: 0,
        results: [],
        executedAt: new Date(),
      };

      // Open first window
      const firstPromise = openResultWindow(result);
      await vi.waitFor(() => {
        expect(registeredReadyCallbacks.length).toBeGreaterThan(0);
      });
      triggerReadyEvent();
      await firstPromise;

      // Reset for second open
      mockClose.mockClear();
      registeredReadyCallbacks = [];

      // Open second window
      const secondPromise = openResultWindow(result);
      await vi.waitFor(() => {
        expect(registeredReadyCallbacks.length).toBeGreaterThan(0);
      });
      triggerReadyEvent();
      await secondPromise;

      // Should have attempted to close the first window
      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe('closeResultWindow', () => {
    it('should close the window if open', async () => {
      const { openResultWindow, closeResultWindow } = await import('../services/resultWindowService');

      const result: BatchExecutionResult = {
        totalScenarios: 1,
        successCount: 1,
        failureCount: 0,
        results: [],
        executedAt: new Date(),
      };

      const openPromise = openResultWindow(result);
      await vi.waitFor(() => {
        expect(registeredReadyCallbacks.length).toBeGreaterThan(0);
      });
      triggerReadyEvent();
      await openPromise;

      mockClose.mockClear();

      await closeResultWindow();

      expect(mockClose).toHaveBeenCalled();
    });

    it('should handle close error gracefully', async () => {
      const { openResultWindow, closeResultWindow } = await import('../services/resultWindowService');

      const result: BatchExecutionResult = {
        totalScenarios: 1,
        successCount: 1,
        failureCount: 0,
        results: [],
        executedAt: new Date(),
      };

      const openPromise = openResultWindow(result);
      await vi.waitFor(() => {
        expect(registeredReadyCallbacks.length).toBeGreaterThan(0);
      });
      triggerReadyEvent();
      await openPromise;

      // Make close throw an error (window already closed)
      mockClose.mockRejectedValue(new Error('Window already closed'));

      // Should not throw
      await expect(closeResultWindow()).resolves.not.toThrow();
    });
  });
});
