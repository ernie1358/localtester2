/**
 * Result Judge Tests
 * Tests for analyzeClaudeResponse and failure reason mapping
 */

import { describe, it, expect } from 'vitest';
import type { BetaMessage, BetaTextBlock } from '@anthropic-ai/sdk/resources/beta/messages';
import type { ExpectedAction } from '../types';
import { analyzeClaudeResponse } from '../services/resultJudge';

// Helper to create a mock BetaMessage with text content
function createMockMessage(text: string, includeToolUse = false): BetaMessage {
  const content: BetaMessage['content'] = [
    {
      type: 'text',
      text,
    } as BetaTextBlock,
  ];

  if (includeToolUse) {
    content.push({
      type: 'tool_use',
      id: 'tool-1',
      name: 'computer',
      input: { action: 'screenshot' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }

  return {
    id: 'msg-1',
    type: 'message',
    role: 'assistant',
    content,
    model: 'claude-sonnet-4-20250514',
    stop_reason: includeToolUse ? null : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as BetaMessage;
}

describe('analyzeClaudeResponse - failure reason mapping', () => {
  const emptyExpectedActions: ExpectedAction[] = [];

  describe('mapClaudeFailureReason via analyzeClaudeResponse', () => {
    it('should map "位置が違う" to action_mismatch', () => {
      const message = createMockMessage(`
\`\`\`json
{"status": "failure", "message": "クリックに失敗しました", "failureReason": "クリック位置が違う"}
\`\`\`
      `);

      const result = analyzeClaudeResponse(message, emptyExpectedActions, 0);

      expect(result.isComplete).toBe(true);
      expect(result.isSuccess).toBe(false);
      expect(result.failureReason).toBe('action_mismatch');
    });

    it('should map "wrong click position" to action_mismatch', () => {
      const message = createMockMessage(`
\`\`\`json
{"status": "failure", "message": "Click failed", "failureReason": "wrong click position"}
\`\`\`
      `);

      const result = analyzeClaudeResponse(message, emptyExpectedActions, 0);

      expect(result.isComplete).toBe(true);
      expect(result.isSuccess).toBe(false);
      expect(result.failureReason).toBe('action_mismatch');
    });

    it('should map "wrong position" to action_mismatch', () => {
      const message = createMockMessage(`
\`\`\`json
{"status": "failure", "message": "Action failed", "failureReason": "wrong position detected"}
\`\`\`
      `);

      const result = analyzeClaudeResponse(message, emptyExpectedActions, 0);

      expect(result.isComplete).toBe(true);
      expect(result.isSuccess).toBe(false);
      expect(result.failureReason).toBe('action_mismatch');
    });

    it('should map "見つからない" to element_not_found', () => {
      const message = createMockMessage(`
\`\`\`json
{"status": "failure", "message": "Element not found", "failureReason": "ボタンが見つからない"}
\`\`\`
      `);

      const result = analyzeClaudeResponse(message, emptyExpectedActions, 0);

      expect(result.isComplete).toBe(true);
      expect(result.isSuccess).toBe(false);
      expect(result.failureReason).toBe('element_not_found');
    });

    it('should map "not found" to element_not_found', () => {
      const message = createMockMessage(`
\`\`\`json
{"status": "failure", "message": "Button not found", "failureReason": "element not found on screen"}
\`\`\`
      `);

      const result = analyzeClaudeResponse(message, emptyExpectedActions, 0);

      expect(result.isComplete).toBe(true);
      expect(result.isSuccess).toBe(false);
      expect(result.failureReason).toBe('element_not_found');
    });

    it('should map "効果なし" to action_no_effect', () => {
      const message = createMockMessage(`
\`\`\`json
{"status": "failure", "message": "No response", "failureReason": "クリック効果なし"}
\`\`\`
      `);

      const result = analyzeClaudeResponse(message, emptyExpectedActions, 0);

      expect(result.isComplete).toBe(true);
      expect(result.isSuccess).toBe(false);
      expect(result.failureReason).toBe('action_no_effect');
    });

    it('should map "予期しない" to unexpected_state', () => {
      const message = createMockMessage(`
\`\`\`json
{"status": "failure", "message": "Unexpected result", "failureReason": "予期しない画面が表示された"}
\`\`\`
      `);

      const result = analyzeClaudeResponse(message, emptyExpectedActions, 0);

      expect(result.isComplete).toBe(true);
      expect(result.isSuccess).toBe(false);
      expect(result.failureReason).toBe('unexpected_state');
    });

    it('should map unknown failure reasons to unknown', () => {
      const message = createMockMessage(`
\`\`\`json
{"status": "failure", "message": "Something went wrong", "failureReason": "some other reason"}
\`\`\`
      `);

      const result = analyzeClaudeResponse(message, emptyExpectedActions, 0);

      expect(result.isComplete).toBe(true);
      expect(result.isSuccess).toBe(false);
      expect(result.failureReason).toBe('unknown');
    });

    it('should return unknown when failureReason is not provided', () => {
      const message = createMockMessage(`
\`\`\`json
{"status": "failure", "message": "Something failed"}
\`\`\`
      `);

      const result = analyzeClaudeResponse(message, emptyExpectedActions, 0);

      expect(result.isComplete).toBe(true);
      expect(result.isSuccess).toBe(false);
      expect(result.failureReason).toBe('unknown');
    });
  });

  describe('success handling', () => {
    it('should recognize success with all expected actions completed', () => {
      const message = createMockMessage(`
\`\`\`json
{"status": "success", "message": "Task completed"}
\`\`\`
      `);

      const expectedActions: ExpectedAction[] = [
        { description: 'Click button', keywords: ['click', 'button'], completed: true },
        { description: 'Enter text', keywords: ['enter', 'text'], completed: true },
      ];

      const result = analyzeClaudeResponse(message, expectedActions, 2);

      expect(result.isComplete).toBe(true);
      expect(result.isSuccess).toBe(true);
      expect(result.failureReason).toBeUndefined();
    });

    it('should mark as incomplete when expected actions not completed', () => {
      const message = createMockMessage(`
\`\`\`json
{"status": "success", "message": "Task completed"}
\`\`\`
      `);

      const expectedActions: ExpectedAction[] = [
        { description: 'Click button', keywords: ['click', 'button'], completed: true },
        { description: 'Enter text', keywords: ['enter', 'text'], completed: false },
      ];

      const result = analyzeClaudeResponse(message, expectedActions, 1);

      expect(result.isComplete).toBe(true);
      expect(result.isSuccess).toBe(false);
      expect(result.failureReason).toBe('incomplete_actions');
    });
  });
});
