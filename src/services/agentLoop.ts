/**
 * Agent Loop - Execute a single scenario with Computer Use API
 * Enhanced with test result judgment (v18)
 */

import { invoke } from '@tauri-apps/api/core';
import type {
  BetaMessageParam,
  BetaMessage,
  BetaToolUseBlock,
  BetaToolResultBlockParam,
  BetaTextBlock,
} from '@anthropic-ai/sdk/resources/beta/messages';
import { getClaudeClient, buildComputerTool, RESULT_SCHEMA_INSTRUCTION } from './claudeClient';
import { purgeOldImages } from './historyManager';
import { toScreenCoordinate } from '../utils/coordinateScaler';
import { detectLoop, createActionRecord } from '../utils/loopDetector';
import {
  analyzeClaudeResponse,
  checkProgress,
  createTestResult,
  hasSignificantScreenChange,
  createProgressTracker,
  DEFAULT_STUCK_DETECTION_CONFIG,
  mapExecutionErrorToFailureReason,
  verifyFallbackCompletion,
} from './resultJudge';
import {
  extractExpectedActions,
  validateActionAndCheckProgress,
  askClaudeForActionCompletion,
} from './actionValidator';
import type {
  Scenario,
  CaptureResult,
  ComputerAction,
  ActionRecord,
  AgentLoopConfig,
  ClaudeModelConfig,
  TestResult,
  ExpectedAction,
  ProgressTracker,
} from '../types';
import { DEFAULT_AGENT_LOOP_CONFIG, DEFAULT_CLAUDE_MODEL_CONFIG } from '../types';

/** Options for agent loop */
export interface AgentLoopOptions {
  scenario: Scenario;
  abortSignal: AbortSignal;
  onIteration?: (iteration: number) => void;
  onLog?: (message: string) => void;
  config?: Partial<AgentLoopConfig>;
}

/** Result of agent loop execution (enhanced with TestResult) */
export interface AgentLoopResult {
  success: boolean;
  error?: string;
  iterations: number;
  testResult: TestResult;
  expectedActions?: ExpectedAction[];
  isFromFallback?: boolean;
}

/**
 * Merge partial model config with defaults (deep merge)
 * Also enforces enableZoom constraint - only supported for Opus 4.5 (computer_20251124)
 */
function mergeModelConfig(
  partial?: Partial<ClaudeModelConfig>
): ClaudeModelConfig {
  if (!partial) {
    return DEFAULT_CLAUDE_MODEL_CONFIG;
  }
  return {
    model: partial.model ?? DEFAULT_CLAUDE_MODEL_CONFIG.model,
    betaHeader: partial.betaHeader ?? DEFAULT_CLAUDE_MODEL_CONFIG.betaHeader,
    toolType: partial.toolType ?? DEFAULT_CLAUDE_MODEL_CONFIG.toolType,
    enableZoom:
      (partial.toolType ?? DEFAULT_CLAUDE_MODEL_CONFIG.toolType) === 'computer_20251124'
        ? (partial.enableZoom ?? DEFAULT_CLAUDE_MODEL_CONFIG.enableZoom)
        : false,
  };
}

/**
 * Execute the agent loop for a single scenario
 * Enhanced with test result judgment (v18)
 */
