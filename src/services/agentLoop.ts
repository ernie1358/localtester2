/**
 * Agent Loop - Execute a single scenario with Computer Use API
 */

import { invoke } from '@tauri-apps/api/core';
import type {
  BetaMessageParam,
  BetaMessage,
  BetaToolUseBlock,
  BetaToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages';
import { getClaudeClient, buildComputerTool } from './claudeClient';
import { purgeOldImages } from './historyManager';
import { toScreenCoordinate } from '../utils/coordinateScaler';
import { detectLoop, createActionRecord } from '../utils/loopDetector';
import type {
  Scenario,
  CaptureResult,
  ComputerAction,
  ActionRecord,
  AgentLoopConfig,
  ClaudeModelConfig,
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

/** Result of agent loop execution */
export interface AgentLoopResult {
  success: boolean;
  error?: string;
  iterations: number;
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
    // enableZoom is only supported for Opus 4.5 (computer_20251124)
    // Ignore enableZoom for older tool versions
    enableZoom:
      (partial.toolType ?? DEFAULT_CLAUDE_MODEL_CONFIG.toolType) === 'computer_20251124'
        ? (partial.enableZoom ?? DEFAULT_CLAUDE_MODEL_CONFIG.enableZoom)
        : false,
  };
}

/**
 * Execute the agent loop for a single scenario
 */
export async function runAgentLoop(
  options: AgentLoopOptions
): Promise<AgentLoopResult> {
  // Deep merge config with defaults, including modelConfig
  const baseConfig: AgentLoopConfig = {
    ...DEFAULT_AGENT_LOOP_CONFIG,
    ...options.config,
  };
  // Ensure modelConfig is properly merged
  const config: AgentLoopConfig = {
    ...baseConfig,
    modelConfig: mergeModelConfig(options.config?.modelConfig),
  };

  const log = options.onLog ?? console.log;
  let messages: BetaMessageParam[] = [];
  const actionHistory: ActionRecord[] = [];
  let captureResult: CaptureResult;
  let iteration = 0;

  try {
    // Initial screenshot
    log('[Agent Loop] Capturing initial screenshot...');
    log(`[Agent Loop] Scenario description: ${options.scenario.description}`);
    captureResult = await invoke<CaptureResult>('capture_screen');

    // Initial message with scenario description and screenshot
    messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: options.scenario.description },
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
        return { success: false, error: 'Aborted', iterations: iteration };
      }

      const stopRequested = await invoke<boolean>('is_stop_requested');
      if (stopRequested) {
        return { success: false, error: 'Stopped by user', iterations: iteration };
      }

      options.onIteration?.(iteration + 1);
      log(`[Agent Loop] Iteration ${iteration + 1}/${config.maxIterationsPerScenario}`);

      // Call Claude API with model configuration
      const modelConfig = config.modelConfig ?? DEFAULT_CLAUDE_MODEL_CONFIG;
      const response = await callClaudeAPI(messages, captureResult, options.abortSignal, modelConfig);

      // Handle null response (aborted)
      if (!response) {
        return { success: false, error: 'API call aborted', iterations: iteration };
      }

      // Check for completion (no tool_use)
      if (isScenarioComplete(response)) {
        log('[Agent Loop] Scenario completed - no more actions');
        return { success: true, iterations: iteration + 1 };
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
          return { success: false, error: 'Aborted', iterations: iteration };
        }

        const stopCheck = await invoke<boolean>('is_stop_requested');
        if (stopCheck) {
          return { success: false, error: 'Stopped by user', iterations: iteration };
        }

        const action = toolUse.input as ComputerAction;

        // Loop detection
        if (detectLoop(actionHistory, action, config)) {
          return {
            success: false,
            error: `Infinite loop detected: same action repeated ${config.loopDetectionThreshold} times`,
            iterations: iteration,
          };
        }

        // Execute action with detailed logging
        const actionDetails = formatActionDetails(action, captureResult.scaleFactor, captureResult.displayScaleFactor);
        log(`[Agent Loop] Executing: ${actionDetails}`);
        const actionResult = await executeAction(action, captureResult.scaleFactor, captureResult.displayScaleFactor);

        // Add to action history
        actionHistory.push(createActionRecord(toolUse.id, action));

        // Capture result screenshot
        captureResult = await invoke<CaptureResult>('capture_screen');

        // Build tool result
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: [
            {
              type: 'text',
              text: actionResult.success
                ? 'Action executed successfully'
                : `Action failed: ${actionResult.error}`,
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
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`[Agent Loop] Error: ${errorMessage}`);
    return { success: false, error: errorMessage, iterations: iteration };
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

  // Add coordinate info with conversion (includes HiDPI/Retina adjustment)
  if (action.coordinate) {
    const [claudeX, claudeY] = action.coordinate;
    const screenCoord = toScreenCoordinate({ x: claudeX, y: claudeY }, scaleFactor, displayScaleFactor);
    parts.push(`at Claude(${claudeX}, ${claudeY}) → Screen(${screenCoord.x}, ${screenCoord.y}) [DPI:${displayScaleFactor}]`);
  }

  // Add start coordinate for drag actions
  if (action.start_coordinate) {
    const [startX, startY] = action.start_coordinate;
    const screenStart = toScreenCoordinate({ x: startX, y: startY }, scaleFactor, displayScaleFactor);
    parts.push(`from Claude(${startX}, ${startY}) → Screen(${screenStart.x}, ${screenStart.y})`);
  }

  // Add text for type/key actions
  if (action.text) {
    const displayText = action.text.length > 50 ? action.text.substring(0, 50) + '...' : action.text;
    parts.push(`text="${displayText}"`);
  }

  // Add scroll info
  if (action.scroll_direction) {
    parts.push(`direction=${action.scroll_direction}`);
    if (action.scroll_amount) {
      parts.push(`amount=${action.scroll_amount}`);
    }
  }

  // Add duration for wait
  if (action.duration !== undefined) {
    parts.push(`duration=${action.duration}ms`);
  }

  // Add key info for hold_key
  if (action.key) {
    parts.push(`key="${action.key}" ${action.down ? 'down' : 'up'}`);
  }

  return parts.join(' ');
}

/**
 * Check if scenario is complete (no tool_use blocks)
 */
function isScenarioComplete(response: BetaMessage): boolean {
  return !response.content.some((block) => block.type === 'tool_use');
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
  // Define abort handler for cleanup
  let abortHandler: (() => void) | null = null;

  try {
    const client = await getClaudeClient();

    // Build computer tool with model configuration
    // Note: Using type assertion as SDK may not have latest type definitions (computer_20251124)
    // This is intentional and should be updated when SDK supports the new tool version
    const apiPromise = client.beta.messages.create({
      model: modelConfig.model,
      max_tokens: 4096,
      tools: [buildComputerTool(captureResult, modelConfig)] as unknown as Parameters<typeof client.beta.messages.create>[0]['tools'],
      messages,
      betas: [modelConfig.betaHeader],
    });

    // Create abort promise with proper cleanup
    const abortPromise = new Promise<never>((_, reject) => {
      if (abortSignal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      abortHandler = () => reject(new DOMException('Aborted', 'AbortError'));
      abortSignal.addEventListener('abort', abortHandler);
    });

    // Race between API call and abort
    const result = await Promise.race([apiPromise, abortPromise]);
    return result as BetaMessage;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return null;
    }
    throw error;
  } finally {
    // Clean up abort listener to prevent memory leaks
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
        // No action needed, screenshot is taken after this
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
