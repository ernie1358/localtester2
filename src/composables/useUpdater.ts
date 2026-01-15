/**
 * Composable for managing application auto-updates
 *
 * Features:
 * - Checks for updates on app startup (with 3s delay)
 * - Checks for updates every 1 hour
 * - Downloads and installs updates only when user clicks "Update Now"
 * - Tracks download progress
 * - Skips checks in development mode
 */

import { ref, onUnmounted } from 'vue';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import type {
  UpdateStatus,
  UpdateInfo,
  UpdateProgress,
  UseUpdaterReturn,
} from '../types/updater';

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const STARTUP_DELAY_MS = 3000; // 3 seconds

export function useUpdater(): UseUpdaterReturn {
  const status = ref<UpdateStatus>('idle');
  const updateInfo = ref<UpdateInfo | null>(null);
  const progress = ref<UpdateProgress | null>(null);
  const error = ref<string | null>(null);

  let intervalId: ReturnType<typeof setInterval> | null = null;
  let startupTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let currentUpdate: Update | null = null;
  let isChecking = false;

  /**
   * Check for available updates (detection only, no download)
   */
  async function checkForUpdate(): Promise<void> {
    // Skip in development mode
    if (import.meta.env.DEV) {
      console.log('[Updater] Skipping update check in development mode');
      return;
    }

    // Prevent double-checking
    if (isChecking) {
      console.log('[Updater] Check already in progress, skipping');
      return;
    }

    // Skip check during download/install
    if (status.value === 'downloading' || status.value === 'ready') {
      console.log('[Updater] Skipping check during download/install');
      return;
    }

    isChecking = true;
    status.value = 'checking';
    error.value = null;

    try {
      console.log('[Updater] Checking for updates...');
      const update = await check();

      if (update) {
        console.log('[Updater] Update available:', update.version);
        currentUpdate = update;
        updateInfo.value = {
          version: update.version,
          currentVersion: update.currentVersion,
          notes: update.body ?? '',
          date: update.date ?? undefined,
        };
        status.value = 'available';
      } else {
        console.log('[Updater] No update available');
        status.value = 'idle';
        updateInfo.value = null;
      }
    } catch (e) {
      console.error('[Updater] Failed to check for updates:', e);
      error.value = e instanceof Error ? e.message : String(e);
      status.value = 'error';
    } finally {
      isChecking = false;
    }
  }

  /**
   * Download and install the available update
   * Only called when user clicks "Update Now"
   */
  async function downloadAndInstall(): Promise<void> {
    if (!currentUpdate) {
      console.error('[Updater] No update available to install');
      return;
    }

    status.value = 'downloading';
    progress.value = { contentLength: 0, downloaded: 0, percentage: 0 };

    try {
      console.log('[Updater] Downloading update...');

      await currentUpdate.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          progress.value = {
            contentLength: event.data.contentLength ?? 0,
            downloaded: 0,
            percentage: 0,
          };
        } else if (event.event === 'Progress') {
          const downloaded =
            (progress.value?.downloaded ?? 0) + event.data.chunkLength;
          const total = Math.max(progress.value?.contentLength ?? 1, 1);
          progress.value = {
            contentLength: progress.value?.contentLength ?? 0,
            downloaded,
            percentage: Math.min(Math.round((downloaded / total) * 100), 100),
          };
        } else if (event.event === 'Finished') {
          progress.value = {
            contentLength: progress.value?.contentLength ?? 0,
            downloaded: progress.value?.contentLength ?? 0,
            percentage: 100,
          };
        }
      });

      console.log('[Updater] Update installed, relaunching...');
      status.value = 'ready';

      // Relaunch the application
      await relaunch();
    } catch (e) {
      console.error('[Updater] Failed to download/install update:', e);
      error.value = e instanceof Error ? e.message : String(e);
      status.value = 'error';
    }
  }

  /**
   * Dismiss the update notification
   */
  function dismissUpdate(): void {
    status.value = 'idle';
    updateInfo.value = null;
    currentUpdate = null;
  }

  /**
   * Start periodic update checks
   */
  function startPeriodicChecks(): void {
    // Skip in development mode
    if (import.meta.env.DEV) {
      return;
    }

    // Initial check after startup delay
    startupTimeoutId = setTimeout(() => {
      checkForUpdate();
    }, STARTUP_DELAY_MS);

    // Periodic checks every hour
    intervalId = setInterval(() => {
      checkForUpdate();
    }, CHECK_INTERVAL_MS);
  }

  /**
   * Stop periodic update checks and cleanup
   */
  function cleanup(): void {
    if (startupTimeoutId) {
      clearTimeout(startupTimeoutId);
      startupTimeoutId = null;
    }
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  // Start periodic checks on mount
  startPeriodicChecks();

  // Cleanup on unmount
  onUnmounted(() => {
    cleanup();
  });

  return {
    status,
    updateInfo,
    progress,
    error,
    checkForUpdate,
    downloadAndInstall,
    dismissUpdate,
  };
}