export async function runAgentLoop(
  options: AgentLoopOptions
): Promise<AgentLoopResult> {
  const baseConfig: AgentLoopConfig = {
    ...DEFAULT_AGENT_LOOP_CONFIG,
    ...options.config,
  };
  const config: AgentLoopConfig = {
    ...baseConfig,
    modelConfig: mergeModelConfig(options.config?.modelConfig),
  };

  const log = options.onLog ?? console.log;
  let messages: BetaMessageParam[] = [];
  const actionHistory: ActionRecord[] = [];
  let captureResult: CaptureResult;
  let iteration = 0;
  const startedAt = new Date();

  // Expected actions and progress tracking
  let expectedActions: ExpectedAction[] = [];
  let isFromFallback = false;
  let completedActionIndex = 0;
  const completedToolUseDescriptions: string[] = [];
  const progressTracker: ProgressTracker = createProgressTracker();

  // Medium confidence tracking for Claude verification
  let mediumConfidenceActionCount = 0;
  const MEDIUM_CONFIDENCE_CHECK_THRESHOLD = 3;

  // Low/medium confidence tracking for action_mismatch failure
  let lowMediumConfidenceCount = 0;
  const LOW_MEDIUM_CONFIDENCE_FAILURE_THRESHOLD = 10;

  // Claude response text for context
  let lastClaudeResponseText = '';

  // Previous screenshot for screen change detection
  let previousScreenshotBase64 = '';

  try {
    // Extract expected actions from scenario
    log('[Agent Loop] Extracting expected actions from scenario...');
    const extractResult = await extractExpectedActions(options.scenario.description);
    expectedActions = extractResult.expectedActions;
    isFromFallback = extractResult.isFromFallback;
    log(`[Agent Loop] Extracted ${expectedActions.length} expected actions (fallback: ${isFromFallback})`);

    // Initial screenshot
    log('[Agent Loop] Capturing initial screenshot...');
    log(`[Agent Loop] Scenario description: ${options.scenario.description}`);
    captureResult = await invoke<CaptureResult>('capture_screen');
    previousScreenshotBase64 = captureResult.imageBase64;

    // Initial message with scenario description, screenshot, and result schema instruction
    messages = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `${options.scenario.description}\n\n${RESULT_SCHEMA_INSTRUCTION}`,
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: captureResult.imageBase64,
            },
          },
        ],
      },
    ];

    // Main agent loop
    while (iteration < config.maxIterationsPerScenario) {
      // Check for abort
      if (options.abortSignal.aborted) {
        return {
          success: false,
          error: 'Aborted',
          iterations: iteration,
          testResult: createTestResult({
            status: 'stopped',
            failureReason: 'aborted',
            failureDetails: 'Aborted by signal',
            completedSteps: iteration,
            completedActionIndex,
            startedAt,
          }),
          expectedActions,
          isFromFallback,
        };
      }

      const stopRequested = await invoke<boolean>('is_stop_requested');
      if (stopRequested) {
        return {
          success: false,
          error: 'Stopped by user',
          iterations: iteration,
          testResult: createTestResult({
            status: 'stopped',
            failureReason: 'user_stopped',
            failureDetails: 'Stopped by user request',
            completedSteps: iteration,
            completedActionIndex,
            startedAt,
          }),
          expectedActions,
          isFromFallback,
        };
      }

      // Early success check: if all expected actions completed
      if (expectedActions.length > 0 && completedActionIndex >= expectedActions.length) {
        log('[Agent Loop] All expected actions completed - success');
        return {
          success: true,
          iterations: iteration,
          testResult: createTestResult({
            status: 'success',
            completedSteps: iteration,
            completedActionIndex,
            totalExpectedSteps: expectedActions.length,
            startedAt,
          }),
          expectedActions,
          isFromFallback,
        };
      }

      options.onIteration?.(iteration + 1);
      log(`[Agent Loop] Iteration ${iteration + 1}/${config.maxIterationsPerScenario}`);

      // Call Claude API with model configuration
      const modelConfig = config.modelConfig ?? DEFAULT_CLAUDE_MODEL_CONFIG;
      const response = await callClaudeAPI(messages, captureResult, options.abortSignal, modelConfig);

      // Handle null response (aborted)
      if (!response) {
        return {
          success: false,
          error: 'API call aborted',
          iterations: iteration,
          testResult: createTestResult({
            status: 'error',
            failureReason: 'api_error',
            failureDetails: 'API call was aborted',
            completedSteps: iteration,
            completedActionIndex,
            startedAt,
          }),
          expectedActions,
          isFromFallback,
        };
      }

      // Extract Claude response text for context
      const textBlocks = response.content.filter(
        (block): block is BetaTextBlock => block.type === 'text'
      );
      lastClaudeResponseText = textBlocks.map((b) => b.text).join('\n');

      // Analyze Claude response using unified judgment flow (v18)
      // For fallback mode, we need additional confirmation
      let additionalConfirmation = undefined;
      if (isFromFallback && !response.content.some((block) => block.type === 'tool_use')) {
        // Fallback mode and no tool_use - verify completion
        additionalConfirmation = await verifyFallbackCompletion(
          options.scenario.description,
          captureResult.imageBase64,
          expectedActions[0]?.keywords || [],
          {
            previousScreenshotBase64,
            lastExecutedAction: completedToolUseDescriptions[completedToolUseDescriptions.length - 1],
          }
        );
      }

      const analyzeResult = analyzeClaudeResponse(
        response,
        expectedActions,
        completedActionIndex,
        isFromFallback,
        additionalConfirmation
      );

      if (analyzeResult.isComplete) {
        if (analyzeResult.isSuccess) {
          log('[Agent Loop] Scenario completed successfully');
          if (analyzeResult.successByProgress) {
            log('[Agent Loop] Success determined by expected action progress');
          }
          return {
            success: true,
            iterations: iteration + 1,
            testResult: createTestResult({
              status: 'success',
              completedSteps: iteration + 1,
              completedActionIndex,
              totalExpectedSteps: expectedActions.length || undefined,
              claudeAnalysis: analyzeResult.analysis,
              claudeResultOutput: analyzeResult.resultOutput,
              startedAt,
            }),
            expectedActions,
            isFromFallback,
          };
        } else {
          log(`[Agent Loop] Scenario failed: ${analyzeResult.analysis}`);
          return {
            success: false,
            error: `Scenario failed: ${analyzeResult.analysis}`,
            iterations: iteration + 1,
            testResult: createTestResult({
              status: 'failure',
              failureReason: analyzeResult.failureReason || 'unexpected_state',
              failureDetails: analyzeResult.analysis,
              completedSteps: iteration + 1,
              completedActionIndex,
              claudeAnalysis: analyzeResult.analysis,
              claudeResultOutput: analyzeResult.resultOutput,
              startedAt,
            }),
            expectedActions,
            isFromFallback,
          };
        }
      }

      // Extract tool_use blocks
      const toolUseBlocks = response.content.filter(
        (block): block is BetaToolUseBlock => block.type === 'tool_use'
      );

      // Add assistant message to history
      messages.push({
        role: 'assistant',
        content: response.content,
      });

      // Process each tool_use
      const toolResults: BetaToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        // Check abort before each action
        if (options.abortSignal.aborted) {
          return {
            success: false,
            error: 'Aborted',
            iterations: iteration,
            testResult: createTestResult({
              status: 'stopped',
              failureReason: 'aborted',
              failureDetails: 'Aborted by signal',
              completedSteps: iteration,
              completedActionIndex,
              startedAt,
            }),
            expectedActions,
            isFromFallback,
          };
        }

        const stopCheck = await invoke<boolean>('is_stop_requested');
        if (stopCheck) {
          return {
            success: false,
            error: 'Stopped by user',
            iterations: iteration,
            testResult: createTestResult({
              status: 'stopped',
              failureReason: 'user_stopped',
              failureDetails: 'Stopped by user request',
              completedSteps: iteration,
              completedActionIndex,
              startedAt,
            }),
            expectedActions,
            isFromFallback,
          };
        }

        const action = toolUse.input as ComputerAction;

        // Loop detection (primary check)
        if (detectLoop(actionHistory, action, config)) {
          return {
            success: false,
            error: `Infinite loop detected: same action repeated ${config.loopDetectionThreshold} times`,
            iterations: iteration,
            testResult: createTestResult({
              status: 'failure',
              failureReason: 'stuck_in_loop',
              failureDetails: `Same action repeated ${config.loopDetectionThreshold} times (by loopDetector)`,
              completedSteps: iteration,
              completedActionIndex,
              lastAction: formatActionDetails(action, captureResult.scaleFactor, captureResult.displayScaleFactor),
              startedAt,
            }),
            expectedActions,
            isFromFallback,
          };
        }

        // Execute action with detailed logging
        const actionDetails = formatActionDetails(action, captureResult.scaleFactor, captureResult.displayScaleFactor);
        log(`[Agent Loop] Executing: ${actionDetails}`);
        const actionResult = await executeAction(action, captureResult.scaleFactor, captureResult.displayScaleFactor);

        // Action execution error - immediate failure
        if (!actionResult.success) {
          const failureReason = mapExecutionErrorToFailureReason(actionResult.error || 'Unknown error');
          log(`[Agent Loop] Action execution failed: ${actionResult.error}`);

          return {
            success: false,
            error: `Action execution failed: ${actionResult.error}`,
            iterations: iteration,
            testResult: createTestResult({
              status: 'failure',
              failureReason,
              failureDetails: actionResult.error,
              completedSteps: iteration,
              completedActionIndex,
              lastAction: actionDetails,
              startedAt,
            }),
            expectedActions,
            isFromFallback,
          };
        }

        // Add to action history
        actionHistory.push(createActionRecord(toolUse.id, action));

        // Store previous screenshot for change detection
        const previousScreenshotForComparison = captureResult.imageBase64;
        previousScreenshotBase64 = captureResult.imageBase64;

        // Capture result screenshot
        captureResult = await invoke<CaptureResult>('capture_screen');

        // Detect screen change with noise tolerance
        const screenChangeResult = hasSignificantScreenChange(
          previousScreenshotForComparison,
          captureResult.imageBase64
        );
        const screenChanged = screenChangeResult.changed && !screenChangeResult.isNoise;

        // Validate action and check progress
        const validation = validateActionAndCheckProgress(
          action,
          expectedActions,
          completedActionIndex,
          lastClaudeResponseText,
          screenChanged
        );

        if (validation.shouldAdvanceIndex) {
          // High confidence match with screen change
          if (expectedActions.length > completedActionIndex) {
            expectedActions[completedActionIndex].completed = true;
            log(`[Agent Loop] Expected action completed (high confidence, screen changed): ${expectedActions[completedActionIndex].description}`);
            completedActionIndex++;
            mediumConfidenceActionCount = 0;
            lowMediumConfidenceCount = 0;
          }
        } else if (validation.confidence === 'high' && validation.requiresScreenChange && !screenChanged) {
          // High confidence but no screen change
          log('[Agent Loop] High confidence match but no screen change - not advancing index');
          mediumConfidenceActionCount++;
        } else if (validation.confidence === 'medium') {
          // Medium confidence
          mediumConfidenceActionCount++;

          // Check for Claude verification
          if (
            mediumConfidenceActionCount >= MEDIUM_CONFIDENCE_CHECK_THRESHOLD &&
            completedActionIndex < expectedActions.length &&
            validation.needsClaudeVerification
          ) {
            log(`[Agent Loop] Medium confidence actions accumulated (${mediumConfidenceActionCount}) - requesting Claude verification`);

            // Include current action in descriptions for Claude verification
            const descriptionsWithCurrent = [...completedToolUseDescriptions, actionDetails];

            const completionCheck = await askClaudeForActionCompletion(
              options.scenario.description,
              expectedActions[completedActionIndex],
              descriptionsWithCurrent,
              captureResult.imageBase64
            );

            if (completionCheck.isCompleted && screenChanged) {
              expectedActions[completedActionIndex].completed = true;
              log(`[Agent Loop] Expected action completed (Claude verified, screen changed): ${expectedActions[completedActionIndex].description}`);
              completedActionIndex++;
              mediumConfidenceActionCount = 0;
              lowMediumConfidenceCount = 0;
            } else if (completionCheck.isCompleted && !screenChanged) {
              log('[Agent Loop] Claude verified completion but no screen change - not advancing index');
            }
          }

          // Track low/medium confidence for action_mismatch detection
          if (validation.requiresScreenChange && !screenChanged) {
            lowMediumConfidenceCount++;
          }
        } else if (validation.confidence === 'low') {
          // Track low/medium confidence for action_mismatch detection
          if (validation.requiresScreenChange && !screenChanged) {
            lowMediumConfidenceCount++;
          }
        }

        // Check for action_mismatch failure
        if (lowMediumConfidenceCount >= LOW_MEDIUM_CONFIDENCE_FAILURE_THRESHOLD) {
          log(`[Agent Loop] Low/medium confidence actions without progress: ${lowMediumConfidenceCount} - action mismatch failure`);
          return {
            success: false,
            error: 'Expected actions not matching - possible mismatch',
            iterations: iteration,
            testResult: createTestResult({
              status: 'failure',
              failureReason: 'action_mismatch',
              failureDetails: `${lowMediumConfidenceCount} consecutive low/medium confidence actions without screen change`,
              completedSteps: iteration,
              completedActionIndex,
              lastAction: actionDetails,
              startedAt,
            }),
            expectedActions,
            isFromFallback,
          };
        }

        // Record completed tool use
        completedToolUseDescriptions.push(actionDetails);

        // Progress check (supplementary stuck detection)
        const progressCheck = checkProgress(
          progressTracker,
          captureResult.imageBase64,
          action,
          {
            maxUnchangedScreenshots: config.maxUnchangedScreenshots ?? DEFAULT_STUCK_DETECTION_CONFIG.maxUnchangedScreenshots,
            maxSameActionRepeats: config.maxSameActionRepeats ?? DEFAULT_STUCK_DETECTION_CONFIG.maxSameActionRepeats,
          }
        );

        if (progressCheck.isStuck) {
          log(`[Agent Loop] Stuck detected: ${progressCheck.details}`);

          return {
            success: false,
            error: `Stuck: ${progressCheck.details}`,
            iterations: iteration,
            testResult: createTestResult({
              status: 'failure',
              failureReason: progressCheck.reason || 'action_no_effect',
              failureDetails: `${progressCheck.details} (by checkProgress)`,
              completedSteps: iteration,
              completedActionIndex,
              lastAction: actionDetails,
              startedAt,
            }),
            expectedActions,
            isFromFallback,
          };
        }

        // Build tool result
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: [
            {
              type: 'text',
              text: 'Action executed successfully',
            },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: captureResult.imageBase64,
              },
            },
          ],
        });
      }

      // Add tool results to messages
      messages.push({
        role: 'user',
        content: toolResults,
      });

      // Purge old images if history is too long
      if (messages.length > 40) {
        messages = purgeOldImages(messages, 20);
        log('[Agent Loop] Purged old images from history');
      }

      iteration++;
    }

    // Max iterations reached
    return {
      success: false,
      error: `Max iterations (${config.maxIterationsPerScenario}) reached`,
      iterations: iteration,
      testResult: createTestResult({
        status: 'timeout',
        failureReason: 'max_iterations',
        failureDetails: `Maximum iterations (${config.maxIterationsPerScenario}) reached without completion`,
        completedSteps: iteration,
        completedActionIndex,
        startedAt,
      }),
      expectedActions,
      isFromFallback,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`[Agent Loop] Error: ${errorMessage}`);
    return {
      success: false,
      error: errorMessage,
      iterations: iteration,
      testResult: createTestResult({
        status: 'error',
        failureReason: 'action_execution_error',
        failureDetails: errorMessage,
        completedSteps: iteration,
        completedActionIndex,
        startedAt,
      }),
      expectedActions,
      isFromFallback,
    };
  }
}

