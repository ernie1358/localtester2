/**
 * Coordinate scaling utilities
 * Convert between Claude coordinates (resized image) and screen coordinates
 */

export interface Coordinate {
  x: number;
  y: number;
}

/**
 * Convert Claude coordinate (on resized image) to screen coordinate (logical points)
 *
 * Conversion steps:
 * 1. Claude coordinates are on the resized image (physical pixels, scaled down)
 * 2. Divide by scaleFactor to get original physical pixel coordinates
 * 3. Divide by displayScaleFactor to get logical points (for HiDPI/Retina displays)
 *
 * @param claudeCoord Coordinate from Claude (on resized image)
 * @param scaleFactor Scale factor used for resizing (resized / original)
 * @param displayScaleFactor HiDPI/Retina scale factor (default: 1.0)
 * @returns Screen coordinate in logical points (for input APIs like enigo)
 */
export function toScreenCoordinate(
  claudeCoord: Coordinate,
  scaleFactor: number,
  displayScaleFactor: number = 1.0
): Coordinate {
  // Convert: Claude coord → physical pixels → logical points
  // logical = claude / scaleFactor / displayScaleFactor
  const combinedScale = scaleFactor * displayScaleFactor;
  return {
    x: Math.round(claudeCoord.x / combinedScale),
    y: Math.round(claudeCoord.y / combinedScale),
  };
}

/**
 * Convert screen coordinate (logical points) to Claude coordinate (on resized image)
 *
 * Conversion steps (reverse of toScreenCoordinate):
 * 1. Logical points → physical pixels (multiply by displayScaleFactor)
 * 2. Physical pixels → Claude coordinates (multiply by scaleFactor)
 *
 * @param screenCoord Screen coordinate in logical points
 * @param scaleFactor Scale factor used for resizing (resized / original)
 * @param displayScaleFactor HiDPI/Retina scale factor (default: 1.0)
 * @returns Coordinate on resized image (for Claude)
 */
export function toClaudeCoordinate(
  screenCoord: Coordinate,
  scaleFactor: number,
  displayScaleFactor: number = 1.0
): Coordinate {
  // Convert: logical points → physical pixels → Claude coord
  // claude = logical * displayScaleFactor * scaleFactor
  const combinedScale = scaleFactor * displayScaleFactor;
  return {
    x: Math.round(screenCoord.x * combinedScale),
    y: Math.round(screenCoord.y * combinedScale),
  };
}
