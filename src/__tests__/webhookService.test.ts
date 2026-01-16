/**
 * Webhook Service Tests
 * Tests for webhook notification functionality
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Tauri API
const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));

// Mock settingsService
const mockGetFailureWebhookUrl = vi.fn();

vi.mock('../services/settingsService', () => ({
  getFailureWebhookUrl: mockGetFailureWebhookUrl,
}));

describe('webhookService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('sendFailureNotification', () => {
    it('should not send webhook when URL is empty', async () => {
      mockGetFailureWebhookUrl.mockResolvedValue('');

      const { sendFailureNotification } = await import('../services/webhookService');

      await sendFailureNotification('scenario-1', 'Test Scenario', {
        scenarioId: 'scenario-1',
        title: 'Test Scenario',
        success: false,
        error: 'Test error',
        completedActions: 0,
        actionHistory: [],
      });

      // invoke should not be called when URL is empty
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should not send webhook when URL is whitespace only', async () => {
      mockGetFailureWebhookUrl.mockResolvedValue('   ');

      const { sendFailureNotification } = await import('../services/webhookService');

      await sendFailureNotification('scenario-1', 'Test Scenario', {
        scenarioId: 'scenario-1',
        title: 'Test Scenario',
        success: false,
        error: 'Test error',
        completedActions: 0,
        actionHistory: [],
      });

      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should not send webhook when URL is invalid', async () => {
      mockGetFailureWebhookUrl.mockResolvedValue('not-a-valid-url');
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { sendFailureNotification } = await import('../services/webhookService');

      await sendFailureNotification('scenario-1', 'Test Scenario', {
        scenarioId: 'scenario-1',
        title: 'Test Scenario',
        success: false,
        error: 'Test error',
        completedActions: 0,
        actionHistory: [],
      });

      // Should warn about invalid URL and not call invoke
      expect(consoleSpy).toHaveBeenCalled();
      const firstCallArgs = consoleSpy.mock.calls[0];
      expect(firstCallArgs.some((arg) => typeof arg === 'string' && arg.includes('Invalid webhook URL'))).toBe(true);
      expect(mockInvoke).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should send webhook with correct payload when URL is valid', async () => {
      mockGetFailureWebhookUrl.mockResolvedValue('https://example.com/webhook');
      mockInvoke.mockResolvedValue(true);

      const { sendFailureNotification } = await import('../services/webhookService');

      await sendFailureNotification('scenario-1', 'Test Scenario', {
        scenarioId: 'scenario-1',
        title: 'Test Scenario',
        success: false,
        error: 'Element not found',
        completedActions: 2,
        failedAtAction: 'Click submit button',
        lastSuccessfulAction: 'Fill form',
        actionHistory: [
          { index: 0, action: 'type', description: 'Fill form', success: true, timestamp: new Date() },
          { index: 1, action: 'click', description: 'Click submit button', success: false, timestamp: new Date() },
        ],
      });

      expect(mockInvoke).toHaveBeenCalledWith('send_webhook', {
        url: 'https://example.com/webhook',
        payload: expect.objectContaining({
          event: 'test_failure',
          timestamp: expect.any(String),
          scenario: {
            id: 'scenario-1',
            title: 'Test Scenario',
          },
          error: expect.objectContaining({
            message: 'Element not found',
            failed_at_action: 'Click submit button',
            last_successful_action: 'Fill form',
            completed_actions: 2,
          }),
        }),
      });
    });

    it('should handle invoke failure gracefully', async () => {
      mockGetFailureWebhookUrl.mockResolvedValue('https://example.com/webhook');
      mockInvoke.mockRejectedValue(new Error('Network error'));
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { sendFailureNotification } = await import('../services/webhookService');

      // Should not throw
      await expect(
        sendFailureNotification('scenario-1', 'Test Scenario', {
          scenarioId: 'scenario-1',
          title: 'Test Scenario',
          success: false,
          error: 'Test error',
          completedActions: 0,
          actionHistory: [],
        })
      ).resolves.not.toThrow();

      // Should warn about failure
      expect(consoleSpy).toHaveBeenCalled();
      const failureCallArgs = consoleSpy.mock.calls.find((args) =>
        args.some((arg) => typeof arg === 'string' && arg.includes('Failed to send notification'))
      );
      expect(failureCallArgs).toBeDefined();

      consoleSpy.mockRestore();
    });

    it('should warn when invoke returns false (webhook not sent)', async () => {
      mockGetFailureWebhookUrl.mockResolvedValue('https://example.com/webhook');
      mockInvoke.mockResolvedValue(false);
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { sendFailureNotification } = await import('../services/webhookService');

      await sendFailureNotification('scenario-1', 'Test Scenario', {
        scenarioId: 'scenario-1',
        title: 'Test Scenario',
        success: false,
        error: 'Test error',
        completedActions: 0,
        actionHistory: [],
      });

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Notification was not sent successfully'));

      consoleSpy.mockRestore();
    });

    it('should include timestamp in ISO format', async () => {
      mockGetFailureWebhookUrl.mockResolvedValue('https://example.com/webhook');
      mockInvoke.mockResolvedValue(true);

      const { sendFailureNotification } = await import('../services/webhookService');

      await sendFailureNotification('scenario-1', 'Test Scenario', {
        scenarioId: 'scenario-1',
        title: 'Test Scenario',
        success: false,
        error: 'Test error',
        completedActions: 0,
        actionHistory: [],
      });

      const callArgs = mockInvoke.mock.calls[0][1];
      const timestamp = callArgs.payload.timestamp;

      // Should be valid ISO string
      expect(() => new Date(timestamp)).not.toThrow();
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });
});
