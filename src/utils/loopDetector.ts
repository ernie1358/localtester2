/**
 * Loop detection utilities for preventing infinite action loops
 */

import type { ActionRecord, AgentLoopConfig, ComputerAction } from '../types';

/**
 * Hash an action for comparison
 * Combines action type, coordinates, and text into a single hash
 */
export function hashAction(action: ComputerAction): string {
  const key = [
    action.action,
    action.coordinate?.join(',') ?? '',
    action.text ?? '',
    action.start_coordinate?.join(',') ?? '',
    action.scroll_direction ?? '',
    // Include additional fields to prevent false positive loop detection
    action.scroll_amount?.toString() ?? '',
    action.duration?.toString() ?? '',
    action.key ?? '',
    action.down?.toString() ?? '',
  ].join('|');

  // Simple hash function (for production, consider using crypto.subtle.digest)
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    const char = key.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

/**
 * Detect if we're in an infinite loop
 * @param actionHistory Recent action history
 * @param currentAction Current action to check
 * @param config Loop detection configuration
 * @returns true if loop detected
 */
export function detectLoop(
  actionHistory: ActionRecord[],
  currentAction: ComputerAction,
  config: AgentLoopConfig
): boolean {
  const currentHash = hashAction(currentAction);
  const recentHashes = actionHistory
    .slice(-config.loopDetectionWindow)
    .map((r) => r.hash);

  // Count occurrences of current action hash in recent history
  const sameHashCount = recentHashes.filter((h) => h === currentHash).length;

  return sameHashCount >= config.loopDetectionThreshold;
}

/**
 * Create an action record for history
 */
export function createActionRecord(
  toolUseId: string,
  action: ComputerAction
): ActionRecord {
  return {
    hash: hashAction(action),
    toolUseId,
    action,
    timestamp: Date.now(),
  };
}
