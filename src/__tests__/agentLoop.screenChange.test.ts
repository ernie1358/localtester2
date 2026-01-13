/**
 * Agent Loop Tests - Screen Change Scenarios
 * Tests for hint image re-matching when screen changes
 *
 * This test file is separate from agentLoop.test.ts because it requires
 * hasSignificantScreenChange to return { changed: true }, which conflicts
 * with the default mock in the main test file due to Vitest's module caching.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StepImage, Scenario } from '../types';

// Mock Tauri API
const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));

// Track API calls for assertions
const mockCreate = vi.fn();

// Mock claudeClient
vi.mock('../services/claudeClient', () => ({
  getClaudeClient: vi.fn().mockResolvedValue({
    beta: {
      messages: {
        create: (...args: unknown[]) => mockCreate(...args),
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

// Track analyzeClaudeResponse call count to simulate multi-iteration behavior
let analyzeCallCount = 0;

// Mock resultJudge with screen change returning TRUE
vi.mock('../services/resultJudge', () => ({
  analyzeClaudeResponse: vi.fn().mockImplementation(() => {
    analyzeCallCount++;
    // First iteration: not complete (need to continue)
    // Second iteration: complete
    if (analyzeCallCount >= 2) {
      return {
        isComplete: true,
        isSuccess: true,
        analysis: 'Test completed',
        successByProgress: true,
      };
    }
    return {
      isComplete: false,
      isSuccess: false,
      analysis: 'Continue testing',
      successByProgress: false,
    };
  }),
  checkProgress: vi.fn().mockReturnValue({ isStuck: false }),
  createTestResult: vi.fn().mockImplementation((params) => ({
    status: params.status,
    completedSteps: params.completedSteps,
  })),
  // KEY DIFFERENCE: This file mocks screen change as TRUE
  hasSignificantScreenChange: vi.fn().mockReturnValue({ changed: true, diffRatio: 0.5, isNoise: false }),
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

describe('runAgentLoop - Screen Change Re-matching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    analyzeCallCount = 0;
  });

  it('should re-match already found images when screen changes to update coordinates', async () => {
    // This test verifies that when screenChanged=true,
    // already found images ARE re-matched to update coordinates that may have shifted.
    let matchCallCount = 0;
    let captureCount = 0;

    // Setup Claude API mock - returns tool use repeatedly, then success
    let apiCallCount = 0;
    mockCreate.mockImplementation(() => {
      apiCallCount++;
      if (apiCallCount < 3) {
        // First two calls: tool use (triggers next iteration with new capture)
        return Promise.resolve({
          content: [
            {
              type: 'tool_use',
              id: `tool_${apiCallCount}`,
              name: 'computer',
              input: { action: 'left_click', coordinate: [100, 100] },
            },
          ],
          stop_reason: 'tool_use',
        });
      }
      // Third call: success (end loop)
      return Promise.resolve({
        content: [{ type: 'text', text: '{"result": "success"}' }],
        stop_reason: 'end_turn',
      });
    });

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
  });

  it('should retry size-related errors when screen changes', async () => {
    // This test verifies that images with "larger than screenshot" errors
    // are retried when the screen changes (resolution may have changed)
    let matchCallCount = 0;
    let captureCount = 0;

    // Setup Claude API mock - returns tool use repeatedly, then success
    let apiCallCount = 0;
    mockCreate.mockImplementation(() => {
      apiCallCount++;
      if (apiCallCount < 3) {
        return Promise.resolve({
          content: [
            {
              type: 'tool_use',
              id: `tool_${apiCallCount}`,
              name: 'computer',
              input: { action: 'left_click', coordinate: [100, 100] },
            },
          ],
          stop_reason: 'tool_use',
        });
      }
      return Promise.resolve({
        content: [{ type: 'text', text: '{"result": "success"}' }],
        stop_reason: 'end_turn',
      });
    });

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'capture_screen') {
        captureCount++;
        return {
          imageBase64: captureCount === 1 ? 'smallScreenshot' : 'largerScreenshot',
          scaleFactor: captureCount === 1 ? 0.3 : 0.6, // Different scale factor
          displayScaleFactor: 2.0,
          resizedWidth: captureCount === 1 ? 800 : 1600,
          resizedHeight: captureCount === 1 ? 600 : 1200,
          originalWidth: captureCount === 1 ? 1600 : 3200,
          originalHeight: captureCount === 1 ? 1200 : 2400,
          monitorId: 0,
        };
      }
      if (cmd === 'is_stop_requested') {
        return false;
      }
      if (cmd === 'match_hint_images') {
        matchCallCount++;
        if (matchCallCount === 1) {
          // Initial: template larger than screenshot
          return [
            {
              index: 0,
              fileName: 'large-template.png',
              matchResult: {
                found: false,
                centerX: null,
                centerY: null,
                confidence: null,
                templateWidth: 1000,
                templateHeight: 800,
                error: 'Template is larger than screenshot after scaling',
              },
            },
          ];
        } else {
          // After screen change: now fits and is found
          return [
            {
              index: 0,
              fileName: 'large-template.png',
              matchResult: {
                found: true,
                centerX: 500,
                centerY: 400,
                confidence: 0.85,
                templateWidth: 1000,
                templateHeight: 800,
                error: null,
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

    const { runAgentLoop } = await import('../services/agentLoop');

    const scenario: Scenario = {
      id: 'test-scenario',
      title: 'Test Scenario',
      description: 'Test size error retry on screen change',
      status: 'pending',
    };

    const hintImages: StepImage[] = [
      {
        id: 'hint1',
        scenario_id: 'test-scenario',
        image_data: 'largeTemplateData',
        file_name: 'large-template.png',
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

    // Should have been called twice: initial (size error) + re-match after screen change
    const matchCalls = mockInvoke.mock.calls.filter((call) => call[0] === 'match_hint_images');
    expect(matchCalls.length).toBe(2);

    // Second call should include the previously-failed image (because screen changed)
    const reMatchCall = matchCalls[1];
    expect(reMatchCall[1].templateImages.length).toBe(1);
    expect(reMatchCall[1].templateImages[0].fileName).toBe('large-template.png');
  });

  it('should retry Screenshot decode errors on subsequent screenshots', async () => {
    // This test verifies that Screenshot decode errors are NOT treated as permanent
    // and are retried on subsequent screenshots
    let matchCallCount = 0;
    let captureCount = 0;

    // Setup Claude API mock - returns tool use repeatedly, then success
    let apiCallCount = 0;
    mockCreate.mockImplementation(() => {
      apiCallCount++;
      if (apiCallCount < 3) {
        return Promise.resolve({
          content: [
            {
              type: 'tool_use',
              id: `tool_${apiCallCount}`,
              name: 'computer',
              input: { action: 'left_click', coordinate: [100, 100] },
            },
          ],
          stop_reason: 'tool_use',
        });
      }
      return Promise.resolve({
        content: [{ type: 'text', text: '{"result": "success"}' }],
        stop_reason: 'end_turn',
      });
    });

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'capture_screen') {
        captureCount++;
        return {
          // Different screenshots to trigger screen change
          imageBase64: captureCount === 1 ? 'screenshot1' : 'screenshot2',
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
          // Initial: screenshot decode error (transient)
          // Format matches Rust's actual error: "Screenshot decode error: Image processing error: Base64 decode error: ..."
          // This tests that screenshot decode errors containing "Base64 decode error" substring
          // are correctly identified as transient (not permanent) errors
          return [
            {
              index: 0,
              fileName: 'normal-image.png',
              matchResult: {
                found: false,
                centerX: null,
                centerY: null,
                confidence: null,
                templateWidth: 0,
                templateHeight: 0,
                error: 'Screenshot decode error: Image processing error: Base64 decode error: invalid base64',
              },
            },
          ];
        } else {
          // Retry succeeds
          return [
            {
              index: 0,
              fileName: 'normal-image.png',
              matchResult: {
                found: true,
                centerX: 200,
                centerY: 150,
                confidence: 0.9,
                templateWidth: 100,
                templateHeight: 80,
                error: null,
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

    const { runAgentLoop } = await import('../services/agentLoop');

    const scenario: Scenario = {
      id: 'test-scenario',
      title: 'Test Scenario',
      description: 'Test screenshot decode error retry',
      status: 'pending',
    };

    const hintImages: StepImage[] = [
      {
        id: 'hint1',
        scenario_id: 'test-scenario',
        image_data: 'normalImageData',
        file_name: 'normal-image.png',
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

    // Should have been called twice: initial (decode error) + re-match (screen changed)
    const matchCalls = mockInvoke.mock.calls.filter((call) => call[0] === 'match_hint_images');
    expect(matchCalls.length).toBe(2);
  });
});