/**
 * Format action details for logging
 * Shows coordinates (both Claude and screen), text, and other parameters
 */
function formatActionDetails(
  action: ComputerAction,
  scaleFactor: number,
  displayScaleFactor: number
): string {
  const parts: string[] = [action.action];

  if (action.coordinate) {
    const [claudeX, claudeY] = action.coordinate;
    const screenCoord = toScreenCoordinate({ x: claudeX, y: claudeY }, scaleFactor, displayScaleFactor);
    parts.push(`at Claude(${claudeX}, ${claudeY}) → Screen(${screenCoord.x}, ${screenCoord.y}) [DPI:${displayScaleFactor}]`);
  }

  if (action.start_coordinate) {
    const [startX, startY] = action.start_coordinate;
    const screenStart = toScreenCoordinate({ x: startX, y: startY }, scaleFactor, displayScaleFactor);
    parts.push(`from Claude(${startX}, ${startY}) → Screen(${screenStart.x}, ${screenStart.y})`);
  }

  if (action.text) {
    const displayText = action.text.length > 50 ? action.text.substring(0, 50) + '...' : action.text;
    parts.push(`text="${displayText}"`);
  }

  if (action.scroll_direction) {
    parts.push(`direction=${action.scroll_direction}`);
    if (action.scroll_amount) {
      parts.push(`amount=${action.scroll_amount}`);
    }
  }

  if (action.duration !== undefined) {
    parts.push(`duration=${action.duration}ms`);
  }

  if (action.key) {
    parts.push(`key="${action.key}" ${action.down ? 'down' : 'up'}`);
  }

  return parts.join(' ');
}

