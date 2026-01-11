/**
 * Screen capture type definitions
 */

/** Monitor information */
export interface MonitorInfo {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isPrimary: boolean;
}

/** Screen capture result */
export interface CaptureResult {
  originalWidth: number;
  originalHeight: number;
  resizedWidth: number;
  resizedHeight: number;
  scaleFactor: number;
  imageBase64: string;
  monitorId: number;
  /** Display scale factor for HiDPI/Retina displays (e.g., 2.0 for Retina) */
  displayScaleFactor: number;
}

/** Permission status (macOS) */
export interface PermissionStatus {
  screenRecording: boolean;
  accessibility: boolean;
}
