/**
 * Scenario Runner Tests
 * Tests for batch scenario execution: order guarantee, stop handling, and result aggregation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StoredScenario } from '../types';

// Mock Tauri API
const mockInvoke = vi.fn();
const mockListen = vi.fn();
const mockUnlisten = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen,
}));

// Mock agentLoop
const mockRunAgentLoop = vi.fn();

vi.mock('../services/agentLoop', () => ({
  runAgentLoop: mockRunAgentLoop,
}));

// Mock scenarioDatabase (for getStepImages)
const mockGetStepImages = vi.fn();

vi.mock('../services/scenarioDatabase', () => ({
  getStepImages: mockGetStepImages,
}));

describe('ScenarioRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Setup default mock returns
    mockInvoke.mockResolvedValue(undefined);
    mockListen.mockResolvedValue(mockUnlisten);
    // Default: return empty array for hint images
    mockGetStepImages.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('runSelected - Order Guarantee', () => {
    it('should execute scenarios in the order specified by orderedScenarioIds', async () => {
      const executionOrder: string[] = [];

      mockRunAgentLoop.mockImplementation(async ({ scenario }) => {
        executionOrder.push(scenario.id);
        return {
          success: true,
          executedActions: [],
          iterations: 1,
          testResult: { status: 'success' },
        };
      });

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'is_stop_requested') return false;
        return undefined;
      });

      const { ScenarioRunner } = await import('../services/scenarioRunner');
      const runner = new ScenarioRunner();

      const scenarios: StoredScenario[] = [
        { id: 'a', title: 'Scenario A', description: 'A', order_index: 0, created_at: '', updated_at: '' },
        { id: 'b', title: 'Scenario B', description: 'B', order_index: 1, created_at: '', updated_at: '' },
        { id: 'c', title: 'Scenario C', description: 'C', order_index: 2, created_at: '', updated_at: '' },
      ];

      // Execute in reverse order: c, a, b
      const orderedIds = ['c', 'a', 'b'];

      const result = await runner.runSelected(orderedIds, scenarios);

      // Verify execution order matches orderedScenarioIds
      expect(executionOrder).toEqual(['c', 'a', 'b']);
      expect(result.results.map((r) => r.scenarioId)).toEqual(['c', 'a', 'b']);

      await runner.destroy();
    });

    it('should skip scenarios not found in the scenarios array', async () => {
      const executionOrder: string[] = [];

      mockRunAgentLoop.mockImplementation(async ({ scenario }) => {
        executionOrder.push(scenario.id);
        return {
          success: true,
          executedActions: [],
          iterations: 1,
          testResult: { status: 'success' },
        };
      });

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'is_stop_requested') return false;
        return undefined;
      });

      const { ScenarioRunner } = await import('../services/scenarioRunner');
      const runner = new ScenarioRunner();

      const scenarios: StoredScenario[] = [
        { id: 'a', title: 'Scenario A', description: 'A', order_index: 0, created_at: '', updated_at: '' },
      ];

      // Try to execute 'a' and 'nonexistent'
      const orderedIds = ['a', 'nonexistent', 'alsoNonexistent'];

      const result = await runner.runSelected(orderedIds, scenarios);

      // Only 'a' should be executed
      expect(executionOrder).toEqual(['a']);
      expect(result.results.length).toBe(1);
      expect(result.totalScenarios).toBe(3); // Original selection count

      await runner.destroy();
    });
  });

  describe('runSelected - Result Aggregation', () => {
    it('should correctly count success and failure', async () => {
      let callCount = 0;
      mockRunAgentLoop.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          return {
            success: false,
            error: 'Element not found',
            executedActions: [{ index: 0, action: 'click', description: 'Click button', success: false, timestamp: new Date() }],
            iterations: 1,
            testResult: { status: 'failure' },
            failedAtAction: 'Click button',
          };
        }
        return {
          success: true,
          executedActions: [],
          iterations: 1,
          testResult: { status: 'success' },
        };
      });

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'is_stop_requested') return false;
        return undefined;
      });

      const { ScenarioRunner } = await import('../services/scenarioRunner');
      const runner = new ScenarioRunner();

      const scenarios: StoredScenario[] = [
        { id: '1', title: 'S1', description: 'D1', order_index: 0, created_at: '', updated_at: '' },
        { id: '2', title: 'S2', description: 'D2', order_index: 1, created_at: '', updated_at: '' },
        { id: '3', title: 'S3', description: 'D3', order_index: 2, created_at: '', updated_at: '' },
      ];

      const result = await runner.runSelected(['1', '2', '3'], scenarios);

      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(1);
      expect(result.results[1].success).toBe(false);
      expect(result.results[1].error).toBe('Element not found');

      await runner.destroy();
    });

    it('should track action history for failed scenarios', async () => {
      mockRunAgentLoop.mockResolvedValue({
        success: false,
        error: 'Button not visible',
        executedActions: [
          { index: 0, action: 'screenshot', description: 'Take screenshot', success: true, timestamp: new Date() },
          { index: 1, action: 'click', description: 'Click submit', success: false, timestamp: new Date() },
        ],
        iterations: 2,
        testResult: { status: 'failure' },
        failedAtAction: 'Click submit',
        lastSuccessfulAction: 'Take screenshot',
        completedActionCount: 1,
      });

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'is_stop_requested') return false;
        return undefined;
      });

      const { ScenarioRunner } = await import('../services/scenarioRunner');
      const runner = new ScenarioRunner();

      const scenarios: StoredScenario[] = [
        { id: '1', title: 'Test', description: 'D', order_index: 0, created_at: '', updated_at: '' },
      ];

      const result = await runner.runSelected(['1'], scenarios);

      expect(result.results[0].actionHistory.length).toBe(2);
      expect(result.results[0].failedAtAction).toBe('Click submit');
      expect(result.results[0].lastSuccessfulAction).toBe('Take screenshot');
      expect(result.results[0].completedActions).toBe(1);

      await runner.destroy();
    });
  });

  describe('runSelected - Stop Handling', () => {
    it('should stop execution when is_stop_requested returns true', async () => {
      const executedIds: string[] = [];
      let callCount = 0;

      mockRunAgentLoop.mockImplementation(async ({ scenario }) => {
        executedIds.push(scenario.id);
        return {
          success: true,
          executedActions: [],
          iterations: 1,
          testResult: { status: 'success' },
        };
      });

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'is_stop_requested') {
          callCount++;
          // Return true after first scenario
          return callCount > 1;
        }
        return undefined;
      });

      const { ScenarioRunner } = await import('../services/scenarioRunner');
      const runner = new ScenarioRunner();

      const scenarios: StoredScenario[] = [
        { id: '1', title: 'S1', description: 'D1', order_index: 0, created_at: '', updated_at: '' },
        { id: '2', title: 'S2', description: 'D2', order_index: 1, created_at: '', updated_at: '' },
        { id: '3', title: 'S3', description: 'D3', order_index: 2, created_at: '', updated_at: '' },
      ];

      const result = await runner.runSelected(['1', '2', '3'], scenarios);

      // Only first scenario should have been executed
      expect(executedIds).toEqual(['1']);
      expect(result.results.length).toBe(1);
      expect(result.totalScenarios).toBe(3);

      await runner.destroy();
    });

    it('should stop when stopOnFailure is true and a scenario fails', async () => {
      const executedIds: string[] = [];

      mockRunAgentLoop.mockImplementation(async ({ scenario }) => {
        executedIds.push(scenario.id);
        if (scenario.id === '2') {
          return {
            success: false,
            error: 'Failed',
            executedActions: [],
            iterations: 1,
            testResult: { status: 'failure' },
          };
        }
        return {
          success: true,
          executedActions: [],
          iterations: 1,
          testResult: { status: 'success' },
        };
      });

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'is_stop_requested') return false;
        return undefined;
      });

      const { ScenarioRunner } = await import('../services/scenarioRunner');
      const runner = new ScenarioRunner();

      const scenarios: StoredScenario[] = [
        { id: '1', title: 'S1', description: 'D1', order_index: 0, created_at: '', updated_at: '' },
        { id: '2', title: 'S2', description: 'D2', order_index: 1, created_at: '', updated_at: '' },
        { id: '3', title: 'S3', description: 'D3', order_index: 2, created_at: '', updated_at: '' },
      ];

      const result = await runner.runSelected(['1', '2', '3'], scenarios, { stopOnFailure: true });

      // Should stop after scenario 2 fails
      expect(executedIds).toEqual(['1', '2']);
      expect(result.results.length).toBe(2);
      expect(result.successCount).toBe(1);
      expect(result.failureCount).toBe(1);

      await runner.destroy();
    });

    it('should continue execution when stopOnFailure is false and a scenario fails', async () => {
      const executedIds: string[] = [];

      mockRunAgentLoop.mockImplementation(async ({ scenario }) => {
        executedIds.push(scenario.id);
        if (scenario.id === '2') {
          return {
            success: false,
            error: 'Failed',
            executedActions: [],
            iterations: 1,
            testResult: { status: 'failure' },
          };
        }
        return {
          success: true,
          executedActions: [],
          iterations: 1,
          testResult: { status: 'success' },
        };
      });

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'is_stop_requested') return false;
        return undefined;
      });

      const { ScenarioRunner } = await import('../services/scenarioRunner');
      const runner = new ScenarioRunner();

      const scenarios: StoredScenario[] = [
        { id: '1', title: 'S1', description: 'D1', order_index: 0, created_at: '', updated_at: '' },
        { id: '2', title: 'S2', description: 'D2', order_index: 1, created_at: '', updated_at: '' },
        { id: '3', title: 'S3', description: 'D3', order_index: 2, created_at: '', updated_at: '' },
      ];

      const result = await runner.runSelected(['1', '2', '3'], scenarios, { stopOnFailure: false });

      // All scenarios should execute
      expect(executedIds).toEqual(['1', '2', '3']);
      expect(result.results.length).toBe(3);
      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(1);

      await runner.destroy();
    });
  });

  describe('runSelected - Logging', () => {
    it('should call onLog callback with execution progress', async () => {
      const logs: string[] = [];

      mockRunAgentLoop.mockResolvedValue({
        success: true,
        executedActions: [],
        iterations: 1,
        testResult: { status: 'success' },
      });

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'is_stop_requested') return false;
        return undefined;
      });

      const { ScenarioRunner } = await import('../services/scenarioRunner');
      const runner = new ScenarioRunner();

      const scenarios: StoredScenario[] = [
        { id: '1', title: 'Test Scenario', description: 'D', order_index: 0, created_at: '', updated_at: '' },
      ];

      await runner.runSelected(['1'], scenarios, {
        onLog: (msg) => logs.push(msg),
      });

      // Should have start and success logs
      expect(logs.some((l) => l.includes('テストステップ開始'))).toBe(true);
      expect(logs.some((l) => l.includes('テストステップ成功'))).toBe(true);

      await runner.destroy();
    });
  });
});
