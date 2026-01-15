/**
 * Claude API Client for Computer Use
 * Uses Supabase Edge Function as proxy (API key is server-side)
 */

import type { BetaMessage, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages';
import { getSession, getSupabaseConfig } from './supabaseClient';
import type { CaptureResult, ClaudeModelConfig } from '../types';
import { DEFAULT_CLAUDE_MODEL_CONFIG } from '../types';

/**
 * Computer tool type for Claude API
 * Note: Using type assertion as SDK may not have latest type definitions (computer_20251124)
 * When SDK is updated to support computer_20251124, this can be removed
 */
export interface ComputerTool {
  type: 'computer_20251124' | 'computer_20250124';
  name: 'computer';
  display_width_px: number;
  display_height_px: number;
  display_number: number;
  enable_zoom?: boolean;
}

/**
 * Build the computer tool definition for Claude API
 * Supports both Opus 4.5 (computer_20251124) and Sonnet (computer_20250124) tool versions
 *
 * @param captureResult Screen capture result with dimensions
 * @param modelConfig Claude model configuration (optional, defaults to Opus 4.5)
 */
export function buildComputerTool(
  captureResult: CaptureResult,
  modelConfig: ClaudeModelConfig = DEFAULT_CLAUDE_MODEL_CONFIG
): ComputerTool {
  return {
    type: modelConfig.toolType,
    name: 'computer',
    display_width_px: captureResult.resizedWidth,
    display_height_px: captureResult.resizedHeight,
    display_number: 1,
    ...(modelConfig.enableZoom && { enable_zoom: true }),
  };
}

/**
 * Check if the user is authenticated (required for API calls)
 */
export async function isApiKeyConfigured(): Promise<boolean> {
  try {
    const session = await getSession();
    return session !== null;
  } catch {
    return false;
  }
}

/**
 * Call Claude API via Supabase Edge Function
 * The API key is stored server-side in the Edge Function
 */
export async function callClaudeAPIViaProxy(
  messages: BetaMessageParam[],
  captureResult: CaptureResult,
  modelConfig: ClaudeModelConfig = DEFAULT_CLAUDE_MODEL_CONFIG,
  systemPrompt?: string
): Promise<BetaMessage> {
  // Get Supabase session for authentication
  const session = await getSession();
  if (!session) {
    throw new Error('Not authenticated. Please sign in first.');
  }

  // Get Supabase config for Edge Function URL
  const config = await getSupabaseConfig();
  const edgeFunctionUrl = `${config.url}/functions/v1/claude-proxy`;

  // Build request body (same format as Anthropic API)
  // Note: betas is sent via header (anthropic-beta), not in body
  const requestBody = {
    model: modelConfig.model,
    max_tokens: 4096,
    system: systemPrompt,
    tools: [buildComputerTool(captureResult, modelConfig)],
    messages,
  };

  // Call Edge Function
  // Note: apikey header is required for direct fetch to Supabase Functions
  const response = await fetch(edgeFunctionUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
      'apikey': config.anon_key,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': modelConfig.betaHeader,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    let errorMessage: string;
    try {
      const errorJson = JSON.parse(errorBody);
      errorMessage = errorJson.error?.message || errorJson.error || errorBody;
    } catch {
      errorMessage = errorBody;
    }
    throw new Error(`API call failed (${response.status}): ${errorMessage}`);
  }

  const result = await response.json();
  return result as BetaMessage;
}

/**
 * Message content type for Claude API
 */
export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/**
 * Call Claude Messages API via Supabase Edge Function (for text-only tasks)
 * Used for action extraction, verification, etc.
 */
export async function callClaudeMessagesViaProxy(
  model: string,
  maxTokens: number,
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string | MessageContent[] }>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  // Get Supabase session for authentication
  const session = await getSession();
  if (!session) {
    throw new Error('Not authenticated. Please sign in first.');
  }

  // Get Supabase config for Edge Function URL
  const config = await getSupabaseConfig();
  const edgeFunctionUrl = `${config.url}/functions/v1/claude-proxy`;

  // Build request body
  const requestBody = {
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
  };

  // Call Edge Function
  // Note: apikey header is required for direct fetch to Supabase Functions
  const response = await fetch(edgeFunctionUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
      'apikey': config.anon_key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    let errorMessage: string;
    try {
      const errorJson = JSON.parse(errorBody);
      errorMessage = errorJson.error?.message || errorJson.error || errorBody;
    } catch {
      errorMessage = errorBody;
    }
    throw new Error(`API call failed (${response.status}): ${errorMessage}`);
  }

  return response.json();
}

