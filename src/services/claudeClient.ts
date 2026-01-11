/**
 * Claude API Client for Computer Use
 */

import Anthropic from '@anthropic-ai/sdk';
import { invoke } from '@tauri-apps/api/core';
import type { CaptureResult, ClaudeModelConfig } from '../types';
import { DEFAULT_CLAUDE_MODEL_CONFIG } from '../types';

/** Singleton Claude client instance */
let anthropicClient: Anthropic | null = null;

/**
 * Get or create the Claude client
 * API key is fetched from Rust backend (loaded from .env)
 */
export async function getClaudeClient(): Promise<Anthropic> {
  if (anthropicClient) {
    return anthropicClient;
  }

  // Get API key from Rust backend
  const apiKey = await invoke<string>('get_api_key', { keyName: 'anthropic' });

  anthropicClient = new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true, // Required for Tauri WebView
  });

  return anthropicClient;
}

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
 * Check if the API key is configured
 */
export async function isApiKeyConfigured(): Promise<boolean> {
  return invoke<boolean>('is_api_key_configured', { keyName: 'anthropic' });
}

/**
 * シナリオ完了判定用のシステムプロンプト
 * Claudeに結果をJSON形式で出力することを要求
 */
export const RESULT_SCHEMA_INSTRUCTION = `
重要: シナリオの実行が完了（成功または失敗）した場合、必ず以下のJSON形式で結果を報告してください。
このJSONは必ずテキスト応答の最後に含めてください。

シナリオが正常に完了した場合:
\`\`\`json
{"status": "success", "message": "シナリオが正常に完了しました"}
\`\`\`

シナリオが失敗した場合（要素が見つからない、操作できないなど）:
\`\`\`json
{"status": "failure", "message": "失敗の詳細説明", "failureReason": "要素が見つからない|操作が効果なし|予期しない画面|その他"}
\`\`\`

まだ進行中の場合は、このJSONを含めずに次のアクションを実行してください。
`;
