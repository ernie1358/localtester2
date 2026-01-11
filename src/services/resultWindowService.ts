/**
 * Result Window Service - Manage result display window
 * Uses handshake pattern to ensure reliable data transmission
 */

import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { BatchExecutionResult } from '../types';

let resultWindow: WebviewWindow | null = null;

/**
 * Open result window and display execution results
 * Uses handshake pattern: waits for 'result-window-ready' before sending data
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

  // Create new window
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

  // Handshake: wait for result window to signal readiness
  await new Promise<void>((resolve) => {
    let unlisten: UnlistenFn | null = null;
    let timeoutId: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      if (unlisten) unlisten();
      clearTimeout(timeoutId);
    };

    listen('result-window-ready', () => {
      cleanup();
      resolve();
    }).then((fn) => {
      unlisten = fn;
    });

    // Timeout: proceed after 5 seconds even if no ready signal (fallback)
    timeoutId = setTimeout(() => {
      console.warn('[ResultWindow] Handshake timeout - proceeding anyway');
      cleanup();
      resolve();
    }, 5000);
  });

  // Send result data to the window
  await resultWindow.emit('execution-result', result);
}

/**
 * Close result window if open
 */
export async function closeResultWindow(): Promise<void> {
  if (resultWindow) {
    try {
      await resultWindow.close();
    } catch {
      // Already closed
    }
    resultWindow = null;
  }
}
