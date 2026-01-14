/**
 * Computer Use API action type definitions
 */

/** Available action types for Computer Use API */
export type ComputerActionType =
  | 'screenshot'
  | 'left_click'
  | 'right_click'
  | 'middle_click'
  | 'double_click'
  | 'triple_click'
  | 'mouse_move'
  | 'left_click_drag'
  | 'left_mouse_down'
  | 'left_mouse_up'
  | 'type'
  | 'key'
  | 'scroll'
  | 'wait'
  | 'hold_key';

/** Scroll direction */
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/** Computer action from Claude */
export interface ComputerAction {
  action: ComputerActionType;
  coordinate?: [number, number];
  start_coordinate?: [number, number];
  text?: string;
  scroll_direction?: ScrollDirection;
  scroll_amount?: number;
  duration?: number; // for wait action
  key?: string; // for hold_key action
  down?: boolean; // for hold_key action
}

/** Action record for loop detection */
export interface ActionRecord {
  hash: string;
  toolUseId: string;
  action: ComputerAction;
  timestamp: number;
}

/** Claude API model configuration */
export interface ClaudeModelConfig {
  /** Model ID to use for Computer Use API */
  model: string;
  /** Beta header for Computer Use API */
  betaHeader: string;
  /** Computer tool type version */
  toolType: 'computer_20251124' | 'computer_20250124';
  /** Enable zoom action (Opus 4.5 only) */
  enableZoom: boolean;
}

/** Default Claude model configuration for Opus 4.5 */
export const DEFAULT_CLAUDE_MODEL_CONFIG: ClaudeModelConfig = {
  model: 'claude-opus-4-5-20251101',
  betaHeader: 'computer-use-2025-11-24',
  toolType: 'computer_20251124',
  enableZoom: false,
};

/** Fallback Claude model configuration (Sonnet) */
export const FALLBACK_CLAUDE_MODEL_CONFIG: ClaudeModelConfig = {
  model: 'claude-sonnet-4-20250514',
  betaHeader: 'computer-use-2025-01-24',
  toolType: 'computer_20250124',
  enableZoom: false,
};

/** Configuration for agent loop */
export interface AgentLoopConfig {
  maxIterationsPerScenario: number;
  loopDetectionWindow: number;
  loopDetectionThreshold: number;
  /** Claude model configuration */
  modelConfig?: ClaudeModelConfig;
  /** Maximum same action repeats before stuck detection */
  maxSameActionRepeats?: number;
  /** Maximum unchanged screenshots before stuck detection */
  maxUnchangedScreenshots?: number;
  /** Delay in milliseconds after click actions before capturing screenshot */
  actionDelayMs?: number;
}

/** Default agent loop configuration */
export const DEFAULT_AGENT_LOOP_CONFIG: AgentLoopConfig = {
  maxIterationsPerScenario: 30,
  loopDetectionWindow: 5,
  loopDetectionThreshold: 3,
  modelConfig: DEFAULT_CLAUDE_MODEL_CONFIG,
  maxSameActionRepeats: 5,
  maxUnchangedScreenshots: 3,
  actionDelayMs: 1000,
};
