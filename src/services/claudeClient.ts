/**
 * Claude API Client for Computer Use
 */

import Anthropic from '@anthropic-ai/sdk';
import { invoke } from '@tauri-apps/api/core';
import type { CaptureResult } from '../types';

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
 * Build the computer tool definition for Claude API
 * Using computer_20250124 type for compatibility with current SDK
 */
export function buildComputerTool(captureResult: CaptureResult) {
  return {
    type: 'computer_20250124' as const,
    name: 'computer' as const,
    display_width_px: captureResult.resizedWidth,
    display_height_px: captureResult.resizedHeight,
    display_number: 1,
  };
}

/**
 * Check if the API key is configured
 */
export async function isApiKeyConfigured(): Promise<boolean> {
  return invoke<boolean>('is_api_key_configured', { keyName: 'anthropic' });
}
