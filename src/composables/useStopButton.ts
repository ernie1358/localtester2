/**
 * Composable for stop button state management
 *
 * Features:
 * - Manages stopping state for immediate UI feedback
 * - Handles emergency stop event listening
 * - Provides computed properties for button UI state
 * - Prevents double-click during stop process
 */

import { ref, computed, type Ref } from 'vue';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/**
 * Type for the listen function (Tauri event API compatible)
 */
export type ListenFn = (
  event: string,
  handler: (event: { payload: unknown }) => void
) => Promise<() => void>;

export interface UseStopButtonOptions {
  /**
   * Ref indicating if execution is running
   */
  isRunning: Ref<boolean>;
  /**
   * Callback to add log messages
   */
  addLog: (message: string) => void;
  /**
   * Mock listen function for testing
   */
  listenFn?: ListenFn;
}

export interface UseStopButtonReturn {
  /**
   * Whether stop is in progress
   */
  isStopping: Ref<boolean>;
  /**
   * Whether stop button should be disabled
   */
  isStopButtonDisabled: Ref<boolean>;
  /**
   * Label for the stop button
   */
  stopButtonLabel: Ref<string>;
  /**
   * Whether to show stop button (vs execute button)
   */
  showStopButton: Ref<boolean>;
  /**
   * Whether execute button should be disabled due to stopping
   */
  isExecuteDisabledByStopping: Ref<boolean>;
  /**
   * Initiate stop - immediately updates UI state
   */
  initiateStop: () => void;
  /**
   * Reset stopping state after execution completes
   */
  resetStoppingState: () => void;
  /**
   * Set up emergency stop listener
   */
  setupEmergencyStopListener: () => Promise<void>;
  /**
   * Clean up emergency stop listener
   */
  cleanupEmergencyStopListener: () => void;
}

/**
 * Creates a stop button state composable
 *
 * This composable manages the stopping state separately from the running state,
 * allowing the UI to immediately respond to stop requests while the backend
 * processes the actual stop operation.
 *
 * @param options - Configuration options
 * @returns Stop button state and methods
 */
export function useStopButton(options: UseStopButtonOptions): UseStopButtonReturn {
  const { isRunning, addLog, listenFn = listen as ListenFn } = options;

  const isStopping = ref(false);
  let emergencyStopUnlisten: UnlistenFn | null = null;

  // Computed properties for UI
  const isStopButtonDisabled = computed(() => isStopping.value);
  const stopButtonLabel = computed(() =>
    isStopping.value ? '停止中...' : '停止 (Shift+Esc)'
  );
  const showStopButton = computed(() => isRunning.value || isStopping.value);
  const isExecuteDisabledByStopping = computed(() => isStopping.value);

  /**
   * Initiate stop - sets isStopping immediately for UI feedback
   */
  function initiateStop(): void {
    if (isStopping.value) return;
    isStopping.value = true;
    addLog('停止処理を開始しています...');
  }

  /**
   * Reset stopping state after execution completes
   */
  function resetStoppingState(): void {
    if (isStopping.value) {
      isStopping.value = false;
      addLog('停止処理が完了しました');
    }
  }

  /**
   * Set up emergency stop event listener
   */
  async function setupEmergencyStopListener(): Promise<void> {
    try {
      emergencyStopUnlisten = await listenFn('emergency-stop', () => {
        if (isRunning.value && !isStopping.value) {
          isStopping.value = true;
          addLog('緊急停止が発動しました...');
        }
      });
    } catch (error) {
      console.error('Failed to set up emergency stop listener:', error);
    }
  }

  /**
   * Clean up emergency stop listener
   */
  function cleanupEmergencyStopListener(): void {
    if (emergencyStopUnlisten) {
      emergencyStopUnlisten();
      emergencyStopUnlisten = null;
    }
  }

  return {
    isStopping,
    isStopButtonDisabled,
    stopButtonLabel,
    showStopButton,
    isExecuteDisabledByStopping,
    initiateStop,
    resetStoppingState,
    setupEmergencyStopListener,
    cleanupEmergencyStopListener,
  };
}
