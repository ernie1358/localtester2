/**
 * Action Delay constants and options
 * Used for persisting action delay settings to localStorage
 */

export const LOCAL_STORAGE_KEY_ACTION_DELAY = 'xenotester_action_delay_ms';

export const DEFAULT_ACTION_DELAY_MS = 1000;

export const ACTION_DELAY_OPTIONS = [
  { value: 0, label: '0秒' },
  { value: 500, label: '0.5秒' },
  { value: 1000, label: '1秒' },
  { value: 2000, label: '2秒' },
  { value: 3000, label: '3秒' },
  { value: 5000, label: '5秒' },
] as const;

export type ActionDelayValue = (typeof ACTION_DELAY_OPTIONS)[number]['value'];
