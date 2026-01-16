/**
 * Webhook Service - Send notifications to external services via Tauri backend
 *
 * Uses Rust backend to send HTTP requests, avoiding CORS restrictions
 */

import { invoke } from '@tauri-apps/api/core';
import type { WebhookPayload, ScenarioExecutionResult } from '../types';
import { getFailureWebhookUrl } from './settingsService';

/**
 * Send failure notification to configured webhook URL via Rust backend
 * Returns silently on error to avoid interrupting test execution
 */
export async function sendFailureNotification(
  scenarioId: string,
  scenarioTitle: string,
  result: ScenarioExecutionResult
): Promise<void> {
  const webhookUrl = await getFailureWebhookUrl();

  // Skip if no URL configured
  if (!webhookUrl.trim()) {
    return;
  }

  // Validate URL format (quick check before sending to backend)
  try {
    new URL(webhookUrl);
  } catch {
    console.warn('[Webhook] Invalid webhook URL configured:', webhookUrl);
    return;
  }

  const payload: WebhookPayload = {
    event: 'test_failure',
    timestamp: new Date().toISOString(),
    scenario: {
      id: scenarioId,
      title: scenarioTitle,
    },
    error: {
      message: result.error || 'Unknown error',
      failedAtAction: result.failedAtAction,
      lastSuccessfulAction: result.lastSuccessfulAction,
      completedActions: result.completedActions,
    },
  };

  try {
    // Send via Rust backend to avoid CORS
    const success = await invoke<boolean>('send_webhook', {
      url: webhookUrl,
      payload: {
        event: payload.event,
        timestamp: payload.timestamp,
        scenario: payload.scenario,
        error: {
          message: payload.error.message,
          failed_at_action: payload.error.failedAtAction,
          last_successful_action: payload.error.lastSuccessfulAction,
          completed_actions: payload.error.completedActions,
        },
      },
    });

    if (!success) {
      console.warn('[Webhook] Notification was not sent successfully');
    }
  } catch (error) {
    // Log but don't throw - webhook failure shouldn't stop test execution
    console.warn('[Webhook] Failed to send notification:', error);
  }
}
