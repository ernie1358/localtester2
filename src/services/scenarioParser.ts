/**
 * Scenario Parser - Split user input into multiple scenarios using Claude
 */

import { getClaudeClient } from './claudeClient';
import type { Scenario, ScenarioSplitResult } from '../types';
import { DEFAULT_CLAUDE_MODEL_CONFIG } from '../types';

/** System prompt for scenario splitting */
const SCENARIO_SPLIT_PROMPT = `
あなたはテストシナリオを分析し、個別のシナリオに分割するアシスタントです。
ユーザーが入力したテキストを分析し、以下のJSON形式で応答してください。

出力形式:
{
  "scenarios": [
    {
      "id": 1,
      "title": "シナリオのタイトル（短い説明）",
      "description": "シナリオの詳細な指示内容"
    }
  ],
  "analysis": {
    "total_count": シナリオ数,
    "is_single": 単一シナリオかどうか（boolean）
  }
}

ルール:
1. 複数のテストケースが含まれる場合は分割する
2. 単一のシナリオの場合は1つの要素を持つ配列として返す
3. 必ず有効なJSONのみを出力する（説明文は不要）
`;

/**
 * Parse user input into multiple scenarios
 * Falls back to single scenario if parsing fails
 */
export async function parseScenarios(userInput: string): Promise<Scenario[]> {
  try {
    const client = await getClaudeClient();

    const response = await client.messages.create({
      model: DEFAULT_CLAUDE_MODEL_CONFIG.model,
      max_tokens: 1024,
      system: SCENARIO_SPLIT_PROMPT,
      messages: [{ role: 'user', content: userInput }],
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type');
    }

    // Extract JSON from response (handle markdown code blocks)
    let jsonText = content.text.trim();
    const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonText = jsonMatch[1].trim();
    }

    const result: ScenarioSplitResult = JSON.parse(jsonText);

    if (!result.scenarios || result.scenarios.length === 0) {
      throw new Error('No scenarios in response');
    }

    return result.scenarios.map((s, index) => ({
      id: crypto.randomUUID(),
      title: s.title,
      description: s.description,
      status: 'pending' as const,
      orderIndex: index,
    }));
  } catch (error) {
    // Fallback: treat entire input as single scenario
    console.warn('Scenario split failed, treating as single scenario:', error);
    return [
      {
        id: crypto.randomUUID(),
        title: 'テストシナリオ',
        description: userInput,
        status: 'pending',
        orderIndex: 0,
      },
    ];
  }
}
