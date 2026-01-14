/**
 * Action Validator - 期待アクションとClaudeのtool_useを照合
 */

import { callClaudeMessagesViaProxy } from './claudeClient';
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
      "expectedToolAction": "期待されるアクション種別",
      "verificationText": "このアクション後に画面に表示されるべきテキスト（オプション）"
    }
  ]
}

expectedToolActionの選択肢:
- left_click: クリック操作
- double_click: ダブルクリック
- triple_click: トリプルクリック（行選択など）
- right_click: 右クリック（コンテキストメニュー）
- middle_click: 中クリック
- type: テキスト入力
- key: キーボード操作（Enter, Space, Tab など）
- scroll: スクロール
- left_click_drag: ドラッグ操作
- mouse_move: マウス移動のみ（ホバーなど）
- wait: 待機（「〜秒待つ」「しばらく待つ」など）
- screenshot: 画面確認のみ（独立した確認ステップに使用）

重要なルール:
1. 「探す→操作する」パターンの統合（すべての操作タイプに適用）:
   - 「〜を見つけてクリック」→ 1つのleft_clickアクション
   - 「〜を探してダブルクリック」→ 1つのdouble_clickアクション
   - 「〜を見つけて右クリック」→ 1つのright_clickアクション
   - 「〜を見つけて入力」→ 1つのtypeアクション
   - 「〜を見つけてスペースを押す」→ 1つのkeyアクション
   - 「〜を見つけてドラッグ」→ 1つのleft_click_dragアクション
   - 「〜を見つけてスクロール」→ 1つのscrollアクション
   - 理由: 操作を実行するには対象を見つける必要があるため、「探す」と「操作する」は暗黙的に1つのアクションです
   - 例: 「Chromeのアイコンを見つけてクリック」→ {"description": "Chromeアイコンをクリック", "expectedToolAction": "left_click", ...}

2. screenshotの使用方法:
   - 独立した画面確認ステップ（例: 「画面を確認する」「状態を見る」「〜が表示されているか確認」）
   - 注意: 「〜を探して○○する」の「探す」部分には使わない（操作と統合する）
   - 後続に操作があっても、独立した確認ステップとしてscreenshotを使用してOK

3. verificationTextの使用（重要: 画面に実際に表示されるテキストのみ）:
   - 「〜したら『○○』と表示されるはず」→ verificationTextに「○○」を設定
   - 例: 「クリックしたら『書き起こし待機中です』と表示される」→ verificationText: "書き起こし待機中です"
   - 注意: verificationTextには画面上に実際に表示されるテキストのみを設定すること
   - 以下はverificationTextに設定しない（画面に表示されるテキストではないため）:
     * 「ブラウザが立ち上がる」「アプリが起動する」→ 状態の説明であり、画面に表示されるテキストではない
     * 「動画が再生される」「音が鳴る」→ 動作の説明であり、画面に表示されるテキストではない
   - verificationTextを設定したら、同じテキストを確認するための別アクションは生成しない

