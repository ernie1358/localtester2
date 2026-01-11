/**
 * Coordinate scaling utilities
 * Convert between Claude coordinates (resized image) and screen coordinates
 */

export interface Coordinate {
  x: number;
  y: number;
}

/**
 * Convert Claude coordinate (on resized image) to screen coordinate
 * @param claudeCoord Coordinate from Claude (on resized image)
 * @param scaleFactor Scale factor used for resizing (resized / original)
 * @returns Screen coordinate
 */
export function toScreenCoordinate(
  claudeCoord: Coordinate,
  scaleFactor: number
): Coordinate {
  return {
    x: Math.round(claudeCoord.x / scaleFactor),
    y: Math.round(claudeCoord.y / scaleFactor),
  };
}

/**
 * Convert screen coordinate to Claude coordinate (on resized image)
 * @param screenCoord Screen coordinate
 * @param scaleFactor Scale factor used for resizing
 * @returns Coordinate on resized image
 */
export function toClaudeCoordinate(
  screenCoord: Coordinate,
  scaleFactor: number
): Coordinate {
  return {
    x: Math.round(screenCoord.x * scaleFactor),
    y: Math.round(screenCoord.y * scaleFactor),
  };
}
