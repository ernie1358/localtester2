/**
 * Result Window Service - Manage result display window
 * Uses handshake pattern to ensure reliable data transmission
 */

import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { BatchExecutionResult } from '../types';

let resultWindow: WebviewWindow | null = null;
let pendingResult: BatchExecutionResult | null = null;
let readyUnlisten: UnlistenFn | null = null;

/**
 * Open result window and display execution results
 * Uses handshake pattern: waits for 'result-window-ready' before sending data
 * If timeout occurs, result is buffered and sent when window signals ready
 */
export async function openResultWindow(
  result: BatchExecutionResult
): Promise<void> {
  // Close existing window if any
  if (resultWindow) {
    try {
      await resultWindow.close();
    } catch {
      // Window may already be closed
    }
  }

  // Clean up previous listener if exists
  if (readyUnlisten) {
    readyUnlisten();
    readyUnlisten = null;
  }

  // Store result for potential deferred sending
  pendingResult = result;

  // Set up handshake state BEFORE creating window to avoid race condition
  let resolveHandshake: (value: boolean) => void;
  const handshakePromise = new Promise<boolean>((resolve) => {
    resolveHandshake = resolve;
  });

  let timedOut = false;
  let readyReceived = false;

  // Helper to send result when ready
  const sendResultWhenReady = async () => {
    if (pendingResult && resultWindow) {
      const resultToSend = pendingResult;
      pendingResult = null;
      await resultWindow.emit('execution-result', resultToSend);
    }
  };

  // Set up listener BEFORE creating window to catch early ready signals
  readyUnlisten = await listen('result-window-ready', async () => {
    if (readyReceived) return; // Prevent duplicate handling
    readyReceived = true;

    // Clean up listener
    if (readyUnlisten) {
      readyUnlisten();
      readyUnlisten = null;
    }

    // Send result
    await sendResultWhenReady();

    // Resolve the handshake if not timed out
    if (!timedOut) {
      resolveHandshake(true);
    }
  });

  // Create new window AFTER listener is set up
  resultWindow = new WebviewWindow('result', {
    url: '/result.html',
    title: '実行結果 - Xenotester',
    width: 700,
    height: 600,
    center: true,
    resizable: true,
    focus: true,
  });

  // Wait for window creation
  await new Promise<void>((resolve, reject) => {
    resultWindow!.once('tauri://created', () => {
      resolve();
    });
    resultWindow!.once('tauri://error', (e) => {
      reject(new Error(`Window creation failed: ${e}`));
    });
  });

  // Bring window to front (best-effort: don't fail if focus fails)
  try {
    await resultWindow.setFocus();
  } catch {
    console.warn('[ResultWindow] Failed to set focus - window may still be visible');
  }

  // Start timeout after window is created
  const timeoutId = setTimeout(() => {
    if (readyReceived) return; // Ready already received
    timedOut = true;
    console.warn('[ResultWindow] Handshake timeout - result will be sent when window signals ready');
    resolveHandshake(false);
  }, 5000);

  const handshakeComplete = await handshakePromise;
  clearTimeout(timeoutId);

  // If handshake completed successfully, result was already sent
  // If timeout occurred, listener remains active to send result when ready
  if (!handshakeComplete) {
    console.log('[ResultWindow] Waiting for deferred ready signal...');
  }
}

/**
 * Close result window if open
 */
export async function closeResultWindow(): Promise<void> {
  // Clean up listener
  if (readyUnlisten) {
    readyUnlisten();
    readyUnlisten = null;
  }
  pendingResult = null;

  if (resultWindow) {
    try {
      await resultWindow.close();
    } catch {
      // Already closed
    }
    resultWindow = null;
  }
}
