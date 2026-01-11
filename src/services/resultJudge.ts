/**
 * Test result judgment module
 * Analyzes Claude's response and execution state to determine test outcome
 */

import type { BetaMessage, BetaTextBlock } from '@anthropic-ai/sdk/resources/beta/messages';
import type {
  TestResult,
  TestResultStatus,
  FailureReason,
  ProgressTracker,
  ClaudeResultOutput,
  ExpectedAction,
  AdditionalConfirmation,
} from '../types';
import type { ComputerAction, ComputerActionType } from '../types';
import { hashAction } from '../utils/loopDetector';
import { getClaudeClient } from './claudeClient';

/** Configuration for stuck detection */
export interface StuckDetectionConfig {
  maxUnchangedScreenshots: number;
  maxSameActionRepeats: number;
}

export const DEFAULT_STUCK_DETECTION_CONFIG: StuckDetectionConfig = {
  maxUnchangedScreenshots: 3,
  maxSameActionRepeats: 5,
};

/** Configuration for screen change detection with noise tolerance */
export interface ScreenChangeDetectionConfig {
  /** Minimum diff ratio to consider as meaningful change (0.0-1.0) */
  minDiffRatio: number;
  /** Maximum diff ratio to consider as noise (0.0-1.0) */
  noiseThreshold: number;
}

export const DEFAULT_SCREEN_CHANGE_CONFIG: ScreenChangeDetectionConfig = {
  minDiffRatio: 0.01, // 1% difference minimum
  noiseThreshold: 0.005, // 0.5% or less is noise
};

/**
 * Simple hash for screenshot comparison
 * Uses sampling to reduce computation
 */