/**
 * Call Claude API with abort support
 * Uses model configuration to support different Claude models (Opus 4.5, Sonnet, etc.)
 */
async function callClaudeAPI(
  messages: BetaMessageParam[],
  captureResult: CaptureResult,
  abortSignal: AbortSignal,
  modelConfig: ClaudeModelConfig
): Promise<BetaMessage | null> {
  let abortHandler: (() => void) | null = null;

  try {
    const client = await getClaudeClient();

    const apiPromise = client.beta.messages.create({
      model: modelConfig.model,
      max_tokens: 4096,
      system: RESULT_SCHEMA_INSTRUCTION,
      tools: [buildComputerTool(captureResult, modelConfig)] as unknown as Parameters<typeof client.beta.messages.create>[0]['tools'],
      messages,
      betas: [modelConfig.betaHeader],
    });

    const abortPromise = new Promise<never>((_, reject) => {
      if (abortSignal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      abortHandler = () => reject(new DOMException('Aborted', 'AbortError'));
      abortSignal.addEventListener('abort', abortHandler);
    });

    const result = await Promise.race([apiPromise, abortPromise]);
    return result as BetaMessage;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return null;
    }
    throw error;
  } finally {
    if (abortHandler) {
      abortSignal.removeEventListener('abort', abortHandler);
    }
  }
}

