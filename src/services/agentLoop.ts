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
import { callClaudeAPIViaProxy, RESULT_SCHEMA_INSTRUCTION } from './claudeClient';
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
} from './resultJudge';
import {
  extractExpectedActions,
  validateActionAndCheckProgress,
  askClaudeForActionCompletion,
  verifyTextOnScreen,
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
  StepImage,
  HintImageMatchResult,
  MatchErrorCode,
} from '../types';
import { DEFAULT_AGENT_LOOP_CONFIG, DEFAULT_CLAUDE_MODEL_CONFIG } from '../types';

// Verification retry configuration
const VERIFICATION_MAX_RETRIES = 3;
const VERIFICATION_RETRY_DELAY_MS = 1000;

/**
 * Verify text on screen with retry support
 * Retries verification up to VERIFICATION_MAX_RETRIES times if verification fails
 * This handles cases where UI takes time to update after actions
 */
async function verifyTextWithRetry(
  verificationText: string,
  getCurrentScreenshot: () => Promise<CaptureResult>,
  initialScreenshot: string,
  log: (message: string) => void
): Promise<{
  result: { verified: boolean; reason?: string; isError?: boolean };
  retryCount: number;
  latestScreenshot: CaptureResult | null;
}> {
  let currentScreenshotBase64 = initialScreenshot;
  let latestCaptureResult: CaptureResult | null = null;

  let verifyResult = await verifyTextOnScreen(verificationText, currentScreenshotBase64);

  // Retry if verification failed (but not for API errors)
  let retryCount = 0;
  while (!verifyResult.verified && !verifyResult.isError && retryCount < VERIFICATION_MAX_RETRIES) {
    retryCount++;
    log(`[Agent Loop] Verification retry ${retryCount}/${VERIFICATION_MAX_RETRIES} - waiting for UI update...`);
    await new Promise(resolve => setTimeout(resolve, VERIFICATION_RETRY_DELAY_MS));

    // Take a fresh screenshot
    latestCaptureResult = await getCurrentScreenshot();
    currentScreenshotBase64 = latestCaptureResult.imageBase64;

    verifyResult = await verifyTextOnScreen(verificationText, currentScreenshotBase64);
  }

  return { result: verifyResult, retryCount, latestScreenshot: latestCaptureResult };
}

/** Options for agent loop */
export interface AgentLoopOptions {
  scenario: Scenario;
  hintImages?: StepImage[];
  abortSignal: AbortSignal;
  onIteration?: (iteration: number) => void;
  onLog?: (message: string) => void;
  config?: Partial<AgentLoopConfig>;
}

/** Executed action record for tracking action history */
export interface ExecutedActionRecord {
  index: number;
  action: string;
  description: string;
  success: boolean;
  timestamp: Date;
}

/** Result of agent loop execution (enhanced with TestResult) */
export interface AgentLoopResult {
  success: boolean;
  error?: string;
  iterations: number;
  testResult: TestResult;
  expectedActions?: ExpectedAction[];
  isFromFallback?: boolean;
  /** Executed action history */
  executedActions: ExecutedActionRecord[];
  /** Number of completed actions */
  completedActionCount: number;
  /** Description of failed action (if any) */
  failedAtAction?: string;
  /** Last successfully completed action description */
  lastSuccessfulAction?: string;
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
  // Note: isFromFallback is always false now (fallback removed)
  const isFromFallback = false;
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

  // Executed action records for tracking (new for batch execution)
  const executedActions: ExecutedActionRecord[] = [];

  // Track hint image match results for re-matching undetected images
  // Key: index (original order), Value: latest match result
  let hintImageMatchResults: Map<number, HintImageMatchResult> = new Map();

