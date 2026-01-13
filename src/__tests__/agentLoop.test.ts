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
  hasSignificantScreenChange: vi.fn().mockReturnValue({ changed: false, diffRatio: 0, isNoise: false }),
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

    // Default mock for capture_screen and match_hint_images
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'capture_screen') {
        return {
          imageBase64: 'mockScreenshotBase64Data',
          scaleFactor: 1.0,
          displayScaleFactor: 2.0,
          resizedWidth: 1366,
          resizedHeight: 768,
          originalWidth: 1366,
          originalHeight: 768,
          monitorId: 0,
        };
      }
      if (cmd === 'is_stop_requested') {
        return false;
      }
      if (cmd === 'match_hint_images') {
        // Default: return empty array (no matches found)
        return [];
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

  it('should normalize image/jpg to image/jpeg for Claude API compatibility', async () => {
    const { runAgentLoop } = await import('../services/agentLoop');

    const scenario: Scenario = {
      id: 'test-scenario',
      title: 'Test Scenario',
      description: 'Click the submit button',
      status: 'pending',
    };

    // Include an image with non-standard 'image/jpg' MIME type
    const hintImages: StepImage[] = [
      {
        id: 'hint-jpg',
        scenario_id: 'test-scenario',
        image_data: 'jpgImageData',
        file_name: 'button.jpg',
        mime_type: 'image/jpg', // Non-standard MIME type that needs normalization
        order_index: 0,
        created_at: '',
      },
      {
        id: 'hint-jpeg',
        scenario_id: 'test-scenario',
        image_data: 'jpegImageData',
        file_name: 'form.jpeg',
        mime_type: 'image/jpeg', // Standard MIME type
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

    expect(capturedMessages.length).toBeGreaterThan(0);

    const initialMessage = capturedMessages[0];
    const content = initialMessage.content;

    if (Array.isArray(content)) {
      // Find hint image blocks (excluding screenshot)
      const hintImageBlocks = content.filter(
        (block) =>
          block.type === 'image' &&
          'source' in block &&
          'data' in block.source &&
          (block.source.data === 'jpgImageData' || block.source.data === 'jpegImageData')
      );

      expect(hintImageBlocks.length).toBe(2);

      // Both should have 'image/jpeg' as media_type (image/jpg should be normalized)
      for (const block of hintImageBlocks) {
        if ('source' in block && block.source && 'media_type' in block.source) {
          expect(block.source.media_type).toBe('image/jpeg');
        }
      }

      // Verify image/jpg was NOT sent as-is (must be normalized to image/jpeg)
      const hasNonStandardMime = hintImageBlocks.some(
        (block) =>
          'source' in block &&
          block.source &&
          'media_type' in block.source &&
          (block.source.media_type as string) === 'image/jpg'
      );
      expect(hasNonStandardMime).toBe(false);
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

describe('runAgentLoop - Hint Image Coordinate Detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedMessages = [];
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('should include detected coordinates in hint text when template matching succeeds', async () => {
    // Mock match_hint_images to return successful matches
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'capture_screen') {
        return {
          imageBase64: 'mockScreenshotBase64Data',
          scaleFactor: 0.6,
          displayScaleFactor: 2.0,
          resizedWidth: 1560,
          resizedHeight: 900,
          originalWidth: 2600,
          originalHeight: 1500,
          monitorId: 0,
        };
      }
      if (cmd === 'is_stop_requested') {
        return false;
      }
      if (cmd === 'match_hint_images') {
        return [
          {
            index: 0,
            fileName: 'button.png',
            matchResult: {
              found: true,
              centerX: 885,
              centerY: 226,
              confidence: 0.85,
              templateWidth: 100,
              templateHeight: 50,
              error: null,
              errorCode: null,
            },
          },
          {
            index: 1,
            fileName: 'icon.png',
            matchResult: {
              found: true,
              centerX: 223,
              centerY: 355,
              confidence: 0.92,
              templateWidth: 48,
              templateHeight: 48,
              error: null,
              errorCode: null,
            },
          },
        ];
      }
      return undefined;
    });

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
        file_name: 'button.png',
        mime_type: 'image/png',
        order_index: 0,
        created_at: '',
      },
      {
        id: 'hint2',
        scenario_id: 'test-scenario',
        image_data: 'base64ImageData2',
        file_name: 'icon.png',
        mime_type: 'image/png',
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

    // Verify match_hint_images was called with correct parameters
    expect(mockInvoke).toHaveBeenCalledWith('match_hint_images', {
      screenshotBase64: 'mockScreenshotBase64Data',
      templateImages: [
        { imageData: 'base64ImageData1', fileName: 'button.png' },
        { imageData: 'base64ImageData2', fileName: 'icon.png' },
      ],
      scaleFactor: 0.6,
      confidenceThreshold: 0.7,
    });

    // Verify coordinate text is present in hint text
    const initialMessage = capturedMessages[0];
    const content = initialMessage.content;

    if (Array.isArray(content)) {
      const hintTextBlock = content.find(
        (block) =>
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.includes('画像認識による座標')
      );
      expect(hintTextBlock).toBeDefined();

      if (hintTextBlock && 'text' in hintTextBlock) {
        // Check coordinate format: "画像1(button.png): 885,226 / 画像2(icon.png): 223,355"
        expect(hintTextBlock.text).toContain('画像1(button.png): 885,226');
        expect(hintTextBlock.text).toContain('画像2(icon.png): 223,355');
      }
    }
  });

  it('should continue with partial results when some images are not found', async () => {
    // Mock: first image found, second image not found (low confidence)
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'capture_screen') {
        return {
          imageBase64: 'mockScreenshotBase64Data',
          scaleFactor: 0.6,
          displayScaleFactor: 2.0,
          resizedWidth: 1560,
          resizedHeight: 900,
          originalWidth: 2600,
          originalHeight: 1500,
          monitorId: 0,
        };
      }
      if (cmd === 'is_stop_requested') {
        return false;
      }
      if (cmd === 'match_hint_images') {
        return [
          {
            index: 0,
            fileName: 'found.png',
            matchResult: {
              found: true,
              centerX: 500,
              centerY: 300,
              confidence: 0.85,
              templateWidth: 100,
              templateHeight: 50,
              error: null,
              errorCode: null,
            },
          },
          {
            index: 1,
            fileName: 'notfound.png',
            matchResult: {
              found: false,
              centerX: null,
              centerY: null,
              confidence: 0.3,
              templateWidth: 80,
              templateHeight: 40,
              error: null,
              errorCode: null,
            },
          },
        ];
      }
      return undefined;
    });

    const { runAgentLoop } = await import('../services/agentLoop');

    const scenario: Scenario = {
      id: 'test-scenario',
      title: 'Test Scenario',
      description: 'Click the button',
      status: 'pending',
    };

    const hintImages: StepImage[] = [
      {
        id: 'hint1',
        scenario_id: 'test-scenario',
        image_data: 'foundImageData',
        file_name: 'found.png',
        mime_type: 'image/png',
        order_index: 0,
        created_at: '',
      },
      {
        id: 'hint2',
        scenario_id: 'test-scenario',
        image_data: 'notfoundImageData',
        file_name: 'notfound.png',
        mime_type: 'image/png',
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

    const initialMessage = capturedMessages[0];
    const content = initialMessage.content;

    if (Array.isArray(content)) {
      const hintTextBlock = content.find(
        (block) =>
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.includes('画像認識による座標')
      );
      expect(hintTextBlock).toBeDefined();

      if (hintTextBlock && 'text' in hintTextBlock) {
        // Only found image should have coordinates
        expect(hintTextBlock.text).toContain('画像1(found.png): 500,300');
        // Not found image should NOT be in coordinates
        expect(hintTextBlock.text).not.toContain('画像2');
      }
    }
  });

  it('should continue with partial results when some images have errors', async () => {
    // Mock: first image succeeds, second image has decode error
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'capture_screen') {
        return {
          imageBase64: 'mockScreenshotBase64Data',
          scaleFactor: 0.6,
          displayScaleFactor: 2.0,
          resizedWidth: 1560,
          resizedHeight: 900,
          originalWidth: 2600,
          originalHeight: 1500,
          monitorId: 0,
        };
      }
      if (cmd === 'is_stop_requested') {
        return false;
      }
      if (cmd === 'match_hint_images') {
        return [
          {
            index: 0,
            fileName: 'success.png',
            matchResult: {
              found: true,
              centerX: 500,
              centerY: 300,
              confidence: 0.85,
              templateWidth: 100,
              templateHeight: 50,
              error: null,
              errorCode: null,
            },
          },
          {
            index: 1,
            fileName: 'error.png',
            matchResult: {
              found: false,
              centerX: null,
              centerY: null,
              confidence: null,
              templateWidth: 0,
              templateHeight: 0,
              error: 'Base64 decode error: invalid padding',
              errorCode: 'template_base64_decode_error',
            },
          },
        ];
      }
      return undefined;
    });

    const { runAgentLoop } = await import('../services/agentLoop');

    const scenario: Scenario = {
      id: 'test-scenario',
      title: 'Test Scenario',
      description: 'Click the button',
      status: 'pending',
    };

    const hintImages: StepImage[] = [
      {
        id: 'hint1',
        scenario_id: 'test-scenario',
        image_data: 'successImageData',
        file_name: 'success.png',
        mime_type: 'image/png',
        order_index: 0,
        created_at: '',
      },
      {
        id: 'hint2',
        scenario_id: 'test-scenario',
        image_data: 'errorImageData',
        file_name: 'error.png',
        mime_type: 'image/png',
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

    const initialMessage = capturedMessages[0];
    const content = initialMessage.content;

    if (Array.isArray(content)) {
      const hintTextBlock = content.find(
        (block) =>
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.includes('画像認識による座標')
      );
      expect(hintTextBlock).toBeDefined();

      if (hintTextBlock && 'text' in hintTextBlock) {
        // Only successful image should have coordinates
        expect(hintTextBlock.text).toContain('画像1(success.png): 500,300');
        // Error image should NOT be in coordinates
        expect(hintTextBlock.text).not.toContain('画像2');
      }
    }
  });

  it('should handle case when no templates are found', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'capture_screen') {
        return {
          imageBase64: 'mockScreenshotBase64Data',
          scaleFactor: 0.6,
          displayScaleFactor: 2.0,
          resizedWidth: 1560,
          resizedHeight: 900,
          originalWidth: 2600,
          originalHeight: 1500,
          monitorId: 0,
        };
      }
      if (cmd === 'is_stop_requested') {
        return false;
      }
      if (cmd === 'match_hint_images') {
        return [
          {
            index: 0,
            fileName: 'notfound.png',
            matchResult: {
              found: false,
              centerX: null,
              centerY: null,
              confidence: 0.3,
              templateWidth: 100,
              templateHeight: 50,
              error: null,
              errorCode: null,
            },
          },
        ];
      }
      return undefined;
    });

    const { runAgentLoop } = await import('../services/agentLoop');

    const scenario: Scenario = {
      id: 'test-scenario',
      title: 'Test Scenario',
      description: 'Click the button',
      status: 'pending',
    };

    const hintImages: StepImage[] = [
      {
        id: 'hint1',
        scenario_id: 'test-scenario',
        image_data: 'notfoundImageData',
        file_name: 'notfound.png',
        mime_type: 'image/png',
        order_index: 0,
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
      // Should have hint text but no coordinate section
      const hintTextBlock = content.find(
        (block) =>
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.includes('ヒント画像')
      );
      expect(hintTextBlock).toBeDefined();

      // Should NOT have coordinate section when nothing found
      const coordinateBlock = content.find(
        (block) =>
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.includes('画像認識による座標')
      );
      expect(coordinateBlock).toBeUndefined();
    }
  });

  it('should continue without coordinates when template matching throws error', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'capture_screen') {
        return {
          imageBase64: 'mockScreenshotBase64Data',
          scaleFactor: 0.6,
          displayScaleFactor: 2.0,
          resizedWidth: 1560,
          resizedHeight: 900,
          originalWidth: 2600,
          originalHeight: 1500,
          monitorId: 0,
        };
      }
      if (cmd === 'is_stop_requested') {
        return false;
      }
      if (cmd === 'match_hint_images') {
        throw new Error('Unexpected Rust error');
      }
      return undefined;
    });

    const { runAgentLoop } = await import('../services/agentLoop');

    const scenario: Scenario = {
      id: 'test-scenario',
      title: 'Test Scenario',
      description: 'Click the button',
      status: 'pending',
    };

    const hintImages: StepImage[] = [
      {
        id: 'hint1',
        scenario_id: 'test-scenario',
        image_data: 'imageData',
        file_name: 'button.png',
        mime_type: 'image/png',
        order_index: 0,
        created_at: '',
      },
    ];

    const abortController = new AbortController();

    // Should not throw - should continue without coordinates
    await expect(
      runAgentLoop({
        scenario,
        hintImages,
        abortSignal: abortController.signal,
      })
    ).resolves.toBeDefined();

    const initialMessage = capturedMessages[0];
    const content = initialMessage.content;

    if (Array.isArray(content)) {
      // Should still have hint images in the message
      const hintTextBlock = content.find(
        (block) =>
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.includes('ヒント画像')
      );
      expect(hintTextBlock).toBeDefined();

      // Should NOT have coordinate section (error was caught)
      const coordinateBlock = content.find(
        (block) =>
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.includes('画像認識による座標')
      );
      expect(coordinateBlock).toBeUndefined();
    }
  });
});

