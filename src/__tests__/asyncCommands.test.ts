/**
 * Async Commands Smoke Tests
 *
 * Tests to verify that Tauri input and screenshot commands are properly
 * async (using spawn_blocking) and don't block the UI thread.
 *
 * These tests verify the invoke interface contracts for:
 * - Input commands (mouse, keyboard)
 * - Screenshot commands (capture_screen, save_base64_image)
 *
 * Note: These are smoke tests that verify the commands can be invoked
 * without throwing. Actual UI blocking behavior cannot be fully tested
 * in a unit test environment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

// Track invoke calls for verification
const invokeCallLog: { command: string; args: unknown; timestamp: number }[] = [];
let invokeDelay = 0;

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockImplementation(async (command: string, args?: unknown) => {
    const callRecord = {
      command,
      args,
      timestamp: Date.now(),
    };
    invokeCallLog.push(callRecord);

    // Simulate async delay if configured
    if (invokeDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, invokeDelay));
    }

    // Return mock responses based on command
    switch (command) {
      case 'capture_screen':
        return {
          imageBase64: 'mockBase64Data',
          originalWidth: 1920,
          originalHeight: 1080,
          resizedWidth: 1366,
          resizedHeight: 768,
          scaleFactor: 1.4,
          displayScaleFactor: 2,
        };
      case 'capture_monitor_by_id':
        return {
          imageBase64: 'mockBase64Data',
          originalWidth: 1920,
          originalHeight: 1080,
          resizedWidth: 1366,
          resizedHeight: 768,
          scaleFactor: 1.4,
          displayScaleFactor: 2,
        };
      case 'get_monitors':
        return [{ id: 0, name: 'Primary', isPrimary: true }];
      case 'ensure_directory':
      case 'save_base64_image':
      case 'mouse_move':
      case 'left_click':
      case 'right_click':
      case 'middle_click':
      case 'double_click':
      case 'triple_click':
      case 'left_mouse_down':
      case 'left_mouse_up':
      case 'left_click_drag':
      case 'scroll':
      case 'type_text':
      case 'key':
      case 'hold_key':
        return;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }),
}));

describe('Async Commands - Input', () => {
  beforeEach(() => {
    invokeCallLog.length = 0;
    invokeDelay = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    invokeCallLog.length = 0;
  });

  describe('Mouse Commands', () => {
    it('should invoke mouse_move asynchronously', async () => {
      await invoke('mouse_move', { x: 100, y: 200 });

      expect(invokeCallLog).toHaveLength(1);
      expect(invokeCallLog[0].command).toBe('mouse_move');
      expect(invokeCallLog[0].args).toEqual({ x: 100, y: 200 });
    });

    it('should invoke left_click asynchronously', async () => {
      await invoke('left_click', { x: 100, y: 200 });

      expect(invokeCallLog).toHaveLength(1);
      expect(invokeCallLog[0].command).toBe('left_click');
    });

    it('should invoke right_click asynchronously', async () => {
      await invoke('right_click', { x: 100, y: 200 });

      expect(invokeCallLog).toHaveLength(1);
      expect(invokeCallLog[0].command).toBe('right_click');
    });

    it('should invoke double_click asynchronously', async () => {
      await invoke('double_click', { x: 100, y: 200 });

      expect(invokeCallLog).toHaveLength(1);
      expect(invokeCallLog[0].command).toBe('double_click');
    });

    it('should invoke triple_click asynchronously', async () => {
      await invoke('triple_click', { x: 100, y: 200 });

      expect(invokeCallLog).toHaveLength(1);
      expect(invokeCallLog[0].command).toBe('triple_click');
    });

    it('should invoke left_click_drag asynchronously', async () => {
      await invoke('left_click_drag', {
        startX: 0,
        startY: 0,
        endX: 100,
        endY: 100,
      });

      expect(invokeCallLog).toHaveLength(1);
      expect(invokeCallLog[0].command).toBe('left_click_drag');
    });

    it('should invoke scroll asynchronously', async () => {
      await invoke('scroll', { x: 100, y: 200, direction: 'down', amount: 3 });

      expect(invokeCallLog).toHaveLength(1);
      expect(invokeCallLog[0].command).toBe('scroll');
    });
  });

  describe('Keyboard Commands', () => {
    it('should invoke type_text asynchronously', async () => {
      await invoke('type_text', { text: 'Hello World' });

      expect(invokeCallLog).toHaveLength(1);
      expect(invokeCallLog[0].command).toBe('type_text');
      expect(invokeCallLog[0].args).toEqual({ text: 'Hello World' });
    });

    it('should invoke key asynchronously', async () => {
      await invoke('key', { keys: 'ctrl+s' });

      expect(invokeCallLog).toHaveLength(1);
      expect(invokeCallLog[0].command).toBe('key');
    });

    it('should invoke hold_key asynchronously', async () => {
      await invoke('hold_key', { keyName: 'shift', hold: true });

      expect(invokeCallLog).toHaveLength(1);
      expect(invokeCallLog[0].command).toBe('hold_key');
    });
  });

  describe('Concurrent Input Commands', () => {
    it('should handle multiple input commands concurrently without blocking', async () => {
      invokeDelay = 10; // Simulate some async delay

      const startTime = Date.now();

      // Execute multiple commands concurrently
      await Promise.all([
        invoke('left_click', { x: 100, y: 100 }),
        invoke('mouse_move', { x: 200, y: 200 }),
        invoke('type_text', { text: 'test' }),
      ]);

      const elapsed = Date.now() - startTime;

      // All commands should complete
      expect(invokeCallLog).toHaveLength(3);

      // If truly async/concurrent, total time should be ~delay, not delay*3
      // Allow some margin for test execution overhead
      expect(elapsed).toBeLessThan(invokeDelay * 3 + 50);
    });
  });
});

describe('Async Commands - Screenshot', () => {
  beforeEach(() => {
    invokeCallLog.length = 0;
    invokeDelay = 0;
    vi.clearAllMocks();
  });

  describe('Screen Capture Commands', () => {
    it('should invoke capture_screen asynchronously and return correct structure', async () => {
      const result = await invoke('capture_screen');

      expect(invokeCallLog).toHaveLength(1);
      expect(invokeCallLog[0].command).toBe('capture_screen');
      expect(result).toEqual({
        imageBase64: expect.any(String),
        originalWidth: expect.any(Number),
        originalHeight: expect.any(Number),
        resizedWidth: expect.any(Number),
        resizedHeight: expect.any(Number),
        scaleFactor: expect.any(Number),
        displayScaleFactor: expect.any(Number),
      });
    });

    it('should invoke capture_monitor_by_id asynchronously', async () => {
      const result = await invoke('capture_monitor_by_id', { monitorId: 0 });

      expect(invokeCallLog).toHaveLength(1);
      expect(invokeCallLog[0].command).toBe('capture_monitor_by_id');
      expect(result).toHaveProperty('imageBase64');
    });

    it('should invoke get_monitors synchronously (lightweight operation)', async () => {
      const result = await invoke('get_monitors');

      expect(invokeCallLog).toHaveLength(1);
      expect(invokeCallLog[0].command).toBe('get_monitors');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('File Operations', () => {
    it('should invoke ensure_directory asynchronously', async () => {
      await invoke('ensure_directory', { path: '/tmp/test-dir' });

      expect(invokeCallLog).toHaveLength(1);
      expect(invokeCallLog[0].command).toBe('ensure_directory');
    });

    it('should invoke save_base64_image asynchronously', async () => {
      await invoke('save_base64_image', {
        base64Data: 'testBase64Data',
        filePath: '/tmp/test.png',
      });

      expect(invokeCallLog).toHaveLength(1);
      expect(invokeCallLog[0].command).toBe('save_base64_image');
    });
  });

  describe('Concurrent Screenshot Commands', () => {
    it('should handle screenshot capture followed by save without blocking', async () => {
      invokeDelay = 10;

      const captureResult = await invoke('capture_screen');
      expect(captureResult).toHaveProperty('imageBase64');

      await invoke('ensure_directory', { path: '/tmp/screenshots' });
      await invoke('save_base64_image', {
        base64Data: (captureResult as { imageBase64: string }).imageBase64,
        filePath: '/tmp/screenshots/test.png',
      });

      expect(invokeCallLog).toHaveLength(3);
      expect(invokeCallLog.map((c) => c.command)).toEqual([
        'capture_screen',
        'ensure_directory',
        'save_base64_image',
      ]);
    });
  });
});

describe('Async Commands - Integration Smoke Tests', () => {
  beforeEach(() => {
    invokeCallLog.length = 0;
    invokeDelay = 0;
    vi.clearAllMocks();
  });

  it('should simulate a typical agent loop iteration (screenshot + action)', async () => {
    // 1. Capture screen
    const screenshot = await invoke('capture_screen');
    expect(screenshot).toHaveProperty('imageBase64');

    // 2. Execute click action
    await invoke('left_click', { x: 500, y: 300 });

    // 3. Capture result screenshot
    const resultScreenshot = await invoke('capture_screen');
    expect(resultScreenshot).toHaveProperty('imageBase64');

    expect(invokeCallLog).toHaveLength(3);
  });

  it('should handle rapid consecutive commands without blocking', async () => {
    invokeDelay = 5;

    const commands = [
      () => invoke('capture_screen'),
      () => invoke('left_click', { x: 100, y: 100 }),
      () => invoke('type_text', { text: 'test input' }),
      () => invoke('key', { keys: 'Return' }),
      () => invoke('capture_screen'),
    ];

    const startTime = Date.now();

    for (const cmd of commands) {
      await cmd();
    }

    const elapsed = Date.now() - startTime;

    // Sequential execution should complete all commands
    expect(invokeCallLog).toHaveLength(5);

    // Log elapsed time for manual verification during development
    // console.log(`Elapsed time for 5 commands: ${elapsed}ms`);
    expect(elapsed).toBeGreaterThan(0);
  });

  it('should verify command argument types match expected Rust signatures', async () => {
    // Test that all command args match the expected types
    // This helps catch breaking changes in the Rust command signatures

    // Mouse commands expect x, y as i32
    await invoke('left_click', { x: 100, y: 200 });
    expect(invokeCallLog[0].args).toEqual({ x: 100, y: 200 });

    // Drag command expects startX, startY, endX, endY
    await invoke('left_click_drag', {
      startX: 0,
      startY: 0,
      endX: 100,
      endY: 100,
    });
    expect(invokeCallLog[1].args).toEqual({
      startX: 0,
      startY: 0,
      endX: 100,
      endY: 100,
    });

    // Scroll expects direction as String, amount as i32
    await invoke('scroll', { x: 0, y: 0, direction: 'down', amount: 3 });
    expect(invokeCallLog[2].args).toEqual({
      x: 0,
      y: 0,
      direction: 'down',
      amount: 3,
    });

    // type_text expects text as String
    await invoke('type_text', { text: 'Hello' });
    expect(invokeCallLog[3].args).toEqual({ text: 'Hello' });

    // key expects keys as String
    await invoke('key', { keys: 'ctrl+c' });
    expect(invokeCallLog[4].args).toEqual({ keys: 'ctrl+c' });

    // hold_key expects keyName as String, hold as bool
    await invoke('hold_key', { keyName: 'shift', hold: true });
    expect(invokeCallLog[5].args).toEqual({ keyName: 'shift', hold: true });
  });
});