  try {
    // Extract expected actions from scenario
    log('[Agent Loop] Extracting expected actions from scenario...');
    try {
      const extractResult = await extractExpectedActions(options.scenario.description);
      expectedActions = extractResult.expectedActions;
      log(`[Agent Loop] Extracted ${expectedActions.length} expected actions`);
    } catch (extractError) {
      // Extraction failure should be status: 'failure' (not 'error')
      // This is a test failure, not a system error
      const errorMessage = extractError instanceof Error ? extractError.message : String(extractError);
      log(`[Agent Loop] Expected action extraction failed: ${errorMessage}`);
      return {
        success: false,
        error: `Failed to extract expected actions: ${errorMessage}`,
        iterations: 0,
        testResult: createTestResult({
          status: 'failure',
          failureReason: 'extraction_failed',
          failureDetails: errorMessage,
          completedSteps: 0,
          completedActionIndex: 0,
          startedAt,
        }),
        expectedActions: [],
        isFromFallback: false,
        executedActions: [],
        completedActionCount: 0,
      };
    }

    // Initial screenshot
    log('[Agent Loop] Capturing initial screenshot...');
    log(`[Agent Loop] Scenario description: ${options.scenario.description}`);
    captureResult = await invoke<CaptureResult>('capture_screen');

    // Build initial message content
    type MediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

    /**
     * Normalize MIME type for Claude API compatibility
     * 'image/jpg' is non-standard; Claude API expects 'image/jpeg'
     */
    const normalizeMimeType = (mimeType: string): MediaType => {
      if (mimeType === 'image/jpg') {
        return 'image/jpeg';
      }
      return mimeType as MediaType;
    };

    const initialMessageContent: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; source: { type: 'base64'; media_type: MediaType; data: string } }
    > = [
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
    ];

