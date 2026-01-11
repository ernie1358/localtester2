/**
 * Action Validator - 期待アクションとClaudeのtool_useを照合
 */

import { getClaudeClient } from './claudeClient';
import type { ExpectedAction, ComputerAction } from '../types';

/** シナリオから期待アクション列を抽出するためのプロンプト */
const EXTRACT_ACTIONS_PROMPT = `
ユーザーのテストシナリオを分析し、期待されるアクション列をJSON形式で抽出してください。

出力形式:
{
  "expectedActions": [
    {
      "description": "アクションの説明（例: Chromeアイコンをクリック）",
      "keywords": ["関連キーワード1", "関連キーワード2"],
      "targetElements": ["対象要素名1", "対象要素名2"],
      "expectedToolAction": "期待されるアクション種別（left_click, double_click, type, key, scroll, wait など）"
    }
  ]
}

注意:
- 各アクションは実行順に並べてください
- keywordsには画面上で探すべき要素名やアプリ名を含めてください
- targetElementsには具体的なUI要素名を含めてください（例: "Chromeアイコン", "アドレスバー", "検索ボックス"）
- expectedToolActionは: left_click, double_click, right_click, type, key, scroll, wait のいずれか
- wait, screenshot, mouse_move, scroll などの非プログレッシブアクションでもキーワードを必ず含めてください
`;

/** extractExpectedActionsの戻り値型 */
export interface ExtractExpectedActionsResult {
  expectedActions: ExpectedAction[];
  isFromFallback: boolean;
}

/** 期待アクション列の妥当性検証結果 */
export interface ValidationResult {
  isValid: boolean;
  reason?: string;
  stepCountHint?: number;
}

/**
 * シナリオからステップ数ヒントを抽出
 * 「3ステップ」「5つの操作」などの表現や番号付きリストを検出
 */
export function extractStepCountHint(scenarioDescription: string): number | undefined {
  // 番号付きリストを検出（1. 2. 3. など）
  const numberedListMatches = scenarioDescription.match(/^\s*\d+\.\s+/gm);
  if (numberedListMatches && numberedListMatches.length >= 2) {
    return numberedListMatches.length;
  }

  // 「3ステップ」「5つの操作」などのパターン
  const stepPatterns = [
    /(\d+)\s*(?:ステップ|step|steps)/i,
    /(\d+)\s*(?:つの)?(?:操作|アクション|action|actions)/i,
  ];

  for (const pattern of stepPatterns) {
    const match = scenarioDescription.match(pattern);
    if (match) {
      return parseInt(match[1], 10);
    }
  }

  // 連接語ベースのヒューリスティック（「次に」「そして」「then」等）
  const conjunctions = [
    /次に/g,
    /そして/g,
    /その後/g,
    /続いて/g,
    /then/gi,
    /after that/gi,
    /and then/gi,
    /、\s*(?=\S)/g, // 読点区切り
  ];

  let conjunctionCount = 0;
  for (const pattern of conjunctions) {
    const matches = scenarioDescription.match(pattern);
    if (matches) {
      conjunctionCount += matches.length;
    }
  }

  // 連接語が見つかった場合、連接語数+1をステップ数とする
  if (conjunctionCount >= 1) {
    return conjunctionCount + 1;
  }

  return undefined;
}

/**
 * 期待アクション列の妥当性を検証
 */
export function validateExpectedActionsCount(
  expectedActions: ExpectedAction[],
  scenarioDescription: string
): ValidationResult {
  const stepCountHint = extractStepCountHint(scenarioDescription);

  // 最低件数検証
  if (expectedActions.length === 0) {
    return {
      isValid: false,
      reason: 'No expected actions extracted',
      stepCountHint,
    };
  }

  // ステップ数ヒントとの乖離チェック
  if (stepCountHint !== undefined && expectedActions.length > 0) {
    const ratio = expectedActions.length / stepCountHint;
    if (ratio < 0.5) {
      // 抽出数がヒントの50%未満の場合は警告
      console.warn(
        `[Action Validator] Expected actions count (${expectedActions.length}) is less than 50% of step hint (${stepCountHint})`
      );
      return {
        isValid: false,
        reason: `Expected ${stepCountHint} steps but only ${expectedActions.length} extracted`,
        stepCountHint,
      };
    }
  }

  return {
    isValid: true,
    stepCountHint,
  };
}

/**
 * シナリオから期待アクション列を抽出
 * 失敗時はシナリオ全体を1つの期待アクションとして返す（フォールバック）
 */