export function hashScreenshot(base64Data: string): string {
  const sample =
    base64Data.slice(0, 1000) +
    base64Data.slice(
      Math.floor(base64Data.length / 2),
      Math.floor(base64Data.length / 2) + 1000
    ) +
    base64Data.slice(-1000);

  let hash = 0;
  for (let i = 0; i < sample.length; i++) {
    const char = sample.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

/**
 * Check for significant screen change with noise tolerance
 */
export function hasSignificantScreenChange(
  previousBase64: string,
  currentBase64: string,
  config: ScreenChangeDetectionConfig = DEFAULT_SCREEN_CHANGE_CONFIG
): { changed: boolean; diffRatio: number; isNoise: boolean } {
  // Simple comparison using hash
  const prevHash = hashScreenshot(previousBase64);
  const currHash = hashScreenshot(currentBase64);

  if (prevHash === currHash) {
    return { changed: false, diffRatio: 0, isNoise: false };
  }

  // Approximate diff ratio based on sample comparison
  const sampleLength = 3000;
  const prevSample =
    previousBase64.slice(0, 1000) +
    previousBase64.slice(
      Math.floor(previousBase64.length / 2),
      Math.floor(previousBase64.length / 2) + 1000
    ) +
    previousBase64.slice(-1000);
  const currSample =
    currentBase64.slice(0, 1000) +
    currentBase64.slice(
      Math.floor(currentBase64.length / 2),
      Math.floor(currentBase64.length / 2) + 1000
    ) +
    currentBase64.slice(-1000);

  let diffCount = 0;
  const minLength = Math.min(prevSample.length, currSample.length);
  for (let i = 0; i < minLength; i++) {
    if (prevSample[i] !== currSample[i]) {
      diffCount++;
    }
  }

  const diffRatio = diffCount / sampleLength;
  const isNoise = diffRatio <= config.noiseThreshold;
  const changed = diffRatio >= config.minDiffRatio;

  return { changed, diffRatio, isNoise };
}

/**
 * 画面変化が起きにくいアクションかどうかを判定
 */
function isNonProgressiveAction(action: ComputerAction): boolean {
  const nonProgressiveActions: ComputerActionType[] = [
    'wait',
    'screenshot',
    'mouse_move',
    'scroll',
  ];
  return nonProgressiveActions.includes(action.action);
}

/**
 * 軽微な画面変化が期待されるアクションかどうかを判定
 */
function expectsSubtleScreenChange(action: ComputerAction): boolean {
  const subtleChangeActions: ComputerActionType[] = ['left_click', 'triple_click'];
  return subtleChangeActions.includes(action.action);
}

/**
 * Check if progress is being made based on screenshot changes and action repetition
 * checkProgressは同一アクション検出を統合（二重カウント防止）
 */
export function checkProgress(
  tracker: ProgressTracker,
  currentScreenshotBase64: string,
  currentAction: ComputerAction,
  config: StuckDetectionConfig = DEFAULT_STUCK_DETECTION_CONFIG
): { isStuck: boolean; reason?: FailureReason; details?: string } {
  const currentScreenshotHash = hashScreenshot(currentScreenshotBase64);
  const currentActionHash = hashAction(currentAction);

  const isNonProgressive = isNonProgressiveAction(currentAction);
  const expectsSubtle = expectsSubtleScreenChange(currentAction);

  // Check screenshot change
  if (!isNonProgressive) {
    if (currentScreenshotHash === tracker.lastScreenshotHash) {
      tracker.unchangedCount++;

      // 微小変化アクションは閾値を緩和
      const effectiveMaxUnchanged = expectsSubtle
        ? config.maxUnchangedScreenshots * 2
        : config.maxUnchangedScreenshots;

      if (tracker.unchangedCount >= effectiveMaxUnchanged) {
        return {
          isStuck: true,
          reason: 'action_no_effect',
          details: `Screen unchanged for ${tracker.unchangedCount} consecutive actions`,
        };
      }
    } else {
      tracker.unchangedCount = 0;
    }
  }
  tracker.lastScreenshotHash = currentScreenshotHash;

  // 同一アクション連続検出
  const maxRepeats = isNonProgressive
    ? Math.max(config.maxSameActionRepeats * 2, 10)
    : config.maxSameActionRepeats;

  if (currentActionHash === tracker.lastActionHash) {
    tracker.sameActionCount++;
    if (tracker.sameActionCount >= maxRepeats) {
      return {
        isStuck: true,
        reason: 'stuck_in_loop',
        details: `Same action repeated ${tracker.sameActionCount} times`,
      };
    }
  } else {
    tracker.sameActionCount = 1;
    tracker.lastActionHash = currentActionHash;
  }

  return { isStuck: false };
}

/**
 * Create a test result object
 */
export function createTestResult(params: {
  status: TestResultStatus;
  failureReason?: FailureReason;
  failureDetails?: string;
  completedSteps: number;
  completedActionIndex: number;
  totalExpectedSteps?: number;
  lastAction?: string;
  claudeAnalysis?: string;
  claudeResultOutput?: ClaudeResultOutput;
  startedAt: Date;
}): TestResult {
  const completedAt = new Date();
  return {
    status: params.status,
    failureReason: params.failureReason,
    failureDetails: params.failureDetails,
    completedSteps: params.completedSteps,
    completedActionIndex: params.completedActionIndex,
    totalExpectedSteps: params.totalExpectedSteps,
    lastAction: params.lastAction,
    claudeAnalysis: params.claudeAnalysis,
    claudeResultOutput: params.claudeResultOutput,
    startedAt: params.startedAt,
    completedAt,
    durationMs: completedAt.getTime() - params.startedAt.getTime(),
  };
}

/**
 * Initialize a progress tracker
 */
export function createProgressTracker(): ProgressTracker {
  return {
    lastScreenshotHash: '',
    unchangedCount: 0,
    lastActionType: '',
    lastActionHash: '',
    sameActionCount: 0,
  };
}

/** Claudeの応答から結果JSONを抽出（寛容なパーサ） */
function extractResultJson(responseText: string): ClaudeResultOutput | null {
  // Pattern 1: ```json or ```JSON fenced code block (case-insensitive)
  const fencedMatch = responseText.match(
    /```(?:json|JSON)\s*(\{[\s\S]*?"status"\s*:\s*"(?:success|failure)"[\s\S]*?\})\s*```/i
  );

  if (fencedMatch) {
    try {
      const parsed = JSON.parse(fencedMatch[1]);
      if (parsed.status === 'success' || parsed.status === 'failure') {
        return parsed as ClaudeResultOutput;
      }
    } catch {
      // Continue to next pattern
    }
  }

  // Pattern 2: Plain JSON object without code fence
  const plainJsonMatch = responseText.match(
    /(\{[^{}]*"status"\s*:\s*"(?:success|failure)"[^{}]*\})/
  );

  if (plainJsonMatch) {
    try {
      const parsed = JSON.parse(plainJsonMatch[1]);
      if (parsed.status === 'success' || parsed.status === 'failure') {
        return parsed as ClaudeResultOutput;
      }
    } catch {
      // Continue to next pattern
    }
  }

  // Pattern 3: Any code fence block containing status (fallback)
  const anyFenceMatch = responseText.match(
    /```\s*(\{[\s\S]*?"status"\s*:\s*"(?:success|failure)"[\s\S]*?\})\s*```/
  );

  if (anyFenceMatch) {
    try {
      const parsed = JSON.parse(anyFenceMatch[1]);
      if (parsed.status === 'success' || parsed.status === 'failure') {
        return parsed as ClaudeResultOutput;
      }
    } catch {
      // Failed to parse
    }
  }

  return null;
}

/**
 * Claudeの失敗理由をFailureReasonにマッピング
 */
function mapClaudeFailureReason(claudeReason?: string): FailureReason {
  if (!claudeReason) return 'unknown';

  const reasonLower = claudeReason.toLowerCase();

  if (reasonLower.includes('見つから') || reasonLower.includes('not found')) {
    return 'element_not_found';
  }
  if (reasonLower.includes('効果なし') || reasonLower.includes('no effect')) {
    return 'action_no_effect';
  }
  if (reasonLower.includes('予期しない') || reasonLower.includes('unexpected')) {
    return 'unexpected_state';
  }

  return 'unknown';
}

/**
 * フォールバック時の完了検証
 * 最終画面でキーワードの存在を確認し、追加の検証を行う
 */
export async function verifyFallbackCompletion(
  scenarioDescription: string,
  finalScreenshotBase64: string,
  basicKeywords: string[],
  options?: {
    previousScreenshotBase64?: string;
    lastExecutedAction?: string;
    initialScreenshotBase64?: string;
  }
): Promise<AdditionalConfirmation> {
  try {
    const client = await getClaudeClient();
    const VISION_MODEL = 'claude-sonnet-4-20250514';

    let prompt = `
シナリオ: ${scenarioDescription}

キーワード: ${basicKeywords.join(', ')}

質問:
1. 現在の画面を見て、上記シナリオは正常に完了していますか？
2. 期待される最終状態になっていますか？
`;

    // 直前画面との差分検証を追加
    if (options?.previousScreenshotBase64) {
      prompt += `
3. 直前の画面から意味のある変化がありましたか？
`;
    }

    // 最終アクションの期待結果確認を追加
    if (options?.lastExecutedAction) {
      prompt += `
4. 最後に実行したアクション「${options.lastExecutedAction}」は期待通りの結果になっていますか？
`;
    }

    prompt += `
以下のJSON形式で回答してください:
\`\`\`json
{"verified": true/false, "reason": "判断理由", "confidence": "high/medium/low"}
\`\`\`
`;

    // Build content array with screenshots
    const contentArray: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } }
    > = [{ type: 'text', text: prompt }];

    // Add previous screenshot for comparison if available
    if (options?.previousScreenshotBase64) {
      contentArray.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: options.previousScreenshotBase64,
        },
      });
      contentArray.push({ type: 'text', text: '↑ 直前の画面 / ↓ 現在の画面' });
    }

    // Add final screenshot
    contentArray.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: finalScreenshotBase64,
      },
    });

    const messages: Array<{
      role: 'user' | 'assistant';
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } }
      >;
    }> = [
      {
        role: 'user',
        content: contentArray,
      },
    ];

    const response = await client.messages.create({
      model: VISION_MODEL,
      max_tokens: 256,
      messages,
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      return { verified: false, reason: 'Unexpected response type' };
    }

    const jsonMatch = content.text.match(/```json\s*(\{[\s\S]*?\})\s*```/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[1]);
      // Low confidenceは失敗扱い
      if (result.confidence === 'low') {
        return {
          verified: false,
          reason: result.reason || 'Low confidence verification',
          confidence: 'low',
        };
      }
      return {
        verified: result.verified === true,
        reason: result.reason,
        confidence: result.confidence,
      };
    }

    return { verified: false, reason: 'Could not parse response' };
  } catch (error) {
    console.warn('Fallback completion verification failed:', error);
    return { verified: false, reason: 'Verification error' };
  }
}

