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

/** Configuration for agent loop */
export interface AgentLoopConfig {
  maxIterationsPerScenario: number;
  loopDetectionWindow: number;
  loopDetectionThreshold: number;
}

/** Default agent loop configuration */
export const DEFAULT_AGENT_LOOP_CONFIG: AgentLoopConfig = {
  maxIterationsPerScenario: 30,
  loopDetectionWindow: 5,
  loopDetectionThreshold: 3,
};
