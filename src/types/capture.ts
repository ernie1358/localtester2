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

/**
 * Error codes for template matching failures.
 * These codes allow programmatic error handling without parsing error messages.
 */
export type MatchErrorCode =
  | 'screenshot_decode_error'      // Screenshot could not be decoded (transient)
  | 'template_base64_decode_error' // Template base64 data is corrupted (permanent)
  | 'template_image_decode_error'  // Template image format is invalid (permanent)
  | 'insufficient_opacity'         // Template is too transparent (permanent)
  | 'non_finite_confidence'        // Template lacks variance (permanent)
  | 'template_too_large';          // Template larger than screenshot (size-related)

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
    /** Error code for programmatic error handling (use this instead of parsing error message) */
    errorCode: MatchErrorCode | null;
  };
}