/**
 * シナリオ完了判定用のシステムプロンプト
 * テスト自動化ツールとして厳密に動作するよう指示
 */
export const RESULT_SCHEMA_INSTRUCTION = `
あなたはE2Eテスト自動化ツールです。以下のルールを厳守してください。

【ヒント画像について】
ユーザーからヒント画像が提供される場合があります。これらの画像は：
- クリックすべきアイコンやボタンの見本
- 探すべきUI要素のスクリーンショット
- 操作対象の参考画像
として活用してください。ヒント画像と現在の画面を照合し、同一または類似の要素を正確に特定してください。

【座標情報について - 必ず従うこと】
ヒント画像と一緒に「画像認識による座標」が提供される場合があります。この座標はテンプレートマッチングにより検出された、ヒント画像がスクリーンショット内で見つかった位置の中心点です。

【重要】座標が提供されている場合は、その座標を正確に使用してください：
- 座標情報（例: "座標: (1522, 716)"）が提供されている場合、クリック時はその座標をそのまま使用してください
- 自分の視覚的判断で座標を変更しないでください。テンプレートマッチングの精度は非常に高いです
- 座標が検出されなかった画像についてのみ、視覚的に探して判断してください

具体例：
- ✓ 座標(1522, 716)が提供された → left_click で coordinate=[1522, 716] を指定
- ✗ 座標(1522, 716)が提供された → 自分の判断で coordinate=[1200, 560] に変更（これは禁止）

【最重要ルール - 絶対に守ること】
1. 指示された内容を「文字通り」に実行してください。目的達成のための迂回策は絶対に使わないでください。
2. 例えば「Geminiアイコンをクリック」という指示に対して、そのアイコンが見つからない、または違うアイコンをクリックしてしまった場合は、SpotlightやLaunchpadなど別の方法でGeminiを起動しようとしないでください。
3. 指示された操作が期待通りに動作しない場合は、即座に「failure」として報告してください。
4. これはテストです。テストの目的は「記述されたUI操作が正しく動作するか検証すること」であり、「目的を達成すること」ではありません。

【アクションタイプの厳守 - 最重要】
指示に書かれたアクションタイプを必ず使用してください。同じ結果が得られても、別のアクションタイプを使ってはいけません。
- 「キーを押す」「キーボードショートカット」→ 必ず key を使用（特定のキーやコンビネーション: space, enter, cmd+c など）
- 「入力する」「文字を打つ」「タイプする」→ 必ず type を使用（テキスト文字列の入力）
- 「クリックする」「押す（ボタンを）」→ 必ず left_click を使用（キー入力ではない）
- 「スクロールする」→ 必ず scroll を使用
- 「ドラッグする」→ 必ず left_click_drag を使用

具体例:
- ✓「スペースキーを押して動画を停止」→ key action で "space" を入力
- ✗「スペースキーを押して動画を停止」→ 動画をクリック（これは禁止）
- ✓「Hello と入力」→ type action で "Hello" を入力
- ✗「Hello と入力」→ key action を使用（これは禁止、key はショートカット用）
- ✓「ボタンをクリック」→ left_click でボタンをクリック
- ✗「ボタンをクリック」→ Enterキーを押す（これは禁止）

【禁止事項】
- 代替手段やワークアラウンドを探すこと
- 指示にない操作を行うこと
- 失敗を隠すために別のアプローチを試みること
- 指示されたアクションタイプと異なるアクションで同じ目的を達成しようとすること

【結果報告】
シナリオの実行が完了（成功または失敗）した場合、必ず以下のJSON形式で結果を報告してください。
このJSONは必ずテキスト応答の最後に含めてください。

シナリオが正常に完了した場合:
\`\`\`json
{"status": "success", "message": "シナリオが正常に完了しました"}
\`\`\`

シナリオが失敗した場合（要素が見つからない、クリックが効かない、期待と違う画面など）:
\`\`\`json
{"status": "failure", "message": "失敗の詳細説明", "failureReason": "要素が見つからない|クリック位置が違う|操作が効果なし|予期しない画面|その他"}
\`\`\`

まだ進行中の場合は、このJSONを含めずに次のアクションを実行してください。
`;