/** Action execution result */
interface ActionExecutionResult {
  success: boolean;
  error?: string;
}

/**
 * Execute a computer action via Rust backend
 * Coordinates are converted from Claude (resized image) to logical screen points (for HiDPI/Retina)
 */
async function executeAction(
  action: ComputerAction,
  scaleFactor: number,
  displayScaleFactor: number
): Promise<ActionExecutionResult> {
  try {
    const { x, y } = action.coordinate
      ? toScreenCoordinate({ x: action.coordinate[0], y: action.coordinate[1] }, scaleFactor, displayScaleFactor)
      : { x: 0, y: 0 };

    const { x: startX, y: startY } = action.start_coordinate
      ? toScreenCoordinate(
          { x: action.start_coordinate[0], y: action.start_coordinate[1] },
          scaleFactor,
          displayScaleFactor
        )
      : { x: 0, y: 0 };

    switch (action.action) {
      case 'screenshot':
        break;

      case 'left_click':
        await invoke('left_click', { x, y });
        break;

      case 'right_click':
        await invoke('right_click', { x, y });
        break;

      case 'middle_click':
        await invoke('middle_click', { x, y });
        break;

      case 'double_click':
        await invoke('double_click', { x, y });
        break;

      case 'triple_click':
        await invoke('triple_click', { x, y });
        break;

      case 'mouse_move':
        await invoke('mouse_move', { x, y });
        break;

      case 'left_click_drag':
        await invoke('left_click_drag', {
          startX,
          startY,
          endX: x,
          endY: y,
        });
        break;

      case 'left_mouse_down':
        await invoke('left_mouse_down', { x, y });
        break;

      case 'left_mouse_up':
        await invoke('left_mouse_up', { x, y });
        break;

      case 'type':
        if (!action.text) {
          return { success: false, error: 'type action requires text parameter' };
        }
        await invoke('type_text', { text: action.text });
        break;

      case 'key':
        if (!action.text) {
          return { success: false, error: 'key action requires text parameter' };
        }
        await invoke('key', { keys: action.text });
        break;

      case 'scroll':
        await invoke('scroll', {
          x,
          y,
          direction: action.scroll_direction ?? 'down',
          amount: action.scroll_amount ?? 3,
        });
        break;

      case 'wait':
        const waitResult = await invoke<boolean>('wait', {
          durationMs: action.duration ?? 1000,
        });
        if (!waitResult) {
          return { success: false, error: 'Wait cancelled' };
        }
        break;

      case 'hold_key':
        if (!action.key) {
          return { success: false, error: 'hold_key action requires key parameter' };
        }
        await invoke('hold_key', {
          keyName: action.key,
          hold: action.down ?? true,
        });
        break;

      default:
        return { success: false, error: `Unknown action: ${action.action}` };
    }

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
  }
}