/**
 * 結果判定を強化したanalyzeClaudeResponse（統一判定フロー v18）
 *
 * 判定フロー:
 * 1. tool_useがある → 継続
 * 2. tool_useがない（完了判定）:
 *    a. Claude結果JSONあり
 *       - success: 期待アクション全完了 or isFromFallback → 成功
 *       - success: 期待アクション未完了 → incomplete_actions失敗
 *       - failure: 期待アクション全完了 → 進捗優先で成功
 *       - failure: 期待アクション未完了 → Claude失敗報告採用
 *    b. Claude結果JSONなし
 *       - 期待アクション全完了 → 成功（進捗ベース）
 *       - isFromFallback + additionalConfirmation.verified → 成功
 *       - それ以外 → incomplete_actions失敗
 */
export function analyzeClaudeResponse(
  response: BetaMessage,
  expectedActions: ExpectedAction[],
  completedActionIndex: number,
  isFromFallback: boolean = false,
  additionalConfirmation?: AdditionalConfirmation
): {
  isComplete: boolean;
  isSuccess: boolean;
  analysis: string;
  resultOutput?: ClaudeResultOutput;
  failureReason?: FailureReason;
  successByProgress: boolean;
  shouldContinue: boolean;
} {
  const textBlocks = response.content.filter(
    (block): block is BetaTextBlock => block.type === 'text'
  );

  const fullText = textBlocks.map((b) => b.text).join('\n');
  const hasToolUse = response.content.some((block) => block.type === 'tool_use');

  const resultOutput = extractResultJson(fullText);

  const allExpectedActionsCompleted =
    expectedActions.length > 0 && completedActionIndex >= expectedActions.length;

  if (resultOutput) {
    if (resultOutput.status === 'success') {
      // Claudeが成功を報告
      if (allExpectedActionsCompleted) {
        return {
          isComplete: true,
          isSuccess: true,
          analysis: resultOutput.message,
          resultOutput,
          successByProgress: false,
          shouldContinue: false,
        };
      } else if (expectedActions.length === 0) {
        console.warn(
          '[Result Judge] No expected actions extracted - trusting Claude success report'
        );
        return {
          isComplete: true,
          isSuccess: true,
          analysis: resultOutput.message,
          resultOutput,
          successByProgress: false,
          shouldContinue: false,
        };
      } else if (isFromFallback) {
        // フォールバック時はClaude成功報告を採用
        console.warn(
          '[Result Judge] Fallback mode - trusting Claude success report'
        );
        return {
          isComplete: true,
          isSuccess: true,
          analysis: resultOutput.message,
          resultOutput,
          successByProgress: false,
          shouldContinue: false,
        };
      } else {
        // 期待アクション未完了
        console.warn(
          `[Result Judge] Claude reported success but only ${completedActionIndex}/${expectedActions.length} expected actions completed`
        );

        if (hasToolUse) {
          return {
            isComplete: false,
            isSuccess: false,
            analysis: `Claude reported success but expected actions incomplete (${completedActionIndex}/${expectedActions.length})`,
            resultOutput,
            successByProgress: false,
            shouldContinue: true,
          };
        }

        return {
          isComplete: true,
          isSuccess: false,
          analysis: `Claude reported success but expected actions incomplete (${completedActionIndex}/${expectedActions.length})`,
          resultOutput,
          failureReason: 'incomplete_actions',
          successByProgress: false,
          shouldContinue: false,
        };
      }
    } else {
      // Claudeが失敗を報告
      // 期待アクション全完了なら進捗を優先
      if (allExpectedActionsCompleted) {
        console.warn(
          `[Result Judge] Claude reported failure but all expected actions completed (${completedActionIndex}/${expectedActions.length})`
        );
        console.log(
          '[Result Judge] Overriding Claude failure with progress-based success'
        );
        return {
          isComplete: true,
          isSuccess: true,
          analysis: `All expected actions completed despite Claude failure report: ${resultOutput.message}`,
          resultOutput,
          successByProgress: true,
          shouldContinue: false,
        };
      }

      return {
        isComplete: true,
        isSuccess: false,
        analysis: resultOutput.message,
        resultOutput,
        failureReason: mapClaudeFailureReason(resultOutput.failureReason),
        successByProgress: false,
        shouldContinue: false,
      };
    }
  }

  // tool_useがない = 完了判定が必要
  const isComplete = !hasToolUse;

  if (isComplete) {
    // フォールバック時のJSON欠如対応
    if (isFromFallback && !resultOutput) {
      // 追加根拠チェック
      if (additionalConfirmation?.verified) {
        console.log(
          '[Result Judge] Fallback mode: verified by additional confirmation'
        );
        return {
          isComplete: true,
          isSuccess: true,
          analysis:
            additionalConfirmation.reason ||
            'Scenario completed (fallback mode with verification)',
          successByProgress: true,
          shouldContinue: false,
        };
      }

      // 追加根拠なし → 失敗
      console.warn(
        '[Result Judge] Fallback mode: no JSON and no additional confirmation'
      );
      return {
        isComplete: true,
        isSuccess: false,
        analysis:
          'Fallback mode completed but no success confirmation available',
        failureReason: 'incomplete_actions',
        successByProgress: false,
        shouldContinue: false,
      };
    }

    // 期待アクション進捗に基づくフォールバック
    console.warn(
      '[Result Judge] Claude did not provide structured result output - using progress-based fallback'
    );

    if (allExpectedActionsCompleted) {
      console.log('[Result Judge] All expected actions completed - treating as success');
      return {
        isComplete: true,
        isSuccess: true,
        analysis:
          textBlocks.length > 0
            ? textBlocks[textBlocks.length - 1].text
            : 'All expected actions completed',
        successByProgress: true,
        shouldContinue: false,
      };
    }

    return {
      isComplete: true,
      isSuccess: false,
      analysis:
        textBlocks.length > 0
          ? textBlocks[textBlocks.length - 1].text
          : 'No analysis provided',
      failureReason:
        expectedActions.length === 0 ? 'invalid_result_format' : 'incomplete_actions',
      successByProgress: false,
      shouldContinue: false,
    };
  }

  return {
    isComplete: false,
    isSuccess: false,
    analysis: '',
    successByProgress: false,
    shouldContinue: false,
  };
}

/**
 * アクション実行エラーをFailureReasonにマッピング
 */
export function mapExecutionErrorToFailureReason(error: string): FailureReason {
  const errorLower = error.toLowerCase();

  if (
    errorLower.includes('not found') ||
    errorLower.includes('見つから') ||
    errorLower.includes('element') ||
    errorLower.includes('要素')
  ) {
    return 'element_not_found';
  }

  if (errorLower.includes('click') || errorLower.includes('クリック')) {
    return 'action_execution_error';
  }

  return 'action_execution_error';
}