export async function extractExpectedActions(
  scenarioDescription: string
): Promise<ExtractExpectedActionsResult> {
  try {
    const client = await getClaudeClient();

    // テキスト処理のみなので、通常のSonnetモデルを使用
    const EXTRACTION_MODEL = 'claude-sonnet-4-20250514';

    const response = await client.messages.create({
      model: EXTRACTION_MODEL,
      max_tokens: 1024,
      system: EXTRACT_ACTIONS_PROMPT,
      messages: [{ role: 'user', content: scenarioDescription }],
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type');
    }

    // JSONを抽出
    let jsonText = content.text.trim();
    const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonText = jsonMatch[1].trim();
    }

    const result = JSON.parse(jsonText);

    if (!result.expectedActions || result.expectedActions.length === 0) {
      throw new Error('No expected actions extracted');
    }

    const expectedActions = (result.expectedActions || []).map(
      (a: Omit<ExpectedAction, 'completed'>) => ({
        ...a,
        completed: false,
      })
    );

    // 妥当性検証
    const validation = validateExpectedActionsCount(
      expectedActions,
      scenarioDescription
    );
    if (!validation.isValid) {
      console.warn(`[Action Validator] Validation failed: ${validation.reason}`);
      // 妥当性検証失敗でもフォールバックにせず、警告のみ
      // Claudeの成功JSON + tool_use停止で判定する
    }

    return {
      expectedActions,
      isFromFallback: false,
    };
  } catch (error) {
    console.warn('Failed to extract expected actions, using fallback:', error);

    // フォールバック: シナリオ全体を1つの期待アクションとして返す
    return {
      expectedActions: [
        {
          description: scenarioDescription,
          keywords: extractBasicKeywords(scenarioDescription),
          targetElements: [],
          expectedToolAction: undefined,
          completed: false,
        },
      ],
      isFromFallback: true,
    };
  }
}

/**
 * シナリオからキーワードを簡易抽出（フォールバック用）
 */
function extractBasicKeywords(scenario: string): string[] {
  const keywords: string[] = [];

  // 一般的なアプリ名
  const appNames = [
    'chrome',
    'safari',
    'firefox',
    'vscode',
    'terminal',
    'finder',
    'メモ帳',
    'notepad',
    'excel',
    'word',
    'powerpoint',
    'slack',
    'discord',
    'zoom',
  ];
  for (const app of appNames) {
    if (scenario.toLowerCase().includes(app.toLowerCase())) {
      keywords.push(app);
    }
  }

  // 操作キーワード
  const actionKeywords = [
    'クリック',
    'click',
    '入力',
    'type',
    '開く',
    'open',
    '起動',
    '検索',
    'search',
    'スクロール',
    'scroll',
    '待つ',
    'wait',
  ];
  for (const kw of actionKeywords) {
    if (scenario.toLowerCase().includes(kw.toLowerCase())) {
      keywords.push(kw);
    }
  }

  return keywords;
}

/**
 * Claudeのtool_useが期待アクションと一致するかをチェック
 *
 * - 高信頼マッチ時のみshouldAdvanceIndex=true
 * - 画面変化（screenChanged）を必須条件として組み込む
 * - 非プログレッシブアクション（wait/screenshot/mouse_move/scroll）は例外
 */
