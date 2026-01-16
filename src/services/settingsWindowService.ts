/**
 * Settings Window Service - Manage settings window
 * Uses handshake pattern similar to resultWindowService.ts
 */

import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

let settingsWindow: WebviewWindow | null = null;
let readyUnlisten: UnlistenFn | null = null;

/**
 * Open settings window
 * If already open, bring to front
 */
export async function openSettingsWindow(): Promise<void> {
  // If window already exists, just focus it
  if (settingsWindow) {
    try {
      await settingsWindow.setFocus();
      return;
    } catch {
      // Window may have been closed, continue to create new one
      settingsWindow = null;
    }
  }

  // Clean up previous listener if exists
  if (readyUnlisten) {
    readyUnlisten();
    readyUnlisten = null;
  }

  // Set up handshake state BEFORE creating window
  let resolveHandshake: (value: boolean) => void;
  const handshakePromise = new Promise<boolean>((resolve) => {
    resolveHandshake = resolve;
  });

  let timedOut = false;
  let readyReceived = false;

  // Set up listener BEFORE creating window
  readyUnlisten = await listen('settings-window-ready', async () => {
    if (readyReceived) return;
    readyReceived = true;

    // Clean up listener
    if (readyUnlisten) {
      readyUnlisten();
      readyUnlisten = null;
    }

    // Resolve the handshake
    if (!timedOut) {
      resolveHandshake(true);
    }
  });

  // Create new window AFTER listener is set up
  settingsWindow = new WebviewWindow('settings', {
    url: '/settings.html',
    title: '設定 - Xenotester',
    width: 500,
    height: 400,
    center: true,
    resizable: true,
    focus: true,
  });

  // Wait for window creation
  await new Promise<void>((resolve, reject) => {
    settingsWindow!.once('tauri://created', () => {
      resolve();
    });
    settingsWindow!.once('tauri://error', (e) => {
      reject(new Error(`Window creation failed: ${e}`));
    });
  });

  // Bring window to front
  try {
    await settingsWindow.setFocus();
  } catch {
    console.warn('[SettingsWindow] Failed to set focus');
  }

  // Start timeout after window is created
  const timeoutId = setTimeout(() => {
    if (readyReceived) return;
    timedOut = true;
    console.warn('[SettingsWindow] Handshake timeout');
    resolveHandshake(false);
  }, 5000);

  await handshakePromise;
  clearTimeout(timeoutId);
}

/**
 * Close settings window if open
 */
export async function closeSettingsWindow(): Promise<void> {
  // Clean up listener
  if (readyUnlisten) {
    readyUnlisten();
    readyUnlisten = null;
  }

  if (settingsWindow) {
    try {
      await settingsWindow.close();
    } catch {
      // Already closed
    }
    settingsWindow = null;
  }
}
