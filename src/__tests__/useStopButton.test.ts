/**
 * useStopButton Composable Tests
 *
 * Tests for the stop button state management composable.
 * These tests verify:
 * - State transitions (initiateStop, resetStoppingState)
 * - Computed properties for UI
 * - Emergency stop event handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ref, nextTick } from 'vue';
import { useStopButton, type ListenFn } from '../composables/useStopButton';

describe('useStopButton Composable', () => {
  let mockListeners: Map<string, (event: { payload: unknown }) => void>;
  let mockListen: ListenFn;

  beforeEach(() => {
    mockListeners = new Map();
    mockListen = vi.fn((eventName: string, handler: (event: { payload: unknown }) => void) => {
      mockListeners.set(eventName, handler);
      return Promise.resolve(() => {
        mockListeners.delete(eventName);
      });
    }) as unknown as ListenFn;
  });

  afterEach(() => {
    mockListeners.clear();
    vi.clearAllMocks();
  });

  function emitEvent(eventName: string, payload: unknown = undefined) {
    const handler = mockListeners.get(eventName);
    if (handler) {
      handler({ payload });
    }
  }

  describe('Initial State', () => {
    it('should start with isStopping as false', () => {
      const isRunning = ref(false);
      const logs: string[] = [];
      const addLog = (msg: string) => logs.push(msg);

      const { isStopping } = useStopButton({
        isRunning,
        addLog,
        listenFn: mockListen,
      });

      expect(isStopping.value).toBe(false);
    });

    it('should have stop button enabled when not stopping', () => {
      const isRunning = ref(true);
      const logs: string[] = [];
      const addLog = (msg: string) => logs.push(msg);

      const { isStopButtonDisabled } = useStopButton({
        isRunning,
        addLog,
        listenFn: mockListen,
      });

      expect(isStopButtonDisabled.value).toBe(false);
    });

    it('should show normal label when not stopping', () => {
      const isRunning = ref(true);
      const logs: string[] = [];
      const addLog = (msg: string) => logs.push(msg);

      const { stopButtonLabel } = useStopButton({
        isRunning,
        addLog,
        listenFn: mockListen,
      });

      expect(stopButtonLabel.value).toBe('停止 (Shift+Esc)');
    });
  });

  describe('showStopButton Computed', () => {
    it('should return false when not running and not stopping', () => {
      const isRunning = ref(false);
      const logs: string[] = [];
      const addLog = (msg: string) => logs.push(msg);

      const { showStopButton } = useStopButton({
        isRunning,
        addLog,
        listenFn: mockListen,
      });

      expect(showStopButton.value).toBe(false);
    });

    it('should return true when running', () => {
      const isRunning = ref(true);
      const logs: string[] = [];
      const addLog = (msg: string) => logs.push(msg);

      const { showStopButton } = useStopButton({
        isRunning,
        addLog,
        listenFn: mockListen,
      });

      expect(showStopButton.value).toBe(true);
    });

    it('should return true when stopping even if not running', () => {
      const isRunning = ref(false);
      const logs: string[] = [];
      const addLog = (msg: string) => logs.push(msg);

      const { showStopButton, isStopping } = useStopButton({
        isRunning,
        addLog,
        listenFn: mockListen,
      });

      // Manually set stopping state
      isStopping.value = true;

      expect(showStopButton.value).toBe(true);
    });
  });

  describe('initiateStop', () => {
    it('should set isStopping to true', () => {
      const isRunning = ref(true);
      const logs: string[] = [];
      const addLog = (msg: string) => logs.push(msg);

      const { isStopping, initiateStop } = useStopButton({
        isRunning,
        addLog,
        listenFn: mockListen,
      });

      initiateStop();

      expect(isStopping.value).toBe(true);
    });

    it('should add log message', () => {
      const isRunning = ref(true);
      const logs: string[] = [];
      const addLog = (msg: string) => logs.push(msg);

      const { initiateStop } = useStopButton({
        isRunning,
        addLog,
        listenFn: mockListen,
      });

      initiateStop();

      expect(logs).toContain('停止処理を開始しています...');
    });

    it('should disable the button', () => {
      const isRunning = ref(true);
      const logs: string[] = [];
      const addLog = (msg: string) => logs.push(msg);

      const { isStopButtonDisabled, initiateStop } = useStopButton({
        isRunning,
        addLog,
        listenFn: mockListen,
      });

      initiateStop();

      expect(isStopButtonDisabled.value).toBe(true);
    });

    it('should change button label to stopping', () => {
      const isRunning = ref(true);
      const logs: string[] = [];
      const addLog = (msg: string) => logs.push(msg);

      const { stopButtonLabel, initiateStop } = useStopButton({
        isRunning,
        addLog,
        listenFn: mockListen,
      });

      initiateStop();

      expect(stopButtonLabel.value).toBe('停止中...');
    });

    it('should prevent double invocation', () => {
      const isRunning = ref(true);
      const logs: string[] = [];
      const addLog = (msg: string) => logs.push(msg);

      const { initiateStop } = useStopButton({
        isRunning,
        addLog,
        listenFn: mockListen,
      });

      initiateStop();
      const logCountAfterFirst = logs.length;

      initiateStop(); // Second call

      expect(logs.length).toBe(logCountAfterFirst);
    });
  });

  describe('resetStoppingState', () => {
    it('should set isStopping to false', () => {
      const isRunning = ref(true);
      const logs: string[] = [];
      const addLog = (msg: string) => logs.push(msg);

      const { isStopping, initiateStop, resetStoppingState } = useStopButton({
        isRunning,
        addLog,
        listenFn: mockListen,
      });

      initiateStop();
      expect(isStopping.value).toBe(true);

      resetStoppingState();
      expect(isStopping.value).toBe(false);
    });

    it('should add completion log', () => {
      const isRunning = ref(true);
      const logs: string[] = [];
      const addLog = (msg: string) => logs.push(msg);

      const { initiateStop, resetStoppingState } = useStopButton({
        isRunning,
        addLog,
        listenFn: mockListen,
      });

      initiateStop();
      logs.length = 0; // Clear logs

      resetStoppingState();

      expect(logs).toContain('停止処理が完了しました');
    });

    it('should not add log if not stopping', () => {
      const isRunning = ref(true);
      const logs: string[] = [];
      const addLog = (msg: string) => logs.push(msg);

      const { resetStoppingState } = useStopButton({
        isRunning,
        addLog,
        listenFn: mockListen,
      });

      resetStoppingState();

      expect(logs).not.toContain('停止処理が完了しました');
    });

    it('should return button to normal state', () => {
      const isRunning = ref(true);
      const logs: string[] = [];
      const addLog = (msg: string) => logs.push(msg);

      const { isStopButtonDisabled, stopButtonLabel, initiateStop, resetStoppingState } = useStopButton({
        isRunning,
        addLog,
        listenFn: mockListen,
      });

      initiateStop();
      resetStoppingState();

      expect(isStopButtonDisabled.value).toBe(false);
      expect(stopButtonLabel.value).toBe('停止 (Shift+Esc)');
    });
  });

  describe('isExecuteDisabledByStopping', () => {
    it('should return false when not stopping', () => {
      const isRunning = ref(false);
      const logs: string[] = [];
      const addLog = (msg: string) => logs.push(msg);

      const { isExecuteDisabledByStopping } = useStopButton({
        isRunning,
        addLog,
        listenFn: mockListen,
      });

      expect(isExecuteDisabledByStopping.value).toBe(false);
    });

    it('should return true when stopping', () => {
      const isRunning = ref(true);
      const logs: string[] = [];
      const addLog = (msg: string) => logs.push(msg);

      const { isExecuteDisabledByStopping, initiateStop } = useStopButton({
        isRunning,
        addLog,
        listenFn: mockListen,
      });

      initiateStop();

      expect(isExecuteDisabledByStopping.value).toBe(true);
    });
  });

  describe('Emergency Stop Event', () => {
    it('should set isStopping when emergency-stop event is received during execution', async () => {
      const isRunning = ref(true);
      const logs: string[] = [];
      const addLog = (msg: string) => logs.push(msg);

      const { isStopping, setupEmergencyStopListener } = useStopButton({
        isRunning,
        addLog,
        listenFn: mockListen,
      });

      await setupEmergencyStopListener();

      emitEvent('emergency-stop');
      await nextTick();

      expect(isStopping.value).toBe(true);
    });

    it('should add emergency stop log when event is received', async () => {
      const isRunning = ref(true);
      const logs: string[] = [];
      const addLog = (msg: string) => logs.push(msg);

      const { setupEmergencyStopListener } = useStopButton({
        isRunning,
        addLog,
        listenFn: mockListen,
      });

      await setupEmergencyStopListener();

      emitEvent('emergency-stop');
      await nextTick();

      expect(logs).toContain('緊急停止が発動しました...');
    });

    it('should not set isStopping when not running', async () => {
      const isRunning = ref(false);
      const logs: string[] = [];
      const addLog = (msg: string) => logs.push(msg);

      const { isStopping, setupEmergencyStopListener } = useStopButton({
        isRunning,
        addLog,
        listenFn: mockListen,
      });

      await setupEmergencyStopListener();

      emitEvent('emergency-stop');
      await nextTick();

      expect(isStopping.value).toBe(false);
    });

    it('should not trigger twice if already stopping', async () => {
      const isRunning = ref(true);
      const logs: string[] = [];
      const addLog = (msg: string) => logs.push(msg);

      const { setupEmergencyStopListener, initiateStop } = useStopButton({
        isRunning,
        addLog,
        listenFn: mockListen,
      });

      await setupEmergencyStopListener();

      initiateStop(); // Already stopping
      logs.length = 0; // Clear logs

      emitEvent('emergency-stop');
      await nextTick();

      expect(logs).not.toContain('緊急停止が発動しました...');
    });
  });

  describe('Cleanup', () => {
    it('should clean up emergency stop listener', async () => {
      const isRunning = ref(true);
      const logs: string[] = [];
      const addLog = (msg: string) => logs.push(msg);

      const { setupEmergencyStopListener, cleanupEmergencyStopListener } = useStopButton({
        isRunning,
        addLog,
        listenFn: mockListen,
      });

      await setupEmergencyStopListener();
      expect(mockListeners.has('emergency-stop')).toBe(true);

      cleanupEmergencyStopListener();
      expect(mockListeners.has('emergency-stop')).toBe(false);
    });
  });
});