export function validateActionAndCheckProgress(
  toolAction: ComputerAction,
  expectedActions: ExpectedAction[],
  currentIndex: number,
  claudeResponseContext?: string,
  screenChanged?: boolean
): {
  isValid: boolean;
  shouldAdvanceIndex: boolean;
  reason?: string;
  confidence: 'high' | 'medium' | 'low';
  needsClaudeVerification: boolean;
  requiresScreenChange: boolean;
  expectsSubtleChange?: boolean;
} {
  if (expectedActions.length === 0) {
    return {
      isValid: true,
      shouldAdvanceIndex: false,
      confidence: 'low',
      needsClaudeVerification: false,
      requiresScreenChange: false,
    };
  }

  if (currentIndex >= expectedActions.length) {
    // 期待以上のアクションが実行された（追加アクションは許容）
    return {
      isValid: true,
      shouldAdvanceIndex: false,
      confidence: 'medium',
      needsClaudeVerification: false,
      requiresScreenChange: false,
    };
  }

  const expected = expectedActions[currentIndex];
  const actionType = toolAction.action;

  // クリック系かどうかを判定
  const isClickAction =
    actionType.includes('click') ||
    actionType === 'mouse_move' ||
    actionType === 'left_mouse_down' ||
    actionType === 'left_mouse_up' ||
    actionType === 'left_click_drag';

  // 非プログレッシブアクションの判定
  const nonProgressiveActions = [
    'wait',
    'screenshot',
    'mouse_move',
    'scroll',
  ];
  const isNonProgressiveAction = nonProgressiveActions.includes(toolAction.action);

  // 軽微な画面変化を期待するアクションの判定
  const subtleChangeActions = ['left_click', 'triple_click'];
  const expectsSubtleChange = subtleChangeActions.includes(toolAction.action);

  // 1. キーワード/テキストのチェック
  let keywordMatchCount = 0;

  if (expected.keywords && expected.keywords.length > 0) {
    if (toolAction.text) {
      // type/keyアクション: テキスト内のキーワードマッチ
      const textLower = toolAction.text.toLowerCase();
      keywordMatchCount = expected.keywords.filter((kw) =>
        textLower.includes(kw.toLowerCase())
      ).length;
    } else if (claudeResponseContext) {
      // クリック系: 直前のClaude応答テキストからコンテキストを取得
      const contextLower = claudeResponseContext.toLowerCase();
      keywordMatchCount = expected.keywords.filter((kw) =>
        contextLower.includes(kw.toLowerCase())
      ).length;
    }
  }

  // 2. targetElementsとの照合
  let targetElementMatchCount = 0;
  if (
    expected.targetElements &&
    expected.targetElements.length > 0 &&
    claudeResponseContext
  ) {
    const contextLower = claudeResponseContext.toLowerCase();
    targetElementMatchCount = expected.targetElements.filter((el) =>
      contextLower.includes(el.toLowerCase())
    ).length;
  }

  // 3. アクション種別のチェック
  let actionTypeMatches = false;
  let actionTypeStrictMatch = false;

  if (expected.expectedToolAction) {
    const expectedType = expected.expectedToolAction.toLowerCase();
    const actualType = actionType.toLowerCase();

    const isGenericClick = expectedType === 'click';
    const isClickExpected = expectedType.includes('click');
    const isClickActual = actualType.includes('click');

    if (isGenericClick && isClickActual) {
      actionTypeMatches = true;
      actionTypeStrictMatch = false;
    } else if (expectedType === actualType) {
      actionTypeMatches = true;
      actionTypeStrictMatch = true;
    } else if (isClickExpected && isClickActual) {
      actionTypeMatches = true;
      actionTypeStrictMatch = false;
    } else {
      actionTypeMatches = false;
      actionTypeStrictMatch = false;
    }
  } else {
    actionTypeMatches = true;
    actionTypeStrictMatch = false;
  }

  // 4. 信頼度判定と進行判断
  const highConfidenceByKeyword =
    keywordMatchCount >= 2 || (keywordMatchCount >= 1 && actionTypeStrictMatch);
  const highConfidenceByTarget =
    targetElementMatchCount >= 1 && actionTypeStrictMatch;

  // 非プログレッシブアクションでactionType厳密一致のみでも高信頼扱い
  const highConfidenceByActionTypeOnly =
    isNonProgressiveAction && actionTypeStrictMatch;

  if (
    highConfidenceByKeyword ||
    highConfidenceByTarget ||
    highConfidenceByActionTypeOnly
  ) {
    const requiresScreenChangeForProgress = !isNonProgressiveAction;

    // 微小変化アクションで画面変化なしの場合の特別処理
    if (expectsSubtleChange && !screenChanged && requiresScreenChangeForProgress) {
      return {
        isValid: true,
        shouldAdvanceIndex: false,
        confidence: 'high',
        needsClaudeVerification: false,
        requiresScreenChange: true,
        expectsSubtleChange: true,
      };
    }

    const canAdvanceIndex =
      !requiresScreenChangeForProgress || screenChanged === true;

    return {
      isValid: true,
      shouldAdvanceIndex: canAdvanceIndex,
      confidence: 'high',
      needsClaudeVerification: false,
      requiresScreenChange: requiresScreenChangeForProgress,
      expectsSubtleChange,
    };
  }

  // 中信頼度パターン
  const mediumConfidence =
    keywordMatchCount >= 1 || targetElementMatchCount >= 1 || actionTypeMatches;

  if (mediumConfidence) {
    return {
      isValid: true,
      shouldAdvanceIndex: false,
      confidence: 'medium',
      needsClaudeVerification: isClickAction,
      requiresScreenChange: !isNonProgressiveAction,
    };
  }

  // 低信頼度: 一致なし
  return {
    isValid: true,
    shouldAdvanceIndex: false,
    confidence: 'low',
    needsClaudeVerification: false,
    requiresScreenChange: false,
  };
}

/**
 * Claudeに現在の期待アクションが達成されたかを確認させる
 * 高信頼度の進行判定が得られない場合に使用
 */
export async function askClaudeForActionCompletion(
  scenarioDescription: string,
  expectedAction: ExpectedAction,
  completedToolUses: string[],
  currentScreenshotBase64: string
): Promise<{ isCompleted: boolean; reason?: string }> {
  try {
    const client = await getClaudeClient();

    const prompt = `
ユーザーのシナリオ:
${scenarioDescription}

現在確認したい期待アクション:
- 説明: ${expectedAction.description}
- キーワード: ${expectedAction.keywords.join(', ')}
- 対象要素: ${expectedAction.targetElements?.join(', ') || '指定なし'}

これまでに実行したtool_use:
${completedToolUses.length > 0 ? completedToolUses.join('\n') : '(なし)'}

質問: 現在の画面を見て、上記の期待アクション「${expectedAction.description}」は達成されましたか？

以下のJSON形式で回答してください:
\`\`\`json
{"isCompleted": true/false, "reason": "判断理由"}
\`\`\`
`;

    // ビジョン対応の通常モデルを使用
    const VISION_MODEL = 'claude-sonnet-4-20250514';

    const response = await client.messages.create({
      model: VISION_MODEL,
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: currentScreenshotBase64,
              },
            },
          ],
        },
      ],
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      return { isCompleted: false };
    }

    const jsonMatch = content.text.match(/```json\s*(\{[\s\S]*?\})\s*```/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1]);
    }

    return { isCompleted: false };
  } catch (error) {
    console.warn('Action completion check failed, assuming not completed:', error);
    return { isCompleted: false };
  }
}