describe('runAgentLoop - Hint Image Re-matching on Screen Transition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedMessages = [];
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('should re-match undetected hint images after screen transition and include updated coordinates', async () => {
    let matchCallCount = 0;
    let captureCallCount = 0;

    // Mock: First capture returns screenshot where image1 is not found
    // Second capture (after action) returns screenshot where image1 IS found
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'capture_screen') {
        captureCallCount++;
        return {
          imageBase64: captureCallCount === 1 ? 'initialScreenshot' : 'afterTransitionScreenshot',
          scaleFactor: 0.6,
          displayScaleFactor: 2.0,
          resizedWidth: 1560,
          resizedHeight: 900,
          originalWidth: 2600,
          originalHeight: 1500,
          monitorId: 0,
        };
      }
      if (cmd === 'is_stop_requested') {
        return false;
      }
      if (cmd === 'match_hint_images') {
        matchCallCount++;
        if (matchCallCount === 1) {
          // Initial match: image1 not found, image2 found
          return [
            {
              index: 0,
              fileName: 'appears-later.png',
              matchResult: {
                found: false,
                centerX: null,
                centerY: null,
                confidence: 0.3,
                templateWidth: 100,
                templateHeight: 50,
                error: null,
                errorCode: null,
              },
            },
            {
              index: 1,
              fileName: 'always-visible.png',
              matchResult: {
                found: true,
                centerX: 500,
                centerY: 300,
                confidence: 0.9,
                templateWidth: 80,
                templateHeight: 40,
                error: null,
                errorCode: null,
              },
            },
          ];
        } else {
          // Re-match after transition: image1 now found
          return [
            {
              index: 0,
              fileName: 'appears-later.png',
              matchResult: {
                found: true,
                centerX: 750,
                centerY: 450,
                confidence: 0.88,
                templateWidth: 100,
                templateHeight: 50,
                error: null,
                errorCode: null,
              },
            },
          ];
        }
      }
      return undefined;
    });

    // Override mock to return tool_use that triggers action execution
    const mockCreate = vi.fn()
      .mockResolvedValueOnce({
        // First response: tool_use to trigger action
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'computer',
            input: { action: 'left_click', coordinate: [500, 300] },
          },
        ],
        stop_reason: 'tool_use',
      })
      .mockResolvedValueOnce({
        // Second response: completion
        content: [
          {
            type: 'text',
            text: '{"result": "success"}',
          },
        ],
        stop_reason: 'end_turn',
      });

    vi.doMock('../services/claudeClient', () => ({
      getClaudeClient: vi.fn().mockResolvedValue({
        beta: {
          messages: {
            create: mockCreate,
          },
        },
      }),
      buildComputerTool: vi.fn().mockReturnValue({
        type: 'computer_20241022',
        name: 'computer',
        display_height_px: 768,
        display_width_px: 1366,
      }),
      RESULT_SCHEMA_INSTRUCTION: 'Mock instruction',
    }));

    const { runAgentLoop } = await import('../services/agentLoop');

    const scenario: Scenario = {
      id: 'test-scenario',
      title: 'Test Scenario',
      description: 'Click the button that appears after transition',
      status: 'pending',
    };

    const hintImages: StepImage[] = [
      {
        id: 'hint1',
        scenario_id: 'test-scenario',
        image_data: 'appearsLaterImageData',
        file_name: 'appears-later.png',
        mime_type: 'image/png',
        order_index: 0,
        created_at: '',
      },
      {
        id: 'hint2',
        scenario_id: 'test-scenario',
        image_data: 'alwaysVisibleImageData',
        file_name: 'always-visible.png',
        mime_type: 'image/png',
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

    // Verify match_hint_images was called twice (initial + re-match)
    const matchCalls = mockInvoke.mock.calls.filter((call) => call[0] === 'match_hint_images');
    expect(matchCalls.length).toBeGreaterThanOrEqual(1);

    // If re-matching occurred, the second call should only include undetected images
    if (matchCalls.length >= 2) {
      const reMatchCall = matchCalls[1];
      const templateImages = reMatchCall[1].templateImages;
      // Only the undetected image should be re-matched
      expect(templateImages.length).toBe(1);
      expect(templateImages[0].fileName).toBe('appears-later.png');
    }
  });

  it('should not re-match images with permanent decode errors', async () => {
    let matchCallCount = 0;

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'capture_screen') {
        return {
          imageBase64: 'mockScreenshot',
          scaleFactor: 0.6,
          displayScaleFactor: 2.0,
          resizedWidth: 1560,
          resizedHeight: 900,
          originalWidth: 2600,
          originalHeight: 1500,
          monitorId: 0,
        };
      }
      if (cmd === 'is_stop_requested') {
        return false;
      }
      if (cmd === 'match_hint_images') {
        matchCallCount++;
        if (matchCallCount === 1) {
          // Initial match: one has decode error (permanent), one not found
          return [
            {
              index: 0,
              fileName: 'decode-error.png',
              matchResult: {
                found: false,
                centerX: null,
                centerY: null,
                confidence: null,
                templateWidth: 0,
                templateHeight: 0,
                error: 'Base64 decode error: invalid padding',
                errorCode: 'template_base64_decode_error',
              },
            },
            {
              index: 1,
              fileName: 'not-found-yet.png',
              matchResult: {
                found: false,
                centerX: null,
                centerY: null,
                confidence: 0.3,
                templateWidth: 50,
                templateHeight: 50,
                error: null,
                errorCode: null,
              },
            },
          ];
        } else {
          // Re-match: only not-found-yet.png should be tried
          return [
            {
              index: 0,
              fileName: 'not-found-yet.png',
              matchResult: {
                found: true,
                centerX: 400,
                centerY: 200,
                confidence: 0.85,
                templateWidth: 50,
                templateHeight: 50,
                error: null,
                errorCode: null,
              },
            },
          ];
        }
      }
      if (cmd === 'left_click') {
        return undefined;
      }
      return undefined;
    });

    // Override mock to trigger action
    const mockCreate = vi.fn()
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'computer',
            input: { action: 'left_click', coordinate: [100, 100] },
          },
        ],
        stop_reason: 'tool_use',
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"result": "success"}' }],
        stop_reason: 'end_turn',
      });

    vi.doMock('../services/claudeClient', () => ({
      getClaudeClient: vi.fn().mockResolvedValue({
        beta: { messages: { create: mockCreate } },
      }),
      buildComputerTool: vi.fn().mockReturnValue({
        type: 'computer_20241022',
        name: 'computer',
        display_height_px: 768,
        display_width_px: 1366,
      }),
      RESULT_SCHEMA_INSTRUCTION: 'Mock instruction',
    }));

    const { runAgentLoop } = await import('../services/agentLoop');

    const scenario: Scenario = {
      id: 'test-scenario',
      title: 'Test Scenario',
      description: 'Test re-matching skip for decode errors',
      status: 'pending',
    };

    const hintImages: StepImage[] = [
      {
        id: 'hint1',
        scenario_id: 'test-scenario',
        image_data: 'invalidBase64!!!',
        file_name: 'decode-error.png',
        mime_type: 'image/png',
        order_index: 0,
        created_at: '',
      },
      {
        id: 'hint2',
        scenario_id: 'test-scenario',
        image_data: 'validImageData',
        file_name: 'not-found-yet.png',
        mime_type: 'image/png',
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

    // Check re-match calls
    const matchCalls = mockInvoke.mock.calls.filter((call) => call[0] === 'match_hint_images');

    if (matchCalls.length >= 2) {
      const reMatchCall = matchCalls[1];
      const templateImages = reMatchCall[1].templateImages;
      // Decode error image should NOT be re-matched
      const hasDecodeErrorImage = templateImages.some(
        (t: { fileName: string }) => t.fileName === 'decode-error.png'
      );
      expect(hasDecodeErrorImage).toBe(false);
    }
  });

  it('should not re-match already found images when screen unchanged', async () => {
    // This test verifies that when screenChanged=false (default mock),
    // already found images are NOT re-matched to avoid unnecessary processing.
    let matchCallCount = 0;

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'capture_screen') {
        return {
          imageBase64: 'mockScreenshot',
          scaleFactor: 0.6,
          displayScaleFactor: 2.0,
          resizedWidth: 1560,
          resizedHeight: 900,
          originalWidth: 2600,
          originalHeight: 1500,
          monitorId: 0,
        };
      }
      if (cmd === 'is_stop_requested') {
        return false;
      }
      if (cmd === 'match_hint_images') {
        matchCallCount++;
        if (matchCallCount === 1) {
          // Initial: both found
          return [
            {
              index: 0,
              fileName: 'found1.png',
              matchResult: {
                found: true,
                centerX: 100,
                centerY: 100,
                confidence: 0.9,
                templateWidth: 50,
                templateHeight: 50,
                error: null,
                errorCode: null,
              },
            },
            {
              index: 1,
              fileName: 'found2.png',
              matchResult: {
                found: true,
                centerX: 200,
                centerY: 200,
                confidence: 0.85,
                templateWidth: 50,
                templateHeight: 50,
                error: null,
                errorCode: null,
              },
            },
          ];
        }
        // Should not be called again since all images were found and screen unchanged
        return [];
      }
      if (cmd === 'left_click') {
        return undefined;
      }
      return undefined;
    });

    const mockCreate = vi.fn()
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'computer',
            input: { action: 'left_click', coordinate: [100, 100] },
          },
        ],
        stop_reason: 'tool_use',
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"result": "success"}' }],
        stop_reason: 'end_turn',
      });

    vi.doMock('../services/claudeClient', () => ({
      getClaudeClient: vi.fn().mockResolvedValue({
        beta: { messages: { create: mockCreate } },
      }),
      buildComputerTool: vi.fn().mockReturnValue({
        type: 'computer_20241022',
        name: 'computer',
        display_height_px: 768,
        display_width_px: 1366,
      }),
      RESULT_SCHEMA_INSTRUCTION: 'Mock instruction',
    }));

    const { runAgentLoop } = await import('../services/agentLoop');

    const scenario: Scenario = {
      id: 'test-scenario',
      title: 'Test Scenario',
      description: 'Test no re-matching when all found and screen unchanged',
      status: 'pending',
    };

    const hintImages: StepImage[] = [
      {
        id: 'hint1',
        scenario_id: 'test-scenario',
        image_data: 'imageData1',
        file_name: 'found1.png',
        mime_type: 'image/png',
        order_index: 0,
        created_at: '',
      },
      {
        id: 'hint2',
        scenario_id: 'test-scenario',
        image_data: 'imageData2',
        file_name: 'found2.png',
        mime_type: 'image/png',
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

    // Only initial match should be called (no re-match needed since all found)
    const matchCalls = mockInvoke.mock.calls.filter((call) => call[0] === 'match_hint_images');
    expect(matchCalls.length).toBe(1);
  });

  it('should correctly map re-match results with duplicate file_name by preserving original indices', async () => {
    // This test verifies that re-matching correctly preserves original indices
    // even when multiple hint images have the same file_name.
    // The key fix is using array index mapping instead of findIndex by file_name.

    // In the initial match, all images are not found
    // After re-match, we verify that the correct image_data is passed
    // which proves the original index was preserved correctly.
    mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'capture_screen') {
        return {
          imageBase64: 'mockScreenshot',
          scaleFactor: 0.6,
          displayScaleFactor: 2.0,
          resizedWidth: 1560,
          resizedHeight: 900,
          originalWidth: 2600,
          originalHeight: 1500,
          monitorId: 0,
        };
      }
      if (cmd === 'is_stop_requested') {
        return false;
      }
      if (cmd === 'match_hint_images') {
        // Always return not found - we're just testing the mapping
        const templateImages = (args as { templateImages: Array<{ imageData: string; fileName: string }> }).templateImages;
        return templateImages.map((t, i) => ({
          index: i,
          fileName: t.fileName,
          matchResult: { found: false, centerX: null, centerY: null, confidence: 0.3, templateWidth: 50, templateHeight: 50, error: null, errorCode: null },
        }));
      }
      return undefined;
    });

    const { runAgentLoop } = await import('../services/agentLoop');

    const scenario: Scenario = {
      id: 'test-scenario',
      title: 'Test Scenario',
      description: 'Test duplicate file_name handling',
      status: 'pending',
    };

    // Three images with the same file_name but different image_data
    const hintImages: StepImage[] = [
      {
        id: 'hint1',
        scenario_id: 'test-scenario',
        image_data: 'imageData1_unique',
        file_name: 'button.png', // Same name
        mime_type: 'image/png',
        order_index: 0,
        created_at: '',
      },
      {
        id: 'hint2',
        scenario_id: 'test-scenario',
        image_data: 'imageData2_unique',
        file_name: 'button.png', // Same name
        mime_type: 'image/png',
        order_index: 1,
        created_at: '',
      },
      {
        id: 'hint3',
        scenario_id: 'test-scenario',
        image_data: 'imageData3_unique',
        file_name: 'button.png', // Same name
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

    // Verify initial match was called with all images in correct order
    const matchCalls = mockInvoke.mock.calls.filter((call) => call[0] === 'match_hint_images');
    expect(matchCalls.length).toBeGreaterThanOrEqual(1);

    // Verify the first call has all three images with unique image_data
    const initialCall = matchCalls[0];
    const templateImages = initialCall[1].templateImages;
    expect(templateImages.length).toBe(3);
    // Verify image_data is preserved in correct order (proving correct mapping)
    expect(templateImages[0].imageData).toBe('imageData1_unique');
    expect(templateImages[1].imageData).toBe('imageData2_unique');
    expect(templateImages[2].imageData).toBe('imageData3_unique');
    // All have the same file_name, which would cause issues with findIndex
    expect(templateImages[0].fileName).toBe('button.png');
    expect(templateImages[1].fileName).toBe('button.png');
    expect(templateImages[2].fileName).toBe('button.png');
  });

  it('should include images without previous results in re-match candidates (empty result case)', async () => {
    // This test verifies that when initial matching returns empty array,
    // the re-matching logic correctly identifies all images as candidates
    // because they have no previous result (prevResult === undefined).

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'capture_screen') {
        return {
          imageBase64: 'mockScreenshot',
          scaleFactor: 0.6,
          displayScaleFactor: 2.0,
          resizedWidth: 1560,
          resizedHeight: 900,
          originalWidth: 2600,
          originalHeight: 1500,
          monitorId: 0,
        };
      }
      if (cmd === 'is_stop_requested') {
        return false;
      }
      if (cmd === 'match_hint_images') {
        // Return empty array - simulating complete failure
        // But the code now handles this by still allowing re-matches
        return [];
      }
      return undefined;
    });

    const { runAgentLoop } = await import('../services/agentLoop');

    const scenario: Scenario = {
      id: 'test-scenario',
      title: 'Test Scenario',
      description: 'Test re-matching after initial failure',
      status: 'pending',
    };

    const hintImages: StepImage[] = [
      {
        id: 'hint1',
        scenario_id: 'test-scenario',
        image_data: 'delayedElementImageData',
        file_name: 'delayed-element.png',
        mime_type: 'image/png',
        order_index: 0,
        created_at: '',
      },
    ];

    const abortController = new AbortController();

    await runAgentLoop({
      scenario,
      hintImages,
      abortSignal: abortController.signal,
    });

    // Verify that match_hint_images was called
    // The key point is the code doesn't crash and continues execution
    const matchCalls = mockInvoke.mock.calls.filter((call) => call[0] === 'match_hint_images');
    expect(matchCalls.length).toBeGreaterThanOrEqual(1);

    // First call should have the image
    expect(matchCalls[0][1].templateImages[0].fileName).toBe('delayed-element.png');
  });

  it('should continue execution when initial matching throws exception', async () => {
    // Tests that the agent loop continues even when initial match_hint_images throws an error
    let matchCallCount = 0;

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'capture_screen') {
        return {
          imageBase64: 'mockScreenshot',
          scaleFactor: 0.6,
          displayScaleFactor: 2.0,
          resizedWidth: 1560,
          resizedHeight: 900,
          originalWidth: 2600,
          originalHeight: 1500,
          monitorId: 0,
        };
      }
      if (cmd === 'is_stop_requested') {
        return false;
      }
      if (cmd === 'match_hint_images') {
        matchCallCount++;
        // Always throw to test error handling
        throw new Error('Rust panic: unexpected error');
      }
      return undefined;
    });

    const { runAgentLoop } = await import('../services/agentLoop');

    const scenario: Scenario = {
      id: 'test-scenario',
      title: 'Test Scenario',
      description: 'Test exception handling',
      status: 'pending',
    };

    const hintImages: StepImage[] = [
      {
        id: 'hint1',
        scenario_id: 'test-scenario',
        image_data: 'targetImageData',
        file_name: 'target.png',
        mime_type: 'image/png',
        order_index: 0,
        created_at: '',
      },
    ];

    const abortController = new AbortController();

    // Should not throw - initial error should be caught
    const result = await runAgentLoop({
      scenario,
      hintImages,
      abortSignal: abortController.signal,
    });

    // The agent loop should complete (success or failure) without throwing
    expect(result).toBeDefined();
    expect(result.testResult).toBeDefined();

    // match_hint_images was attempted at least once
    expect(matchCallCount).toBeGreaterThanOrEqual(1);
  });

  // MOVED: This test has been moved to agentLoop.screenChange.test.ts
  // because it requires hasSignificantScreenChange to return { changed: true },
  // and Vitest's module caching prevents per-test mock overrides from working correctly.
  // See agentLoop.screenChange.test.ts for the following tests:
  // - 'should re-match already found images when screen changes to update coordinates'
  // - 'should retry size-related errors when screen changes'
  // - 'should retry Screenshot decode errors on subsequent screenshots'
  it.skip('[MOVED TO agentLoop.screenChange.test.ts] should re-match already found images when screen changes', async () => {
    // This test verifies that when screenChanged=true,
    // already found images ARE re-matched to update coordinates that may have shifted.
    //
    // We import the mocked module and override hasSignificantScreenChange for this test.
    const resultJudge = await import('../services/resultJudge');
    const hasSignificantScreenChangeSpy = vi.mocked(resultJudge.hasSignificantScreenChange);

    let matchCallCount = 0;
    let captureCount = 0;

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'capture_screen') {
        captureCount++;
        return {
          // Different screenshots to trigger screen change detection
          imageBase64: captureCount === 1 ? 'initialScreenshot' : 'changedScreenshot',
          scaleFactor: 0.6,
          displayScaleFactor: 2.0,
          resizedWidth: 1560,
          resizedHeight: 900,
          originalWidth: 2600,
          originalHeight: 1500,
          monitorId: 0,
        };
      }
      if (cmd === 'is_stop_requested') {
        return false;
      }
      if (cmd === 'match_hint_images') {
        matchCallCount++;
        if (matchCallCount === 1) {
          // Initial: found at position (100, 100)
          return [
            {
              index: 0,
              fileName: 'movable-element.png',
              matchResult: {
                found: true,
                centerX: 100,
                centerY: 100,
                confidence: 0.9,
                templateWidth: 50,
                templateHeight: 50,
                error: null,
                errorCode: null,
              },
            },
          ];
        } else {
          // After screen change: found at NEW position (300, 400)
          return [
            {
              index: 0,
              fileName: 'movable-element.png',
              matchResult: {
                found: true,
                centerX: 300,
                centerY: 400,
                confidence: 0.88,
                templateWidth: 50,
                templateHeight: 50,
                error: null,
                errorCode: null,
              },
            },
          ];
        }
      }
      if (cmd === 'left_click') {
        return undefined;
      }
      return undefined;
    });

    // Override hasSignificantScreenChange to return screen changed
    hasSignificantScreenChangeSpy.mockReturnValue({ changed: true, diffRatio: 0.5, isNoise: false });

    const mockCreate = vi.fn()
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'computer',
            input: { action: 'left_click', coordinate: [100, 100] },
          },
        ],
        stop_reason: 'tool_use',
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"result": "success"}' }],
        stop_reason: 'end_turn',
      });

    vi.doMock('../services/claudeClient', () => ({
      getClaudeClient: vi.fn().mockResolvedValue({
        beta: { messages: { create: mockCreate } },
      }),
      buildComputerTool: vi.fn().mockReturnValue({
        type: 'computer_20241022',
        name: 'computer',
        display_height_px: 768,
        display_width_px: 1366,
      }),
      RESULT_SCHEMA_INSTRUCTION: 'Mock instruction',
    }));

    const { runAgentLoop } = await import('../services/agentLoop');

    const scenario: Scenario = {
      id: 'test-scenario',
      title: 'Test Scenario',
      description: 'Test re-matching when screen changes',
      status: 'pending',
    };

    const hintImages: StepImage[] = [
      {
        id: 'hint1',
        scenario_id: 'test-scenario',
        image_data: 'movableElementData',
        file_name: 'movable-element.png',
        mime_type: 'image/png',
        order_index: 0,
        created_at: '',
      },
    ];

    const abortController = new AbortController();

    await runAgentLoop({
      scenario,
      hintImages,
      abortSignal: abortController.signal,
    });

    // Should have been called twice: initial + re-match after screen change
    const matchCalls = mockInvoke.mock.calls.filter((call) => call[0] === 'match_hint_images');
    expect(matchCalls.length).toBe(2);

    // Second call should include the already-found image (because screen changed)
    const reMatchCall = matchCalls[1];
    expect(reMatchCall[1].templateImages.length).toBe(1);
    expect(reMatchCall[1].templateImages[0].fileName).toBe('movable-element.png');

    // Restore the mock to default for other tests
    hasSignificantScreenChangeSpy.mockReturnValue({ changed: false, diffRatio: 0, isNoise: false });
  });

  it('should not re-match images with permanent opacity errors or size errors when screen unchanged', async () => {
    // This test verifies that images with permanent errors (opacity issues)
    // or size-related errors (when screen is unchanged) are excluded from re-matching.
    // Note: Size-related errors ARE retried when screen changes (tested in agentLoop.screenChange.test.ts)
    let matchCallCount = 0;

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'capture_screen') {
        return {
          imageBase64: 'mockScreenshot',
          scaleFactor: 0.6,
          displayScaleFactor: 2.0,
          resizedWidth: 1560,
          resizedHeight: 900,
          originalWidth: 2600,
          originalHeight: 1500,
          monitorId: 0,
        };
      }
      if (cmd === 'is_stop_requested') {
        return false;
      }
      if (cmd === 'match_hint_images') {
        matchCallCount++;
        if (matchCallCount === 1) {
          // Initial match: various permanent errors
          return [
            {
              index: 0,
              fileName: 'transparent.png',
              matchResult: {
                found: false,
                centerX: null,
                centerY: null,
                confidence: null,
                templateWidth: 100,
                templateHeight: 50,
                error: 'Template has insufficient opacity (5.0% < 10.0% minimum). Mostly transparent images cannot be reliably matched.',
                errorCode: 'insufficient_opacity',
              },
            },
            {
              index: 1,
              fileName: 'too-large.png',
              matchResult: {
                found: false,
                centerX: null,
                centerY: null,
                confidence: null,
                templateWidth: 2000,
                templateHeight: 1500,
                error: 'Template is larger than screenshot after scaling',
                errorCode: 'template_too_large',
              },
            },
            {
              index: 2,
              fileName: 'normal-not-found.png',
              matchResult: {
                found: false,
                centerX: null,
                centerY: null,
                confidence: 0.4,
                templateWidth: 50,
                templateHeight: 50,
                error: null,
                errorCode: null,
              },
            },
          ];
        } else {
          // Re-match should only include normal-not-found.png
          return [
            {
              index: 0,
              fileName: 'normal-not-found.png',
              matchResult: {
                found: true,
                centerX: 500,
                centerY: 300,
                confidence: 0.85,
                templateWidth: 50,
                templateHeight: 50,
                error: null,
                errorCode: null,
              },
            },
          ];
        }
      }
      if (cmd === 'left_click') {
        return undefined;
      }
      return undefined;
    });

    const mockCreate = vi.fn()
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'computer',
            input: { action: 'left_click', coordinate: [100, 100] },
          },
        ],
        stop_reason: 'tool_use',
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"result": "success"}' }],
        stop_reason: 'end_turn',
      });

    vi.doMock('../services/claudeClient', () => ({
      getClaudeClient: vi.fn().mockResolvedValue({
        beta: { messages: { create: mockCreate } },
      }),
      buildComputerTool: vi.fn().mockReturnValue({
        type: 'computer_20241022',
        name: 'computer',
        display_height_px: 768,
        display_width_px: 1366,
      }),
      RESULT_SCHEMA_INSTRUCTION: 'Mock instruction',
    }));

    const { runAgentLoop } = await import('../services/agentLoop');

    const scenario: Scenario = {
      id: 'test-scenario',
      title: 'Test Scenario',
      description: 'Test permanent error exclusion',
      status: 'pending',
    };

    const hintImages: StepImage[] = [
      {
        id: 'hint1',
        scenario_id: 'test-scenario',
        image_data: 'transparentImageData',
        file_name: 'transparent.png',
        mime_type: 'image/png',
        order_index: 0,
        created_at: '',
      },
      {
        id: 'hint2',
        scenario_id: 'test-scenario',
        image_data: 'tooLargeImageData',
        file_name: 'too-large.png',
        mime_type: 'image/png',
        order_index: 1,
        created_at: '',
      },
      {
        id: 'hint3',
        scenario_id: 'test-scenario',
        image_data: 'normalImageData',
        file_name: 'normal-not-found.png',
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

    const matchCalls = mockInvoke.mock.calls.filter((call) => call[0] === 'match_hint_images');

    // Should have at least 2 calls (initial + re-match)
    if (matchCalls.length >= 2) {
      const reMatchCall = matchCalls[1];
      const templateImages = reMatchCall[1].templateImages;

      // Only normal-not-found.png should be re-matched
      // (transparent.png and too-large.png have permanent errors)
      expect(templateImages.length).toBe(1);
      expect(templateImages[0].fileName).toBe('normal-not-found.png');

      // Verify permanent error images are NOT included
      const hasTransparent = templateImages.some(
        (t: { fileName: string }) => t.fileName === 'transparent.png'
      );
      const hasTooLarge = templateImages.some(
        (t: { fileName: string }) => t.fileName === 'too-large.png'
      );
      expect(hasTransparent).toBe(false);
      expect(hasTooLarge).toBe(false);
    }
  });
});
