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

/** Result of template matching for a single hint image */
export interface HintImageMatchResult {
  /** Index of the hint image in the original array */
  index: number;
  /** Original file name for identification */
  fileName: string;
  /** Match result with coordinates or error */
  matchResult: {
    /** Whether a match was found above the confidence threshold */
    found: boolean;
    /** X coordinate of the center point (in resized screenshot coordinates) */
    centerX: number | null;
    /** Y coordinate of the center point (in resized screenshot coordinates) */
    centerY: number | null;
    /** Match confidence score (0.0 - 1.0) */
    confidence: number | null;
    /** Template width after scaling */
    templateWidth: number;
    /** Template height after scaling */
    templateHeight: number;
    /** Error message if matching failed for this specific image */
    error: string | null;
  };
}