    // Add hint images if provided
    if (options.hintImages && options.hintImages.length > 0) {
      log(`[Agent Loop] Adding ${options.hintImages.length} hint images to request`);

      // Perform template matching to detect coordinates
      // IMPORTANT: Pass scaleFactor to align hint image scale with resized screenshot
      let matchResults: HintImageMatchResult[] = [];
      try {
        matchResults = await invoke<HintImageMatchResult[]>('match_hint_images', {
          screenshotBase64: captureResult.imageBase64,
          templateImages: options.hintImages.map((img) => ({
            imageData: img.image_data,
            fileName: img.file_name,
          })),
          scaleFactor: captureResult.scaleFactor,
          confidenceThreshold: 0.7,
        });

        // Log results (including errors for individual images)
        const foundCount = matchResults.filter((r) => r.matchResult.found).length;
        const errorCount = matchResults.filter((r) => r.matchResult.error).length;
        log(
          `[Agent Loop] Template matching completed: ${foundCount}/${matchResults.length} found, ${errorCount} errors`
        );

        // Log detailed results for each image (for debugging coordinate/confidence issues)
        for (const r of matchResults) {
          if (r.matchResult.found) {
            log(
              `[Agent Loop] ✓ ${r.fileName}: found at (${r.matchResult.centerX}, ${r.matchResult.centerY}), confidence=${r.matchResult.confidence?.toFixed(3)}`
            );
          } else if (r.matchResult.error) {
            log(`[Agent Loop] ✗ ${r.fileName}: error - ${r.matchResult.error}`);
          } else {
            // Not found, but no error - confidence below threshold
            log(
              `[Agent Loop] ✗ ${r.fileName}: not found, confidence=${r.matchResult.confidence?.toFixed(3)} (threshold=0.7)`
            );
          }
        }

        // Store initial match results for re-matching later
        for (const result of matchResults) {
          hintImageMatchResults.set(result.index, result);
        }
      } catch (error) {
        // Unexpected Rust-side error (should not normally occur) - continue without coordinates
        log(`[Agent Loop] Template matching unexpected error, continuing without coordinates: ${error}`);
      }

      // Build hint text with coordinate information
      let hintText = '\n\n【ヒント画像】\n以下は、探してほしい要素やクリック対象のキャプチャです。';

      // Add coordinate information for successfully detected images
      // IMPORTANT: Use r.index (original hint image order), not filter() index
      // This ensures numbering stays consistent even if some images weren't detected
      // Example: Image 1 not found, Image 2 found, Image 3 found → "画像2: 885,226 / 画像3: 223,355"
      const detectedCoordinates = matchResults
        .filter((r) => r.matchResult.found && !r.matchResult.error)
        .map(
          (r) =>
            `画像${r.index + 1}(${r.fileName}): ${r.matchResult.centerX},${r.matchResult.centerY}`
        )
        .join(' / ');

      if (detectedCoordinates) {
        hintText += `\n\n【画像認識による座標（各画像の中心点）】\n${detectedCoordinates}\n\n上記の座標は画像認識で検出した位置です。これらを参考にして正確に操作してください。`;
      } else {
        hintText += '\nこれらを参考にして正確に操作してください：';
      }

      initialMessageContent.push({
        type: 'text',
        text: hintText,
      });

      for (const hintImage of options.hintImages) {
        initialMessageContent.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: normalizeMimeType(hintImage.mime_type),
            data: hintImage.image_data,
          },
        });
      }
    }

    // Initial message with scenario description, screenshot, and result schema instruction
    messages = [
      {
        role: 'user',
        content: initialMessageContent,
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
          executedActions,
          completedActionCount: executedActions.filter((a) => a.success).length,
          lastSuccessfulAction: executedActions.filter((a) => a.success).pop()?.description,
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
          executedActions,
          completedActionCount: executedActions.filter((a) => a.success).length,
          lastSuccessfulAction: executedActions.filter((a) => a.success).pop()?.description,
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
          executedActions,
          completedActionCount: executedActions.filter((a) => a.success).length,
          lastSuccessfulAction: executedActions.filter((a) => a.success).pop()?.description,
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
          executedActions,
          completedActionCount: executedActions.filter((a) => a.success).length,
          lastSuccessfulAction: executedActions.filter((a) => a.success).pop()?.description,
        };
      }

      // Extract Claude response text for context
      const textBlocks = response.content.filter(
        (block): block is BetaTextBlock => block.type === 'text'
      );
      lastClaudeResponseText = textBlocks.map((b) => b.text).join('\n');

      // Analyze Claude response using unified judgment flow (v18)
      const analyzeResult = analyzeClaudeResponse(
        response,
        expectedActions,
        completedActionIndex,
        false,  // isFromFallback is always false now (fallback removed)
        undefined  // additionalConfirmation not needed
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
            executedActions,
            completedActionCount: executedActions.filter((a) => a.success).length,
            lastSuccessfulAction: executedActions.filter((a) => a.success).pop()?.description,
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
            executedActions,
            completedActionCount: executedActions.filter((a) => a.success).length,
            lastSuccessfulAction: executedActions.filter((a) => a.success).pop()?.description,
            failedAtAction: analyzeResult.analysis,
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
            executedActions,
            completedActionCount: executedActions.filter((a) => a.success).length,
            lastSuccessfulAction: executedActions.filter((a) => a.success).pop()?.description,
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
            executedActions,
            completedActionCount: executedActions.filter((a) => a.success).length,
            lastSuccessfulAction: executedActions.filter((a) => a.success).pop()?.description,
          };
        }

        const action = toolUse.input as ComputerAction;

        // Loop detection (primary check)
        if (detectLoop(actionHistory, action, config)) {
          const loopActionDetails = formatActionDetails(action, captureResult.scaleFactor, captureResult.displayScaleFactor);
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
              lastAction: loopActionDetails,
              startedAt,
            }),
            expectedActions,
            isFromFallback,
            executedActions,
            completedActionCount: executedActions.filter((a) => a.success).length,
            lastSuccessfulAction: executedActions.filter((a) => a.success).pop()?.description,
            failedAtAction: loopActionDetails,
          };
        }

        // Execute action with detailed logging
        const actionDetails = formatActionDetails(action, captureResult.scaleFactor, captureResult.displayScaleFactor);

        // Log Claude's reasoning for debugging (why this action was chosen)
        if (lastClaudeResponseText) {
          const truncatedResponse = lastClaudeResponseText.length > 500
            ? lastClaudeResponseText.substring(0, 500) + '...(truncated)'
            : lastClaudeResponseText;
          log(`[Agent Loop] Claude's reasoning: ${truncatedResponse}`);
        }

        log(`[Agent Loop] Executing: ${actionDetails}`);
        const actionResult = await executeAction(action, captureResult.scaleFactor, captureResult.displayScaleFactor);

        // Action execution error - immediate failure
        if (!actionResult.success) {
          const failureReason = mapExecutionErrorToFailureReason(actionResult.error || 'Unknown error');
          log(`[Agent Loop] Action execution failed: ${actionResult.error}`);

          // Record failed action
          executedActions.push({
            index: executedActions.length,
            action: action.action,
            description: actionDetails,
            success: false,
            timestamp: new Date(),
          });

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
            executedActions,
            completedActionCount: executedActions.filter((a) => a.success).length,
            lastSuccessfulAction: executedActions.filter((a) => a.success).pop()?.description,
            failedAtAction: actionDetails,
          };
        }

        // Record successful action
        executedActions.push({
          index: executedActions.length,
          action: action.action,
          description: actionDetails,
          success: true,
          timestamp: new Date(),
        });

        // Add to action history
        actionHistory.push(createActionRecord(toolUse.id, action));

        // Store previous screenshot for change detection
        const previousScreenshotForComparison = captureResult.imageBase64;

        // Wait for UI to update after click actions
        // Dialogs and other UI elements may appear asynchronously after clicks
        const actionDelayMs = config.actionDelayMs ?? 1000;
        const clickActions = ['left_click', 'right_click', 'double_click', 'triple_click', 'middle_click'];
        if (clickActions.includes(action.action) && actionDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, actionDelayMs));
        }

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

        // Debug: Log validation details for troubleshooting
        if (completedActionIndex < expectedActions.length) {
          const currentExpected = expectedActions[completedActionIndex];
          log(`[Agent Loop] Validation: action=${action.action}, expected="${currentExpected.description}", expectedTool=${currentExpected.expectedToolAction}, confidence=${validation.confidence}, shouldAdvance=${validation.shouldAdvanceIndex}, screenChanged=${screenChanged}, reason=${validation.reason || 'none'}`);
        }

        if (validation.shouldAdvanceIndex) {
          // High confidence match with screen change
          if (expectedActions.length > completedActionIndex) {
            const currentExpected = expectedActions[completedActionIndex];

            // If verificationText is set, verify the text appears on screen
            if (currentExpected.verificationText) {
              log(`[Agent Loop] Verifying text: "${currentExpected.verificationText}"`);
              log(`[Agent Loop] Screenshot for verification: ${captureResult.resizedWidth}x${captureResult.resizedHeight} (original: ${captureResult.originalWidth}x${captureResult.originalHeight})`);

              // Save screenshot for debugging (only in debug mode)
              // Set XENOTESTER_DEBUG=1 environment variable to enable
              if (import.meta.env.VITE_XENOTESTER_DEBUG === '1') {
                try {
                  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                  // Use OS-agnostic temp path via import.meta.env or fallback
                  const debugDir = import.meta.env.VITE_XENOTESTER_DEBUG_DIR || '/tmp/xenotester-debug';
                  await invoke('ensure_directory', { path: debugDir });
                  const ssPath = `${debugDir}/verification-${timestamp}.png`;
                  await invoke('save_base64_image', { base64Data: captureResult.imageBase64, filePath: ssPath });
                  log(`[Agent Loop] Debug screenshot saved: ${ssPath}`);
                } catch (e) {
                  log(`[Agent Loop] Failed to save debug screenshot: ${e}`);
                }
              }

              const { result: verifyResult, retryCount, latestScreenshot } = await verifyTextWithRetry(
                currentExpected.verificationText,
                () => invoke<CaptureResult>('capture_screen'),
                captureResult.imageBase64,
                log
              );

              // Update captureResult if we took new screenshots during retry
              if (latestScreenshot) {
                captureResult = latestScreenshot;
              }

              if (verifyResult.verified) {
                currentExpected.completed = true;
                log(`[Agent Loop] Expected action completed (verified text found${retryCount > 0 ? ` after ${retryCount} retries` : ''}): ${currentExpected.description}`);
                log(`[Agent Loop] Verification reason: ${verifyResult.reason}`);
                completedActionIndex++;
                mediumConfidenceActionCount = 0;
                lowMediumConfidenceCount = 0;
              } else {
                // Verification failed - immediate failure
                // Distinguish between API/parse errors and actual verification failures
                const isApiError = verifyResult.isError === true;
                const failureReason = isApiError ? 'api_error' : 'verification_failed';
                const errorPrefix = isApiError ? 'Verification API error' : 'Verification failed';
                const failureDetailsText = isApiError
                  ? `Verification API/parse error for text "${currentExpected.verificationText}". Reason: ${verifyResult.reason}`
                  : `Expected text "${currentExpected.verificationText}" not found on screen after ${VERIFICATION_MAX_RETRIES} retries. Reason: ${verifyResult.reason}`;
                log(`[Agent Loop] ${errorPrefix} - text "${currentExpected.verificationText}"${retryCount > 0 ? ` (after ${retryCount} retries)` : ''}`);
                log(`[Agent Loop] Verification reason: ${verifyResult.reason}`);
                return {
                  success: false,
                  error: `${errorPrefix}: "${currentExpected.verificationText}"`,
                  iterations: iteration,
                  testResult: createTestResult({
                    status: 'failure',
                    failureReason,
                    failureDetails: failureDetailsText,
                    completedSteps: iteration,
                    completedActionIndex,
                    lastAction: actionDetails,
                    startedAt,
                  }),
                  expectedActions,
                  isFromFallback,
                  executedActions,
                  completedActionCount: executedActions.filter((a) => a.success).length,
                  lastSuccessfulAction: executedActions.filter((a) => a.success).pop()?.description,
                  failedAtAction: isApiError
                    ? `Verification API error: "${currentExpected.verificationText}"`
                    : `Verification: "${currentExpected.verificationText}" not found`,
                };
              }
            } else {
              // No verification text - use standard completion
              currentExpected.completed = true;
              log(`[Agent Loop] Expected action completed (high confidence, screen changed): ${currentExpected.description}`);
              completedActionIndex++;
              mediumConfidenceActionCount = 0;
              lowMediumConfidenceCount = 0;
            }
          }
        } else if (validation.confidence === 'high' && validation.requiresScreenChange && !screenChanged) {
          // High confidence but no screen change - check verificationText if available
          if (expectedActions.length > completedActionIndex) {
            const currentExpected = expectedActions[completedActionIndex];

            // If verificationText is set, check it even without screen change
            if (currentExpected.verificationText) {
              log(`[Agent Loop] High confidence, no screen change - checking verificationText: "${currentExpected.verificationText}"`);

              const { result: verifyResult, retryCount, latestScreenshot } = await verifyTextWithRetry(
                currentExpected.verificationText,
                () => invoke<CaptureResult>('capture_screen'),
                captureResult.imageBase64,
                log
              );

              // Update captureResult if we took new screenshots during retry
              if (latestScreenshot) {
                captureResult = latestScreenshot;
              }

              if (verifyResult.verified) {
                // Verification success overrides screen change requirement
                currentExpected.completed = true;
                log(`[Agent Loop] Expected action completed (verified text found${retryCount > 0 ? ` after ${retryCount} retries` : ''}, no screen change needed): ${currentExpected.description}`);
                log(`[Agent Loop] Verification reason: ${verifyResult.reason}`);
                completedActionIndex++;
                mediumConfidenceActionCount = 0;
                lowMediumConfidenceCount = 0;
              } else {
                // Verification failed - immediate failure
                // Distinguish between API/parse errors and actual verification failures
                const isApiError = verifyResult.isError === true;
                const failureReason = isApiError ? 'api_error' : 'verification_failed';
                const errorPrefix = isApiError ? 'Verification API error' : 'Verification failed';
                const failureDetailsText = isApiError
                  ? `Verification API/parse error for text "${currentExpected.verificationText}". Reason: ${verifyResult.reason}`
                  : `Expected text "${currentExpected.verificationText}" not found on screen after ${VERIFICATION_MAX_RETRIES} retries. Reason: ${verifyResult.reason}`;
                log(`[Agent Loop] ${errorPrefix} - text "${currentExpected.verificationText}"${retryCount > 0 ? ` (after ${retryCount} retries)` : ''}`);
                log(`[Agent Loop] Verification reason: ${verifyResult.reason}`);
                return {
                  success: false,
                  error: `${errorPrefix}: "${currentExpected.verificationText}"`,
                  iterations: iteration,
                  testResult: createTestResult({
                    status: 'failure',
                    failureReason,
                    failureDetails: failureDetailsText,
                    completedSteps: iteration,
                    completedActionIndex,
                    lastAction: actionDetails,
                    startedAt,
                  }),
                  expectedActions,
                  isFromFallback,
                  executedActions,
                  completedActionCount: executedActions.filter((a) => a.success).length,
                  lastSuccessfulAction: executedActions.filter((a) => a.success).pop()?.description,
                  failedAtAction: isApiError
                    ? `Verification API error: "${currentExpected.verificationText}"`
                    : `Verification: "${currentExpected.verificationText}" not found`,
                };
              }
            } else {
              log('[Agent Loop] High confidence match but no screen change - not advancing index');
              mediumConfidenceActionCount++;
            }
          } else {
            log('[Agent Loop] High confidence match but no screen change - not advancing index');
            mediumConfidenceActionCount++;
          }
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
              const currentExpected = expectedActions[completedActionIndex];

              // If verificationText is set, verify the text appears on screen
              if (currentExpected.verificationText) {
                log(`[Agent Loop] Verifying text: "${currentExpected.verificationText}"`);

                const { result: verifyResult, retryCount, latestScreenshot } = await verifyTextWithRetry(
                  currentExpected.verificationText,
                  () => invoke<CaptureResult>('capture_screen'),
                  captureResult.imageBase64,
                  log
                );

                // Update captureResult if we took new screenshots during retry
                if (latestScreenshot) {
                  captureResult = latestScreenshot;
                }

                if (verifyResult.verified) {
                  currentExpected.completed = true;
                  log(`[Agent Loop] Expected action completed (Claude + text verified${retryCount > 0 ? ` after ${retryCount} retries` : ''}): ${currentExpected.description}`);
                  log(`[Agent Loop] Verification reason: ${verifyResult.reason}`);
                  completedActionIndex++;
                  mediumConfidenceActionCount = 0;
                  lowMediumConfidenceCount = 0;
                } else {
                  // Verification failed - immediate failure
                  // Distinguish between API/parse errors and actual verification failures
                  const isApiError = verifyResult.isError === true;
                  const failureReason = isApiError ? 'api_error' : 'verification_failed';
                  const errorPrefix = isApiError ? 'Verification API error' : 'Verification failed';
                  const failureDetailsText = isApiError
                    ? `Verification API/parse error for text "${currentExpected.verificationText}". Reason: ${verifyResult.reason}`
                    : `Expected text "${currentExpected.verificationText}" not found on screen after ${VERIFICATION_MAX_RETRIES} retries. Reason: ${verifyResult.reason}`;
                  log(`[Agent Loop] ${errorPrefix} - text "${currentExpected.verificationText}"${retryCount > 0 ? ` (after ${retryCount} retries)` : ''}`);
                  log(`[Agent Loop] Verification reason: ${verifyResult.reason}`);
                  return {
                    success: false,
                    error: `${errorPrefix}: "${currentExpected.verificationText}"`,
                    iterations: iteration,
                    testResult: createTestResult({
                      status: 'failure',
                      failureReason,
                      failureDetails: failureDetailsText,
                      completedSteps: iteration,
                      completedActionIndex,
                      lastAction: actionDetails,
                      startedAt,
                    }),
                    expectedActions,
                    isFromFallback,
                    executedActions,
                    completedActionCount: executedActions.filter((a) => a.success).length,
                    lastSuccessfulAction: executedActions.filter((a) => a.success).pop()?.description,
                    failedAtAction: isApiError
                      ? `Verification API error: "${currentExpected.verificationText}"`
                      : `Verification: "${currentExpected.verificationText}" not found`,
                  };
                }
              } else {
                currentExpected.completed = true;
                log(`[Agent Loop] Expected action completed (Claude verified, screen changed): ${currentExpected.description}`);
                completedActionIndex++;
                mediumConfidenceActionCount = 0;
                lowMediumConfidenceCount = 0;
              }
            } else if (completionCheck.isCompleted && !screenChanged) {
              // Claude verified but no screen change - check verificationText if available
              const currentExpected = expectedActions[completedActionIndex];
              if (currentExpected.verificationText) {
                log(`[Agent Loop] Claude verified, no screen change - checking verificationText: "${currentExpected.verificationText}"`);

                const { result: verifyResult, retryCount, latestScreenshot } = await verifyTextWithRetry(
                  currentExpected.verificationText,
                  () => invoke<CaptureResult>('capture_screen'),
                  captureResult.imageBase64,
                  log
                );

                // Update captureResult if we took new screenshots during retry
                if (latestScreenshot) {
                  captureResult = latestScreenshot;
                }

                if (verifyResult.verified) {
                  // Verification success overrides screen change requirement
                  currentExpected.completed = true;
                  log(`[Agent Loop] Expected action completed (Claude + text verified${retryCount > 0 ? ` after ${retryCount} retries` : ''}, no screen change needed): ${currentExpected.description}`);
                  log(`[Agent Loop] Verification reason: ${verifyResult.reason}`);
                  completedActionIndex++;
                  mediumConfidenceActionCount = 0;
                  lowMediumConfidenceCount = 0;
                } else {
                  // Verification failed - immediate failure
                  // Distinguish between API/parse errors and actual verification failures
                  const isApiError = verifyResult.isError === true;
                  const failureReason = isApiError ? 'api_error' : 'verification_failed';
                  const errorPrefix = isApiError ? 'Verification API error' : 'Verification failed';
                  const failureDetailsText = isApiError
                    ? `Verification API/parse error for text "${currentExpected.verificationText}". Reason: ${verifyResult.reason}`
                    : `Expected text "${currentExpected.verificationText}" not found on screen after ${VERIFICATION_MAX_RETRIES} retries. Reason: ${verifyResult.reason}`;
                  log(`[Agent Loop] ${errorPrefix} - text "${currentExpected.verificationText}"${retryCount > 0 ? ` (after ${retryCount} retries)` : ''}`);
                  log(`[Agent Loop] Verification reason: ${verifyResult.reason}`);
                  return {
                    success: false,
                    error: `${errorPrefix}: "${currentExpected.verificationText}"`,
                    iterations: iteration,
                    testResult: createTestResult({
                      status: 'failure',
                      failureReason,
                      failureDetails: failureDetailsText,
                      completedSteps: iteration,
                      completedActionIndex,
                      lastAction: actionDetails,
                      startedAt,
                    }),
                    expectedActions,
                    isFromFallback,
                    executedActions,
                    completedActionCount: executedActions.filter((a) => a.success).length,
                    lastSuccessfulAction: executedActions.filter((a) => a.success).pop()?.description,
                    failedAtAction: isApiError
                      ? `Verification API error: "${currentExpected.verificationText}"`
                      : `Verification: "${currentExpected.verificationText}" not found`,
                  };
                }
              } else {
                log('[Agent Loop] Claude verified completion but no screen change - not advancing index');
              }
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
            executedActions,
            completedActionCount: executedActions.filter((a) => a.success).length,
            lastSuccessfulAction: executedActions.filter((a) => a.success).pop()?.description,
            failedAtAction: actionDetails,
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
            executedActions,
            completedActionCount: executedActions.filter((a) => a.success).length,
            lastSuccessfulAction: executedActions.filter((a) => a.success).pop()?.description,
            failedAtAction: actionDetails,
          };
        }

        // Re-match hint images against new screenshot
        // When screen changes, re-match ALL images (including previously found ones)
        // to update coordinates that may have shifted after screen transitions.
        // When screen hasn't changed, only re-match undetected images.
        let updatedCoordinatesText = '';
        // NOTE: Removed hintImageMatchResults.size > 0 guard to allow re-matching
        // even when initial matching failed (empty result or exception)
        if (options.hintImages && options.hintImages.length > 0) {
          // Permanent error codes that won't resolve with different screenshots
          const PERMANENT_ERROR_CODES: MatchErrorCode[] = [
            'template_base64_decode_error',
            'template_image_decode_error',
            'insufficient_opacity',
            'non_finite_confidence',
          ];

          // Size-related error codes that may resolve when screen changes
          const SIZE_RELATED_ERROR_CODES: MatchErrorCode[] = [
            'template_too_large',
          ];

          // Helper: Check if error is permanent (won't resolve with different screenshots)
          // Uses error code for robust detection, with fallback to message parsing for compatibility
          const isPermanentError = (errorCode: MatchErrorCode | null | undefined, error: string | null | undefined): boolean => {
            // Prefer error code for robust detection
            if (errorCode) {
              return PERMANENT_ERROR_CODES.includes(errorCode);
            }
            // Fallback to message parsing for backward compatibility
            if (!error) return false;
            // IMPORTANT: Screenshot decode errors are transient - they may succeed with a different screenshot
            if (error.includes('Screenshot decode error')) {
              return false;
            }
            // Template-side decode errors
            if (error.includes('Base64 decode error') || error.includes('Image decode error')) {
              return true;
            }
            if (error.includes('insufficient opacity')) {
              return true;
            }
            if (error.includes('non-finite confidence')) {
              return true;
            }
            return false;
          };

          // Helper: Check if error is size-related (may resolve when screen changes)
          const isSizeRelatedError = (errorCode: MatchErrorCode | null | undefined, error: string | null | undefined): boolean => {
            // Prefer error code for robust detection
            if (errorCode) {
              return SIZE_RELATED_ERROR_CODES.includes(errorCode);
            }
            // Fallback to message parsing for backward compatibility
            if (!error) return false;
            return error.includes('larger than screenshot');
          };

          // Find images to re-match based on screen change status
          // Preserve original index to avoid findIndex issues with duplicate file_name
          const imagesToRematchWithIndex: { img: StepImage; originalIndex: number }[] = [];
          options.hintImages.forEach((img, idx) => {
            const prevResult = hintImageMatchResults.get(idx);

            // Skip images with permanent errors (won't resolve regardless of screenshot)
            if (prevResult?.matchResult.error && isPermanentError(prevResult.matchResult.errorCode, prevResult.matchResult.error)) {
              return;
            }

            // Size-related errors may resolve when screen changes (different resolution/scale)
            // Only retry if screen has changed
            if (prevResult?.matchResult.error && isSizeRelatedError(prevResult.matchResult.errorCode, prevResult.matchResult.error)) {
              if (screenChanged) {
                imagesToRematchWithIndex.push({ img, originalIndex: idx });
              }
              return;
            }

            if (!prevResult) {
              // No previous result, try matching
              imagesToRematchWithIndex.push({ img, originalIndex: idx });
            } else if (screenChanged) {
              // Screen changed: re-match ALL images (including found ones) to update coordinates
              imagesToRematchWithIndex.push({ img, originalIndex: idx });
            } else if (!prevResult.matchResult.found) {
              // Screen unchanged, not found previously: re-try matching
              imagesToRematchWithIndex.push({ img, originalIndex: idx });
            }
            // Skip: screen unchanged AND already found (coordinates still valid)
          });

          if (imagesToRematchWithIndex.length > 0) {
            try {
              const reMatchResults = await invoke<HintImageMatchResult[]>('match_hint_images', {
                screenshotBase64: captureResult.imageBase64,
                templateImages: imagesToRematchWithIndex.map(({ img }) => ({
                  imageData: img.image_data,
                  fileName: img.file_name,
                })),
                scaleFactor: captureResult.scaleFactor,
                confidenceThreshold: 0.7,
              });

              // Update stored results with new matches
              // IMPORTANT: Use preserved originalIndex instead of findIndex to handle duplicate file_name
              let updatedCount = 0;
              for (let i = 0; i < reMatchResults.length; i++) {
                const result = reMatchResults[i];
                // Map result back to original index using the preserved mapping
                const originalIndex = imagesToRematchWithIndex[i].originalIndex;
                // Update with correct original index
                const updatedResult = { ...result, index: originalIndex };
                hintImageMatchResults.set(originalIndex, updatedResult);
                if (result.matchResult.found) {
                  updatedCount++;
                }
              }

              if (updatedCount > 0) {
                log(`[Agent Loop] Re-matching updated ${updatedCount} hint image(s)${screenChanged ? ' (screen changed)' : ''}`);

                // Build updated coordinates text from all found images
                const allFoundCoordinates = Array.from(hintImageMatchResults.values())
                  .filter((r) => r.matchResult.found && !r.matchResult.error)
                  .sort((a, b) => a.index - b.index)
                  .map(
                    (r) =>
                      `画像${r.index + 1}(${r.fileName}): ${r.matchResult.centerX},${r.matchResult.centerY}`
                  )
                  .join(' / ');

                if (allFoundCoordinates) {
                  updatedCoordinatesText = `\n\n【更新された座標情報】\n${allFoundCoordinates}`;
                }
              } else if (screenChanged) {
                // Screen changed but no images were detected
                // Inform LLM that previous coordinates are no longer valid
                const totalFoundCount = Array.from(hintImageMatchResults.values()).filter(
                  (r) => r.matchResult.found && !r.matchResult.error
                ).length;

                if (totalFoundCount === 0) {
                  log(`[Agent Loop] Screen changed but no hint images detected - invalidating previous coordinates`);
                  updatedCoordinatesText = `\n\n【座標情報】\n画面が変更されましたが、ヒント画像を検出できませんでした。以前の座標は無効です。`;
                }
              }
            } catch (error) {
              // Re-matching failed, continue without update
              log(`[Agent Loop] Re-matching error (continuing): ${error}`);
            }
          }
        }

        // Build tool result
        const toolResultText = updatedCoordinatesText
          ? `Action executed successfully${updatedCoordinatesText}`
          : 'Action executed successfully';

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: [
            {
              type: 'text',
              text: toolResultText,
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
      executedActions,
      completedActionCount: executedActions.filter((a) => a.success).length,
      lastSuccessfulAction: executedActions.filter((a) => a.success).pop()?.description,
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
      executedActions,
      completedActionCount: executedActions.filter((a) => a.success).length,
      lastSuccessfulAction: executedActions.filter((a) => a.success).pop()?.description,
      failedAtAction: errorMessage,
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
 * Call Claude API with abort support via Supabase Edge Function
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
    const apiPromise = callClaudeAPIViaProxy(
      messages,
      captureResult,
      modelConfig,
      RESULT_SCHEMA_INSTRUCTION
    );

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