その他の注意:
- 各アクションは実行順に並べてください
- keywordsには画面上で探すべき要素名やアプリ名を含めてください
- targetElementsには具体的なUI要素名を含めてください
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
    // テキスト処理のみなので、通常のSonnetモデルを使用
    const EXTRACTION_MODEL = 'claude-sonnet-4-20250514';

    const response = await callClaudeMessagesViaProxy(
      EXTRACTION_MODEL,
      1024,
      EXTRACT_ACTIONS_PROMPT,
      [{ role: 'user', content: scenarioDescription }]
    );

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
    console.error('[Action Validator] Failed to extract expected actions:', error);
    console.error('[Action Validator] Error details:', {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    // フォールバックなし: エラーをそのままスローしてテスト失敗にする
    throw new Error(
      `Failed to extract expected actions from scenario: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
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

  // クリック系かどうかを判定（実際のアクション）
  const isClickAction =
    actionType.includes('click') ||
    actionType === 'mouse_move' ||
    actionType === 'left_mouse_down' ||
    actionType === 'left_mouse_up' ||
    actionType === 'left_click_drag';

  // 非プログレッシブアクションの判定（実際のアクション）
  // Non-progressive actions: actions that don't cause visible screen changes
  // scroll is excluded because it should cause visible screen changes when it works correctly
  const nonProgressiveActions = [
    'wait',
    'screenshot',
    'mouse_move',
    'hold_key',  // 修飾キー保持は画面変化を起こさない
  ];
  const isNonProgressiveAction = nonProgressiveActions.includes(toolAction.action);

  // 期待アクションのカテゴリを判定
  const expectedActionType = expected.expectedToolAction?.toLowerCase();
  const isExpectedClickAction = expectedActionType
    ? expectedActionType.includes('click') ||
      expectedActionType === 'mouse_move' ||
      expectedActionType === 'left_mouse_down' ||
      expectedActionType === 'left_mouse_up' ||
      expectedActionType === 'left_click_drag'
    : false;
  // scroll is excluded because it should cause visible screen changes when it works correctly
  // hold_key is included because holding a modifier key doesn't cause screen changes
  const isExpectedNonProgressiveAction = expectedActionType
    ? ['wait', 'screenshot', 'mouse_move', 'hold_key'].includes(expectedActionType)
    : false;

  // アクションタイプの根本的な不一致を検出
  // 1. 期待がクリック系なのに非プログレッシブ（screenshot/wait）を実行した場合は不一致
  // 2. 期待が非プログレッシブなのにクリック系を実行した場合も不一致（逆方向）
  // 3. 期待がtype/keyなのに非プログレッシブ（screenshot/wait）、scroll、またはクリック系を実行した場合も不一致
  // ただし、期待と実行が同じ場合（例: 両方mouse_move）はミスマッチとしない
  const isExpectedTypeOrKey = expectedActionType === 'type' || expectedActionType === 'key';
  const isScrollAction = actionType === 'scroll';
  const isSameActionType = actionType.toLowerCase() === expectedActionType;
  const hasActionTypeMismatch =
    expected.expectedToolAction !== undefined &&
    !isSameActionType &&  // 期待と実行が同じならミスマッチではない
    (
      // 期待がクリック系 + 実アクションが非プログレッシブ（mouse_moveを除く）
      (isExpectedClickAction && isNonProgressiveAction && !actionType.includes('mouse_move')) ||
      // 期待が非プログレッシブ + 実アクションがクリック系（逆方向ミスマッチ）
      (isExpectedNonProgressiveAction && isClickAction) ||
      // 期待がtype/key + 実アクションが非プログレッシブ、scroll、またはクリック系
      (isExpectedTypeOrKey && (isNonProgressiveAction || isScrollAction || isClickAction))
    );

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
  // アクションタイプ不一致がある場合はキーワードマッチだけでは高信頼にしない
  // expectedToolActionが未定義かつ非プログレッシブアクションの場合も保守的に扱う
  const isUnknownExpectedWithNonProgressiveActual =
    expected.expectedToolAction === undefined && isNonProgressiveAction;
  const highConfidenceByKeyword =
    !hasActionTypeMismatch &&
    !isUnknownExpectedWithNonProgressiveActual &&
    (keywordMatchCount >= 2 || (keywordMatchCount >= 1 && actionTypeStrictMatch));
  const highConfidenceByTarget =
    !hasActionTypeMismatch &&
    !isUnknownExpectedWithNonProgressiveActual &&
    targetElementMatchCount >= 1 && actionTypeStrictMatch;

  // 非プログレッシブアクション または type/keyアクションでactionType厳密一致のみでも高信頼扱い
  // type/keyはアクション種別が一致すれば、キーワードマッチなしでも高信頼とする
  const isTypeOrKeyAction = actionType === 'type' || actionType === 'key';
  const highConfidenceByActionTypeOnly =
    !hasActionTypeMismatch && (isNonProgressiveAction || isTypeOrKeyAction) && actionTypeStrictMatch;

  if (
    highConfidenceByKeyword ||
    highConfidenceByTarget ||
    highConfidenceByActionTypeOnly
  ) {
    // requiresScreenChangeを期待アクションに基づいて設定（不一致検出のため）
    // 期待が非プログレッシブなら画面変化は不要、それ以外は必要
    const requiresScreenChangeForProgress = !isExpectedNonProgressiveAction;

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

  // アクションタイプ不一致が検出された場合は低信頼度で即座に返す
  // これにより、action_mismatch検出（lowMediumConfidenceCount）が正しく機能する
  if (hasActionTypeMismatch) {
    // requiresScreenChangeは実アクションに基づいて判断
    // 実アクションがプログレッシブ（click等）なら画面変化を要求
    // 実アクションが非プログレッシブ（screenshot/wait等）なら画面変化は不要
    return {
      isValid: true,
      shouldAdvanceIndex: false,
      confidence: 'low',
      needsClaudeVerification: false,
      requiresScreenChange: !isNonProgressiveAction,
      reason: `Action type mismatch: expected ${expected.expectedToolAction}, got ${actionType}`,
    };
  }

  // 中信頼度パターン
  const mediumConfidence =
    keywordMatchCount >= 1 || targetElementMatchCount >= 1 || actionTypeMatches;

  if (mediumConfidence) {
    // requiresScreenChangeは実アクションに基づいて判断
    // 実アクションがプログレッシブなら画面変化を要求
    return {
      isValid: true,
      shouldAdvanceIndex: false,
      confidence: 'medium',
      needsClaudeVerification: isExpectedClickAction || isClickAction,
      requiresScreenChange: !isNonProgressiveAction,
    };
  }

  // 低信頼度: 一致なし
  // requiresScreenChangeは実アクションに基づいて判断
  // 実アクションがプログレッシブなら画面変化を要求（action_mismatch検出のため）
  // 実アクションが非プログレッシブなら画面変化は不要
  return {
    isValid: true,
    shouldAdvanceIndex: false,
    confidence: 'low',
    needsClaudeVerification: false,
    requiresScreenChange: !isNonProgressiveAction,
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

    const response = await callClaudeMessagesViaProxy(
      VISION_MODEL,
      256,
      '',
      [
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
      ]
    );

    const content = response.content[0];
    if (content.type !== 'text') {
      return { isCompleted: false };
    }

    // Helper to validate and normalize isCompleted result
    const normalizeCompletionResult = (parsed: unknown): { isCompleted: boolean; reason?: string } => {
      if (typeof parsed !== 'object' || parsed === null) {
        return { isCompleted: false };
      }
      const obj = parsed as Record<string, unknown>;
      // Handle string boolean values like "true" or "false"
      let isCompleted = obj.isCompleted;
      if (typeof isCompleted === 'string') {
        isCompleted = isCompleted.toLowerCase() === 'true';
      } else if (typeof isCompleted !== 'boolean') {
        return { isCompleted: false };
      }
      return {
        isCompleted: isCompleted as boolean,
        reason: typeof obj.reason === 'string' ? obj.reason : undefined,
      };
    };

    // Try to parse JSON from various formats
    // 1. ```json``` fence
    const jsonFenceMatch = content.text.match(/```json\s*(\{[\s\S]*?\})\s*```/);
    if (jsonFenceMatch) {
      return normalizeCompletionResult(JSON.parse(jsonFenceMatch[1]));
    }

    // 2. ``` fence without json specifier
    const fenceMatch = content.text.match(/```\s*(\{[\s\S]*?\})\s*```/);
    if (fenceMatch) {
      return normalizeCompletionResult(JSON.parse(fenceMatch[1]));
    }

    // 3. Plain JSON object with isCompleted field
    const plainJsonMatch = content.text.match(/\{[^{}]*"isCompleted"\s*:\s*(true|false|"true"|"false")[^{}]*\}/);
    if (plainJsonMatch) {
      return normalizeCompletionResult(JSON.parse(plainJsonMatch[0]));
    }

    // 4. Try to extract any JSON-like structure
    const anyJsonMatch = content.text.match(/\{[\s\S]*?\}/);
    if (anyJsonMatch) {
      try {
        const parsed = JSON.parse(anyJsonMatch[0]);
        const normalized = normalizeCompletionResult(parsed);
        if (typeof (parsed as Record<string, unknown>).isCompleted !== 'undefined') {
          return normalized;
        }
      } catch {
        // Continue to fallback
      }
    }

    return { isCompleted: false };
  } catch (error) {
    console.warn('Action completion check failed, assuming not completed:', error);
    return { isCompleted: false };
  }
}

/**
 * 画面上に指定されたテキストが表示されているかを検証
 * verificationTextが設定されている場合に使用
 *
 * @param verificationText 表示されるべきテキスト
 * @param currentScreenshotBase64 現在のスクリーンショット
 * @returns 検証結果 (isError: API/パースエラーの場合true、実際の検証失敗の場合false)
 */
export async function verifyTextOnScreen(
  verificationText: string,
  currentScreenshotBase64: string
): Promise<{ verified: boolean; reason?: string; isError?: boolean }> {
  try {
    const prompt = `
画面を確認して、以下のテキストが表示されているかどうかを判断してください。

確認するテキスト: 「${verificationText}」

注意:
- 完全一致でなくても、意味的に同じテキストが表示されていれば「表示されている」と判断してください
- 部分一致も許容します（例: 「待機中」と「書き起こし待機中です」は一致と見なす）
- テキストが画面のどこかに表示されていれば、位置は問いません

以下のJSON形式で回答してください:
\`\`\`json
{"verified": true/false, "reason": "判断理由（どこに表示されているか、または見つからなかった理由）"}
\`\`\`
`;

    const VISION_MODEL = 'claude-sonnet-4-20250514';

    const response = await callClaudeMessagesViaProxy(
      VISION_MODEL,
      256,
      '',
      [
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
      ]
    );

    const content = response.content[0];
    if (content.type !== 'text') {
      return { verified: false, reason: 'Invalid response from Claude', isError: true };
    }

    // Helper to validate and normalize verified result
    const normalizeVerificationResult = (parsed: unknown): { verified: boolean; reason?: string; isError?: boolean } => {
      if (typeof parsed !== 'object' || parsed === null) {
        return { verified: false, reason: 'Invalid response format', isError: true };
      }
      const obj = parsed as Record<string, unknown>;
      // Handle string boolean values like "true" or "false"
      let verified = obj.verified;
      if (typeof verified === 'string') {
        verified = verified.toLowerCase() === 'true';
      } else if (typeof verified !== 'boolean') {
        return { verified: false, reason: 'Missing verified field', isError: true };
      }
      return {
        verified: verified as boolean,
        reason: typeof obj.reason === 'string' ? obj.reason : undefined,
      };
    };

    // Try to parse JSON from various formats
    // 1. ```json``` fence
    const jsonFenceMatch = content.text.match(/```json\s*(\{[\s\S]*?\})\s*```/);
    if (jsonFenceMatch) {
      return normalizeVerificationResult(JSON.parse(jsonFenceMatch[1]));
    }

    // 2. ``` fence without json specifier
    const fenceMatch = content.text.match(/```\s*(\{[\s\S]*?\})\s*```/);
    if (fenceMatch) {
      return normalizeVerificationResult(JSON.parse(fenceMatch[1]));
    }

    // 3. Plain JSON object (first {...} found)
    const plainJsonMatch = content.text.match(/\{[^{}]*"verified"\s*:\s*(true|false|"true"|"false")[^{}]*\}/);
    if (plainJsonMatch) {
      return normalizeVerificationResult(JSON.parse(plainJsonMatch[0]));
    }

    // 4. Try to extract any JSON-like structure
    const anyJsonMatch = content.text.match(/\{[\s\S]*?\}/);
    if (anyJsonMatch) {
      try {
        const parsed = JSON.parse(anyJsonMatch[0]);
        if (typeof (parsed as Record<string, unknown>).verified !== 'undefined') {
          return normalizeVerificationResult(parsed);
        }
      } catch {
        // Continue to fallback
      }
    }

    // Could not parse JSON from response - this is a parse error, not a verification failure
    console.warn('[verifyTextOnScreen] Could not parse response:', content.text.substring(0, 200));
    return { verified: false, reason: 'Could not parse response', isError: true };
  } catch (error) {
    console.warn('[verifyTextOnScreen] Verification error:', error);
    return { verified: false, reason: `Verification error: ${error}`, isError: true };
  }
}
