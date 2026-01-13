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
