/**
 * Types for the auto-updater system
 */

/**
 * Update availability status
 */
export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error';

/**
 * Information about an available update
 */
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string;
  date?: string;
}

/**
 * Download progress information
 */
export interface UpdateProgress {
  contentLength: number;
  downloaded: number;
  /** Progress percentage (0-100) */
  percentage: number;
}

/**
 * Return type for useUpdater composable
 */
export interface UseUpdaterReturn {
  status: import('vue').Ref<UpdateStatus>;
  updateInfo: import('vue').Ref<UpdateInfo | null>;
  progress: import('vue').Ref<UpdateProgress | null>;
  error: import('vue').Ref<string | null>;
  checkForUpdate: () => Promise<void>;
  downloadAndInstall: () => Promise<void>;
  dismissUpdate: () => void;
}
