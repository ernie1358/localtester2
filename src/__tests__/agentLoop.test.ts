/**
 * Agent Loop Tests
 * Tests for hint image message construction in runAgentLoop
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages';
import type { StepImage, Scenario } from '../types';

// Capture messages passed to Claude API
let capturedMessages: BetaMessageParam[] = [];

// Mock Tauri API
const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));

// Mock claudeClient
vi.mock('../services/claudeClient', () => ({
  getClaudeClient: vi.fn().mockResolvedValue({
    beta: {
      messages: {
        create: vi.fn().mockImplementation(async (params: { messages: BetaMessageParam[] }) => {
          // Capture the messages for inspection
          capturedMessages = params.messages;
          // Return a completion response (no tool use, indicates success)
          return {
            content: [
              {
                type: 'text',
                text: '{"result": "success", "details": "Test completed successfully"}',
              },
            ],
            stop_reason: 'end_turn',
          };
        }),
      },
    },
  }),
  buildComputerTool: vi.fn().mockReturnValue({
    type: 'computer_20241022',
    name: 'computer',
    display_height_px: 768,
    display_width_px: 1366,
    display_number: 1,
  }),
  RESULT_SCHEMA_INSTRUCTION: 'Mock instruction',
}));

// Mock actionValidator
vi.mock('../services/actionValidator', () => ({
  extractExpectedActions: vi.fn().mockResolvedValue({
    expectedActions: [{ description: 'Test action', completed: false }],
    isFromFallback: true,
  }),
  validateActionAndCheckProgress: vi.fn().mockReturnValue({
    confidence: 'high',
    shouldAdvanceIndex: false,
    requiresScreenChange: false,
    needsClaudeVerification: false,
  }),
  askClaudeForActionCompletion: vi.fn().mockResolvedValue({ isCompleted: false }),
}));

// Mock resultJudge
vi.mock('../services/resultJudge', () => ({
  analyzeClaudeResponse: vi.fn().mockReturnValue({
    isComplete: true,
    isSuccess: true,
    analysis: 'Test completed',
    successByProgress: true,
  }),
  checkProgress: vi.fn().mockReturnValue({ isStuck: false }),
  createTestResult: vi.fn().mockImplementation((params) => ({
    status: params.status,
    completedSteps: params.completedSteps,
  })),
  hasSignificantScreenChange: vi.fn().mockReturnValue({ changed: false, isNoise: false }),
  createProgressTracker: vi.fn().mockReturnValue({
    lastScreenshotHash: '',
    unchangedCount: 0,
    lastAction: null,
    sameActionCount: 0,
  }),
  DEFAULT_STUCK_DETECTION_CONFIG: {
    maxUnchangedScreenshots: 5,
    maxSameActionRepeats: 3,
  },
  mapExecutionErrorToFailureReason: vi.fn().mockReturnValue('action_execution_error'),
  verifyFallbackCompletion: vi.fn().mockResolvedValue({ isCompleted: true, confidence: 'high' }),
}));

// Mock historyManager
vi.mock('../services/historyManager', () => ({
  purgeOldImages: vi.fn().mockImplementation((messages) => messages),
}));

// Mock coordinateScaler
vi.mock('../utils/coordinateScaler', () => ({
  toScreenCoordinate: vi.fn().mockImplementation(({ x, y }) => ({ x, y })),
}));

// Mock loopDetector
vi.mock('../utils/loopDetector', () => ({
  detectLoop: vi.fn().mockReturnValue(false),
  createActionRecord: vi.fn().mockImplementation((id, action) => ({ id, action })),
}));

describe('runAgentLoop - Hint Image Message Construction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedMessages = [];

    // Default mock for capture_screen
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'capture_screen') {
        return {
          imageBase64: 'mockScreenshotBase64Data',
          scaleFactor: 1.0,
          displayScaleFactor: 2.0,
        };
      }
      if (cmd === 'is_stop_requested') {
        return false;
      }
      return undefined;
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('should include hint images in initial message content', async () => {
    const { runAgentLoop } = await import('../services/agentLoop');

    const scenario: Scenario = {
      id: 'test-scenario',
      title: 'Test Scenario',
      description: 'Click the submit button',
      status: 'pending',
    };

    const hintImages: StepImage[] = [
      {
        id: 'hint1',
        scenario_id: 'test-scenario',
        image_data: 'base64ImageData1',
        file_name: 'submit-button.png',
        mime_type: 'image/png',
        order_index: 0,
        created_at: '',
      },
      {
        id: 'hint2',
        scenario_id: 'test-scenario',
        image_data: 'base64ImageData2',
        file_name: 'form-area.jpeg',
        mime_type: 'image/jpeg',
        order_index: 1,
        created_at: '',
      },
    ];

    const abortController = new AbortController();

    await runAgentLoop({
      scenario,
      hintImages,
      abortSignal: abortController.signal,
    });

    // Verify initial message was captured
    expect(capturedMessages.length).toBeGreaterThan(0);

    const initialMessage = capturedMessages[0];
    expect(initialMessage.role).toBe('user');

    // Verify content is an array
    const content = initialMessage.content;
    expect(Array.isArray(content)).toBe(true);

    if (Array.isArray(content)) {
      // Should have: scenario text, screenshot, hint text, hint image 1, hint image 2
      // At minimum 5 items (text + screenshot + hint text + 2 hint images)
      expect(content.length).toBeGreaterThanOrEqual(5);

      // Find hint text block
      const hintTextBlock = content.find(
        (block) =>
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.includes('ヒント画像')
      );
      expect(hintTextBlock).toBeDefined();

      // Find hint image blocks
      const imageBlocks = content.filter(
        (block) =>
          block.type === 'image' &&
          'source' in block &&
          block.source.type === 'base64'
      );

      // Should have at least 3 images: screenshot + 2 hint images
      expect(imageBlocks.length).toBeGreaterThanOrEqual(3);

      // Verify hint images are present with correct data
      const hintImageDatas = imageBlocks.map((b) => {
        if ('source' in b && b.source && 'data' in b.source) {
          return b.source.data;
        }
        return '';
      });
      expect(hintImageDatas).toContain('base64ImageData1');
      expect(hintImageDatas).toContain('base64ImageData2');

      // Verify mime types are correctly passed
      const hintImageTypes = imageBlocks.map((b) => {
        if ('source' in b && b.source && 'media_type' in b.source) {
          return b.source.media_type;
        }
        return '';
      });
      expect(hintImageTypes).toContain('image/png');
      expect(hintImageTypes).toContain('image/jpeg');
    }
  });

  it('should not include hint text block when no hint images provided', async () => {
    const { runAgentLoop } = await import('../services/agentLoop');

    const scenario: Scenario = {
      id: 'test-scenario',
      title: 'Test Scenario',
      description: 'Click the submit button',
      status: 'pending',
    };

    const abortController = new AbortController();

    await runAgentLoop({
      scenario,
      hintImages: [],
      abortSignal: abortController.signal,
    });

    expect(capturedMessages.length).toBeGreaterThan(0);

    const initialMessage = capturedMessages[0];
    const content = initialMessage.content;

    if (Array.isArray(content)) {
      // Should NOT have hint text block
      const hintTextBlock = content.find(
        (block) =>
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.includes('ヒント画像')
      );
      expect(hintTextBlock).toBeUndefined();

      // Should only have: scenario text + screenshot = 2 items
      expect(content.length).toBe(2);
    }
  });

  it('should not include hint text block when hintImages is undefined', async () => {
    const { runAgentLoop } = await import('../services/agentLoop');

    const scenario: Scenario = {
      id: 'test-scenario',
      title: 'Test Scenario',
      description: 'Click the submit button',
      status: 'pending',
    };

    const abortController = new AbortController();

    await runAgentLoop({
      scenario,
      // hintImages not provided (undefined)
      abortSignal: abortController.signal,
    });

    expect(capturedMessages.length).toBeGreaterThan(0);

    const initialMessage = capturedMessages[0];
    const content = initialMessage.content;

    if (Array.isArray(content)) {
      // Should NOT have hint text block
      const hintTextBlock = content.find(
        (block) =>
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.includes('ヒント画像')
      );
      expect(hintTextBlock).toBeUndefined();
    }
  });

  it('should preserve hint image order based on array order', async () => {
    const { runAgentLoop } = await import('../services/agentLoop');

    const scenario: Scenario = {
      id: 'test-scenario',
      title: 'Test Scenario',
      description: 'Click the submit button',
      status: 'pending',
    };

    // Images with specific order
    const hintImages: StepImage[] = [
      {
        id: 'first',
        scenario_id: 'test-scenario',
        image_data: 'firstImageData',
        file_name: 'first.png',
        mime_type: 'image/png',
        order_index: 0,
        created_at: '',
      },
      {
        id: 'second',
        scenario_id: 'test-scenario',
        image_data: 'secondImageData',
        file_name: 'second.png',
        mime_type: 'image/png',
        order_index: 1,
        created_at: '',
      },
      {
        id: 'third',
        scenario_id: 'test-scenario',
        image_data: 'thirdImageData',
        file_name: 'third.png',
        mime_type: 'image/png',
        order_index: 2,
        created_at: '',
      },
    ];

    const abortController = new AbortController();

    await runAgentLoop({
      scenario,
      hintImages,
      abortSignal: abortController.signal,
    });

    const initialMessage = capturedMessages[0];
    const content = initialMessage.content;

    if (Array.isArray(content)) {
      // Find hint images (excluding the screenshot which is the first image)
      const imageBlocks = content.filter(
        (block) =>
          block.type === 'image' &&
          'source' in block &&
          'data' in block.source &&
          block.source.data !== 'mockScreenshotBase64Data'
      );

      // Verify order is preserved
      expect(imageBlocks.length).toBe(3);
      const getImageData = (block: unknown): string | undefined => {
        if (block && typeof block === 'object' && 'source' in block) {
          const source = (block as { source: unknown }).source;
          if (source && typeof source === 'object' && 'data' in source) {
            return (source as { data: string }).data;
          }
        }
        return undefined;
      };
      expect(getImageData(imageBlocks[0])).toBe('firstImageData');
      expect(getImageData(imageBlocks[1])).toBe('secondImageData');
      expect(getImageData(imageBlocks[2])).toBe('thirdImageData');
    }
  });
});
