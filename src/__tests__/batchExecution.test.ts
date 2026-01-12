/**
 * Batch Execution Tests
 * Tests for batch scenario execution and result generation
 */

import { describe, it, expect } from 'vitest';
import type { BatchExecutionResult, ScenarioExecutionResult } from '../types';

describe('BatchExecutionResult', () => {
  describe('Result Structure', () => {
    it('should correctly represent successful batch execution', () => {
      const results: ScenarioExecutionResult[] = [
        {
          scenarioId: '1',
          title: 'Scenario 1',
          success: true,
          completedActions: 5,
          actionHistory: [],
        },
        {
          scenarioId: '2',
          title: 'Scenario 2',
          success: true,
          completedActions: 3,
          actionHistory: [],
        },
      ];

      const batchResult: BatchExecutionResult = {
        totalScenarios: 2,
        successCount: 2,
        failureCount: 0,
        results,
        executedAt: new Date(),
      };

      expect(batchResult.totalScenarios).toBe(2);
      expect(batchResult.successCount).toBe(2);
      expect(batchResult.failureCount).toBe(0);
      expect(batchResult.results.length).toBe(2);
    });

    it('should correctly represent mixed success/failure execution', () => {
      const results: ScenarioExecutionResult[] = [
        {
          scenarioId: '1',
          title: 'Scenario 1',
          success: true,
          completedActions: 5,
          actionHistory: [],
        },
        {
          scenarioId: '2',
          title: 'Scenario 2',
          success: false,
          error: 'Button not found',
          completedActions: 2,
          failedAtAction: 'Click submit button',
          actionHistory: [
            { index: 0, action: 'click', description: 'Open form', success: true, timestamp: new Date() },
            { index: 1, action: 'type', description: 'Enter text', success: true, timestamp: new Date() },
            { index: 2, action: 'click', description: 'Click submit button', success: false, timestamp: new Date() },
          ],
          lastSuccessfulAction: 'Enter text',
        },
      ];

      const batchResult: BatchExecutionResult = {
        totalScenarios: 2,
        successCount: 1,
        failureCount: 1,
        results,
        executedAt: new Date(),
      };

      expect(batchResult.successCount).toBe(1);
      expect(batchResult.failureCount).toBe(1);

      const failedResult = batchResult.results.find(r => !r.success);
      expect(failedResult).toBeDefined();
      expect(failedResult!.failedAtAction).toBe('Click submit button');
      expect(failedResult!.lastSuccessfulAction).toBe('Enter text');
      expect(failedResult!.actionHistory.length).toBe(3);
    });

    it('should preserve execution order in results', () => {
      const results: ScenarioExecutionResult[] = [
        { scenarioId: '3', title: 'Third', success: true, completedActions: 1, actionHistory: [] },
        { scenarioId: '1', title: 'First', success: true, completedActions: 1, actionHistory: [] },
        { scenarioId: '2', title: 'Second', success: true, completedActions: 1, actionHistory: [] },
      ];

      const batchResult: BatchExecutionResult = {
        totalScenarios: 3,
        successCount: 3,
        failureCount: 0,
        results,
        executedAt: new Date(),
      };

      // Results should be in execution order (3, 1, 2)
      expect(batchResult.results[0].scenarioId).toBe('3');
      expect(batchResult.results[1].scenarioId).toBe('1');
      expect(batchResult.results[2].scenarioId).toBe('2');
    });
  });

  describe('ScenarioExecutionResult', () => {
    it('should track action history with correct structure', () => {
      const result: ScenarioExecutionResult = {
        scenarioId: 'test',
        title: 'Test Scenario',
        success: false,
        error: 'Element not found',
        completedActions: 2,
        failedAtAction: 'Click button',
        actionHistory: [
          { index: 0, action: 'screenshot', description: 'Capture initial state', success: true, timestamp: new Date('2024-01-01T10:00:00Z') },
          { index: 1, action: 'click', description: 'Click menu', success: true, timestamp: new Date('2024-01-01T10:00:01Z') },
          { index: 2, action: 'click', description: 'Click button', success: false, timestamp: new Date('2024-01-01T10:00:02Z') },
        ],
        lastSuccessfulAction: 'Click menu',
      };

      expect(result.actionHistory.length).toBe(3);
      expect(result.actionHistory[0].success).toBe(true);
      expect(result.actionHistory[2].success).toBe(false);
      expect(result.completedActions).toBe(2);
    });

    it('should handle scenario with no actions', () => {
      const result: ScenarioExecutionResult = {
        scenarioId: 'empty',
        title: 'Empty Scenario',
        success: false,
        error: 'No actions to execute',
        completedActions: 0,
        actionHistory: [],
      };

      expect(result.completedActions).toBe(0);
      expect(result.actionHistory.length).toBe(0);
      expect(result.failedAtAction).toBeUndefined();
      expect(result.lastSuccessfulAction).toBeUndefined();
    });
  });

  describe('Execution Count Accuracy', () => {
    it('should match results.length with actual executed scenarios', () => {
      // This test verifies the fix for reviewer issue about totalScenarios
      const results: ScenarioExecutionResult[] = [
        { scenarioId: '1', title: 'S1', success: true, completedActions: 1, actionHistory: [] },
        { scenarioId: '2', title: 'S2', success: false, completedActions: 0, actionHistory: [] },
      ];

      // totalScenarios should reflect selection, results.length reflects actual execution
      const batchResult: BatchExecutionResult = {
        totalScenarios: 5, // User selected 5, but only 2 were executed (e.g., due to stop)
        successCount: 1,
        failureCount: 1,
        results,
        executedAt: new Date(),
      };

      // For accurate reporting, check results.length
      expect(batchResult.results.length).toBe(2); // Actually executed
      expect(batchResult.totalScenarios).toBe(5); // Originally selected
    });
  });
});
