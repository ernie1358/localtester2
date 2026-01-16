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

// Mock webhookService
const mockSendFailureNotification = vi.fn();

vi.mock('../services/webhookService', () => ({
  sendFailureNotification: mockSendFailureNotification,
}));

describe('ScenarioRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Setup default mock returns
    mockInvoke.mockResolvedValue(undefined);
    mockListen.mockResolvedValue(mockUnlisten);
    // Default: return empty array for hint images
    mockGetStepImages.mockResolvedValue([]);
    // Default: webhook notification succeeds
    mockSendFailureNotification.mockResolvedValue(undefined);
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

  describe('runSelected - Hint Images', () => {
    it('should call getStepImages for each scenario and pass hintImages to runAgentLoop', async () => {
      const mockHintImages = [
        { id: 'img1', scenario_id: '1', image_data: 'base64data1', file_name: 'hint1.png', mime_type: 'image/png', order_index: 0, created_at: '' },
        { id: 'img2', scenario_id: '1', image_data: 'base64data2', file_name: 'hint2.png', mime_type: 'image/jpeg', order_index: 1, created_at: '' },
      ];

      mockGetStepImages.mockResolvedValue(mockHintImages);

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
        { id: '1', title: 'Scenario with hints', description: 'D', order_index: 0, created_at: '', updated_at: '' },
      ];

      await runner.runSelected(['1'], scenarios);

      // Verify getStepImages was called with correct scenario ID
      expect(mockGetStepImages).toHaveBeenCalledWith('1');

      // Verify runAgentLoop was called with hintImages
      expect(mockRunAgentLoop).toHaveBeenCalledWith(
        expect.objectContaining({
          hintImages: mockHintImages,
        })
      );

      await runner.destroy();
    });

    it('should pass empty array when no hint images exist', async () => {
      mockGetStepImages.mockResolvedValue([]);

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
        { id: '1', title: 'Scenario without hints', description: 'D', order_index: 0, created_at: '', updated_at: '' },
      ];

      await runner.runSelected(['1'], scenarios);

      // Verify runAgentLoop was called with empty hintImages array
      expect(mockRunAgentLoop).toHaveBeenCalledWith(
        expect.objectContaining({
          hintImages: [],
        })
      );

      await runner.destroy();
    });

    it('should load hint images for each scenario independently', async () => {
      const hintImagesScenario1 = [
        { id: 'img1', scenario_id: '1', image_data: 'data1', file_name: 'hint1.png', mime_type: 'image/png', order_index: 0, created_at: '' },
      ];
      const hintImagesScenario2 = [
        { id: 'img2', scenario_id: '2', image_data: 'data2', file_name: 'hint2.png', mime_type: 'image/png', order_index: 0, created_at: '' },
        { id: 'img3', scenario_id: '2', image_data: 'data3', file_name: 'hint3.png', mime_type: 'image/png', order_index: 1, created_at: '' },
      ];

      mockGetStepImages.mockImplementation(async (scenarioId: string) => {
        if (scenarioId === '1') return hintImagesScenario1;
        if (scenarioId === '2') return hintImagesScenario2;
        return [];
      });

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
        { id: '1', title: 'Scenario 1', description: 'D1', order_index: 0, created_at: '', updated_at: '' },
        { id: '2', title: 'Scenario 2', description: 'D2', order_index: 1, created_at: '', updated_at: '' },
      ];

      await runner.runSelected(['1', '2'], scenarios);

      // Verify getStepImages was called for each scenario
      expect(mockGetStepImages).toHaveBeenCalledWith('1');
      expect(mockGetStepImages).toHaveBeenCalledWith('2');

      // Verify first call to runAgentLoop had scenario 1's hint images
      expect(mockRunAgentLoop).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          hintImages: hintImagesScenario1,
        })
      );

      // Verify second call to runAgentLoop had scenario 2's hint images
      expect(mockRunAgentLoop).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          hintImages: hintImagesScenario2,
        })
      );

      await runner.destroy();
    });
  });

  describe('runSelected - Hint Image Loading Failure Handling', () => {
    it('should fail scenario and continue to next when getStepImages fails', async () => {
      const logs: string[] = [];

      // First call throws error, second call succeeds
      let callCount = 0;
      mockGetStepImages.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Database connection failed');
        }
        return [{ id: 'img1', scenario_id: '2', image_data: 'data', file_name: 'hint.png', mime_type: 'image/png', order_index: 0, created_at: '' }];
      });

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
        { id: '1', title: 'Scenario 1', description: 'D1', order_index: 0, created_at: '', updated_at: '' },
        { id: '2', title: 'Scenario 2', description: 'D2', order_index: 1, created_at: '', updated_at: '' },
      ];

      const result = await runner.runSelected(['1', '2'], scenarios, {
        onLog: (msg) => logs.push(msg),
      });

      // First scenario fails due to image load error, second succeeds
      expect(result.successCount).toBe(1);
      expect(result.failureCount).toBe(1);

      // First scenario should fail without calling runAgentLoop
      // Only one call to runAgentLoop (for scenario 2)
      expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);

      // Second call should have the hint images
      expect(mockRunAgentLoop).toHaveBeenCalledWith(
        expect.objectContaining({
          hintImages: expect.arrayContaining([
            expect.objectContaining({ id: 'img1' }),
          ]),
        })
      );

      // Error log should be present
      expect(logs.some((l) => l.includes('ヒント画像の読み込みに失敗しました'))).toBe(true);

      // First result should have failure error
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toContain('ヒント画像の読み込みに失敗しました');

      await runner.destroy();
    });

    it('should fail scenario execution when hint image load fails', async () => {
      const logs: string[] = [];
      mockGetStepImages.mockRejectedValue(new Error('Storage unavailable'));

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
        { id: '1', title: 'Test', description: 'D', order_index: 0, created_at: '', updated_at: '' },
      ];

      const result = await runner.runSelected(['1'], scenarios, {
        onLog: (msg) => logs.push(msg),
      });

      // Scenario should fail due to image load error
      expect(result.successCount).toBe(0);
      expect(result.failureCount).toBe(1);

      // runAgentLoop should NOT be called (failed before execution)
      expect(mockRunAgentLoop).not.toHaveBeenCalled();

      // Result should contain the error
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toContain('ヒント画像の読み込みに失敗しました');

      await runner.destroy();
    });
  });

  describe('runSelected - Hint Image Validation and Blocking', () => {
    it('should block execution when hint images exceed API limits', async () => {
      const logs: string[] = [];

      // Create 25 small images (exceeds MAX_IMAGE_COUNT of 20)
      const mockHintImages = Array(25)
        .fill(null)
        .map((_, i) => ({
          id: `img${i}`,
          scenario_id: '1',
          image_data: 'x'.repeat(1000), // Small base64
          file_name: `hint${i}.png`,
          mime_type: 'image/png',
          order_index: i,
          created_at: '',
        }));

      mockGetStepImages.mockResolvedValue(mockHintImages);

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
        { id: '1', title: 'Test', description: 'D', order_index: 0, created_at: '', updated_at: '' },
      ];

      const result = await runner.runSelected(['1'], scenarios, {
        onLog: (msg) => logs.push(msg),
      });

      // Should have error log about exceeding limits and blocking execution
      expect(logs.some((l) => l.includes('API制限を超えています'))).toBe(true);
      expect(logs.some((l) => l.includes('実行を中止しました'))).toBe(true);

      // Scenario should fail (not trimmed anymore - execution is blocked)
      expect(result.failureCount).toBe(1);
      expect(result.successCount).toBe(0);
      expect(result.results[0].error).toContain('API制限を超えています');

      // runAgentLoop should NOT be called (execution was blocked)
      expect(mockRunAgentLoop).not.toHaveBeenCalled();

      await runner.destroy();
    });

    it('should pass hint images unchanged when within limits', async () => {
      const mockHintImages = Array(5)
        .fill(null)
        .map((_, i) => ({
          id: `img${i}`,
          scenario_id: '1',
          image_data: 'x'.repeat(1000),
          file_name: `hint${i}.png`,
          mime_type: 'image/png',
          order_index: i,
          created_at: '',
        }));

      mockGetStepImages.mockResolvedValue(mockHintImages);

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
        { id: '1', title: 'Test', description: 'D', order_index: 0, created_at: '', updated_at: '' },
      ];

      await runner.runSelected(['1'], scenarios);

      // Verify runAgentLoop was called with all 5 images (no trimming)
      const callArgs = mockRunAgentLoop.mock.calls[0][0];
      expect(callArgs.hintImages.length).toBe(5);

      await runner.destroy();
    });

    it('should block execution when images have invalid size or MIME type', async () => {
      const logs: string[] = [];

      const base64For6MB = Math.ceil((6 * 1024 * 1024) / 0.75);
      const mockHintImages = [
        { id: 'valid1', scenario_id: '1', image_data: 'x'.repeat(1000), file_name: 'valid1.png', mime_type: 'image/png', order_index: 0, created_at: '' },
        { id: 'oversized', scenario_id: '1', image_data: 'x'.repeat(base64For6MB), file_name: 'oversized.png', mime_type: 'image/png', order_index: 1, created_at: '' },
        { id: 'badmime', scenario_id: '1', image_data: 'x'.repeat(1000), file_name: 'bad.bmp', mime_type: 'image/bmp', order_index: 2, created_at: '' },
        { id: 'valid2', scenario_id: '1', image_data: 'x'.repeat(1000), file_name: 'valid2.jpeg', mime_type: 'image/jpeg', order_index: 3, created_at: '' },
      ];

      mockGetStepImages.mockResolvedValue(mockHintImages);

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
        { id: '1', title: 'Test', description: 'D', order_index: 0, created_at: '', updated_at: '' },
      ];

      const result = await runner.runSelected(['1'], scenarios, {
        onLog: (msg) => logs.push(msg),
      });

      // Should have error about invalid images and blocking execution
      expect(logs.some((l) => l.includes('API制限を超えています'))).toBe(true);
      expect(logs.some((l) => l.includes('実行を中止しました'))).toBe(true);

      // Scenario should fail (not trimmed anymore - execution is blocked)
      expect(result.failureCount).toBe(1);
      expect(result.successCount).toBe(0);

      // runAgentLoop should NOT be called (execution was blocked)
      expect(mockRunAgentLoop).not.toHaveBeenCalled();

      await runner.destroy();
    });
  });

  describe('run - Hint Images for executeScenario path', () => {
    it('should load and pass hint images when using run() method', async () => {
      const mockHintImages = [
        { id: 'img1', scenario_id: 'test-id', image_data: 'base64data1', file_name: 'hint1.png', mime_type: 'image/png', order_index: 0, created_at: '' },
      ];

      mockGetStepImages.mockResolvedValue(mockHintImages);

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

      const scenarios = [
        { id: 'test-id', title: 'Test Scenario', description: 'Test description', status: 'pending' as const },
      ];

      await runner.run(scenarios);

      // Verify getStepImages was called
      expect(mockGetStepImages).toHaveBeenCalledWith('test-id');

      // Verify runAgentLoop was called with hintImages
      expect(mockRunAgentLoop).toHaveBeenCalledWith(
        expect.objectContaining({
          hintImages: mockHintImages,
        })
      );

      await runner.destroy();
    });

    it('should pass empty array when no hint images exist via run() method', async () => {
      mockGetStepImages.mockResolvedValue([]);

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

      const scenarios = [
        { id: 'test-id', title: 'Test Scenario', description: 'Test description', status: 'pending' as const },
      ];

      await runner.run(scenarios);

      // Verify runAgentLoop was called with empty hintImages
      expect(mockRunAgentLoop).toHaveBeenCalledWith(
        expect.objectContaining({
          hintImages: [],
        })
      );

      await runner.destroy();
    });
  });

  describe('Webhook Notification', () => {
    describe('runSelected - Webhook on failure', () => {
      it('should send webhook notification when scenario fails', async () => {
        mockRunAgentLoop.mockResolvedValue({
          success: false,
          error: 'Element not found',
          executedActions: [
            { index: 0, action: 'click', description: 'Click button', success: false, timestamp: new Date() },
          ],
          iterations: 1,
          testResult: { status: 'failure' },
          failedAtAction: 'Click button',
          completedActionCount: 0,
        });

        mockInvoke.mockImplementation(async (cmd: string) => {
          if (cmd === 'is_stop_requested') return false;
          return undefined;
        });

        const { ScenarioRunner } = await import('../services/scenarioRunner');
        const runner = new ScenarioRunner();

        const scenarios: StoredScenario[] = [
          { id: '1', title: 'Failing Test', description: 'D', order_index: 0, created_at: '', updated_at: '' },
        ];

        await runner.runSelected(['1'], scenarios);

        expect(mockSendFailureNotification).toHaveBeenCalledWith(
          '1',
          'Failing Test',
          expect.objectContaining({
            scenarioId: '1',
            title: 'Failing Test',
            success: false,
            error: 'Element not found',
          })
        );

        await runner.destroy();
      });

      it('should not send webhook notification when scenario succeeds', async () => {
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
          { id: '1', title: 'Passing Test', description: 'D', order_index: 0, created_at: '', updated_at: '' },
        ];

        await runner.runSelected(['1'], scenarios);

        expect(mockSendFailureNotification).not.toHaveBeenCalled();

        await runner.destroy();
      });

      it('should send webhook notification for hint image validation failure', async () => {
        // Create 25 images to exceed MAX_IMAGE_COUNT of 20
        const mockHintImages = Array(25)
          .fill(null)
          .map((_, i) => ({
            id: `img${i}`,
            scenario_id: '1',
            image_data: 'x'.repeat(1000),
            file_name: `hint${i}.png`,
            mime_type: 'image/png',
            order_index: i,
            created_at: '',
          }));

        mockGetStepImages.mockResolvedValue(mockHintImages);

        mockInvoke.mockImplementation(async (cmd: string) => {
          if (cmd === 'is_stop_requested') return false;
          return undefined;
        });

        const { ScenarioRunner } = await import('../services/scenarioRunner');
        const runner = new ScenarioRunner();

        const scenarios: StoredScenario[] = [
          { id: '1', title: 'Test with too many images', description: 'D', order_index: 0, created_at: '', updated_at: '' },
        ];

        await runner.runSelected(['1'], scenarios);

        expect(mockSendFailureNotification).toHaveBeenCalledWith(
          '1',
          'Test with too many images',
          expect.objectContaining({
            success: false,
            error: expect.stringContaining('API制限を超えています'),
          })
        );

        await runner.destroy();
      });

      it('should send webhook notification when hint image loading fails', async () => {
        mockGetStepImages.mockRejectedValue(new Error('Database error'));

        mockInvoke.mockImplementation(async (cmd: string) => {
          if (cmd === 'is_stop_requested') return false;
          return undefined;
        });

        const { ScenarioRunner } = await import('../services/scenarioRunner');
        const runner = new ScenarioRunner();

        const scenarios: StoredScenario[] = [
          { id: '1', title: 'Test with DB error', description: 'D', order_index: 0, created_at: '', updated_at: '' },
        ];

        await runner.runSelected(['1'], scenarios);

        expect(mockSendFailureNotification).toHaveBeenCalledWith(
          '1',
          'Test with DB error',
          expect.objectContaining({
            success: false,
            error: expect.stringContaining('ヒント画像の読み込みに失敗'),
          })
        );

        await runner.destroy();
      });
    });

    describe('run - Webhook on failure', () => {
      it('should send webhook notification when scenario fails via run()', async () => {
        mockRunAgentLoop.mockResolvedValue({
          success: false,
          error: 'Assertion failed',
          executedActions: [
            { index: 0, action: 'screenshot', description: 'Take screenshot', success: true, timestamp: new Date() },
            { index: 1, action: 'click', description: 'Click submit', success: false, timestamp: new Date() },
          ],
          iterations: 2,
          testResult: { status: 'failure', failureDetails: 'Assertion failed' },
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

        const scenarios = [
          { id: 'test-id', title: 'Test Scenario', description: 'Test description', status: 'pending' as const },
        ];

        await runner.run(scenarios);

        expect(mockSendFailureNotification).toHaveBeenCalledWith(
          'test-id',
          'Test Scenario',
          expect.objectContaining({
            scenarioId: 'test-id',
            title: 'Test Scenario',
            success: false,
            error: 'Assertion failed',
            failedAtAction: 'Click submit',
            lastSuccessfulAction: 'Take screenshot',
            completedActions: 1,
          })
        );

        await runner.destroy();
      });

      it('should not send webhook notification when scenario succeeds via run()', async () => {
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

        const scenarios = [
          { id: 'test-id', title: 'Test Scenario', description: 'Test description', status: 'pending' as const },
        ];

        await runner.run(scenarios);

        expect(mockSendFailureNotification).not.toHaveBeenCalled();

        await runner.destroy();
      });

      it('should send webhook notification when exception occurs during run()', async () => {
        mockGetStepImages.mockRejectedValue(new Error('Unexpected DB error'));

        mockInvoke.mockImplementation(async (cmd: string) => {
          if (cmd === 'is_stop_requested') return false;
          return undefined;
        });

        const { ScenarioRunner } = await import('../services/scenarioRunner');
        const runner = new ScenarioRunner();

        const scenarios = [
          { id: 'test-id', title: 'Test Scenario', description: 'Test description', status: 'pending' as const },
        ];

        await runner.run(scenarios);

        expect(mockSendFailureNotification).toHaveBeenCalledWith(
          'test-id',
          'Test Scenario',
          expect.objectContaining({
            success: false,
            error: expect.stringContaining('ヒント画像の読み込みに失敗'),
          })
        );

        await runner.destroy();
      });

      it('should continue execution even if webhook notification fails', async () => {
        mockRunAgentLoop.mockResolvedValue({
          success: false,
          error: 'Test failed',
          executedActions: [],
          iterations: 1,
          testResult: { status: 'failure', failureDetails: 'Test failed' },
        });

        mockSendFailureNotification.mockRejectedValue(new Error('Webhook error'));

        mockInvoke.mockImplementation(async (cmd: string) => {
          if (cmd === 'is_stop_requested') return false;
          return undefined;
        });

        const { ScenarioRunner } = await import('../services/scenarioRunner');
        const runner = new ScenarioRunner();

        const scenarios = [
          { id: 'test-1', title: 'Test 1', description: 'D1', status: 'pending' as const },
          { id: 'test-2', title: 'Test 2', description: 'D2', status: 'pending' as const },
        ];

        // Should not throw even if webhook fails
        const state = await runner.run(scenarios);

        // Both scenarios should have been processed
        expect(state.scenarios.length).toBe(2);

        await runner.destroy();
      });

      it('should NOT send webhook notification when user stops execution (status: stopped) via run()', async () => {
        mockRunAgentLoop.mockResolvedValue({
          success: false,
          error: 'Stopped by user',
          executedActions: [
            { index: 0, action: 'screenshot', description: 'Take screenshot', success: true, timestamp: new Date() },
          ],
          iterations: 1,
          testResult: { status: 'stopped', failureReason: 'user_stopped', failureDetails: 'Stopped by user request' },
          completedActionCount: 1,
        });

        mockInvoke.mockImplementation(async (cmd: string) => {
          if (cmd === 'is_stop_requested') return false;
          return undefined;
        });

        const { ScenarioRunner } = await import('../services/scenarioRunner');
        const runner = new ScenarioRunner();

        const scenarios = [
          { id: 'test-id', title: 'Test Scenario', description: 'Test description', status: 'pending' as const },
        ];

        await runner.run(scenarios);

        // Webhook should NOT be called for user-initiated stop
        expect(mockSendFailureNotification).not.toHaveBeenCalled();

        await runner.destroy();
      });
    });

    describe('runSelected - Webhook on stopped', () => {
      it('should NOT send webhook notification when user stops execution (status: stopped) via runSelected()', async () => {
        mockRunAgentLoop.mockResolvedValue({
          success: false,
          error: 'Stopped by user',
          executedActions: [
            { index: 0, action: 'screenshot', description: 'Take screenshot', success: true, timestamp: new Date() },
          ],
          iterations: 1,
          testResult: { status: 'stopped', failureReason: 'user_stopped', failureDetails: 'Stopped by user request' },
          completedActionCount: 1,
        });

        mockInvoke.mockImplementation(async (cmd: string) => {
          if (cmd === 'is_stop_requested') return false;
          return undefined;
        });

        const { ScenarioRunner } = await import('../services/scenarioRunner');
        const runner = new ScenarioRunner();

        const scenarios: StoredScenario[] = [
          { id: '1', title: 'Stopped Test', description: 'D', order_index: 0, created_at: '', updated_at: '' },
        ];

        await runner.runSelected(['1'], scenarios);

        // Webhook should NOT be called for user-initiated stop
        expect(mockSendFailureNotification).not.toHaveBeenCalled();

        await runner.destroy();
      });
    });
  });
});
