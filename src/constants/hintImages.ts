/**
 * Hint Image Constants
 *
 * These constants define the limits for hint images based on Claude API constraints:
 * - Claude API has a 32MB request size limit
 * - When 20+ images are in a request, Claude API enforces 2000px dimension limit
 * - Individual images should not exceed 5MB for efficient processing
 *
 * These are intentional technical constraints, not arbitrary UI limitations.
 */

/** Allowed MIME types for hint images (Claude API supported formats) */
export const ALLOWED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg', // Non-standard but accepted, will be normalized to image/jpeg
  'image/gif',
  'image/webp',
] as const;

/** Maximum size per image file in bytes (5MB - Claude API efficient processing limit) */
export const MAX_FILE_SIZE = 5 * 1024 * 1024;

/**
 * Maximum number of hint images per scenario
 * Claude API allows up to 100 images, but 20+ triggers 2000px dimension limit
 * which degrades image quality for UI element detection
 */
export const MAX_IMAGE_COUNT = 20;

/**
 * Maximum total size for all hint images in bytes (11MB raw, ~14.7MB after base64)
 * Claude API has 32MB request limit; reserving space for:
 * - Base64 encoding overhead (+33%): 11MB → ~14.7MB
 * - Screenshots during computer use (~10MB buffer)
 * - Request metadata and other content (~7MB buffer)
 * Total: ~14.7MB + ~10MB + ~7MB ≈ 32MB
 */
export const MAX_TOTAL_SIZE = 11 * 1024 * 1024;

/**
 * Validates hint images against API constraints
 * @param images Array of images with their base64 data
 * @returns Object with validation result and any error/warning messages
 */
export interface ImageValidationResult {
  valid: boolean;
  error?: string;
  warning?: string;
  trimmedCount?: number;
}

/**
 * Extended image interface for runtime validation (includes MIME type)
 */
export interface ValidatableImage {
  image_data: string;
  mime_type?: string;
}

export function validateHintImages(
  images: ValidatableImage[]
): ImageValidationResult {
  if (images.length === 0) {
    return { valid: true };
  }

  // Check count limit
  if (images.length > MAX_IMAGE_COUNT) {
    return {
      valid: false,
      error: `ヒント画像が${MAX_IMAGE_COUNT}枚を超えています（現在: ${images.length}枚）。API制限のため、${MAX_IMAGE_COUNT}枚以下に減らしてください。`,
    };
  }

  // Validate individual images (size and MIME type)
  const invalidImages: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const imageSize = Math.ceil(img.image_data.length * 0.75);

    // Check individual file size
    if (imageSize > MAX_FILE_SIZE) {
      const sizeMB = (imageSize / (1024 * 1024)).toFixed(1);
      invalidImages.push(`画像${i + 1}: ${sizeMB}MBが5MBを超えています`);
    }

    // Check MIME type if available
    if (img.mime_type) {
      const normalizedMime = img.mime_type === 'image/jpg' ? 'image/jpeg' : img.mime_type;
      if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(normalizedMime)) {
        invalidImages.push(`画像${i + 1}: 非対応形式(${img.mime_type})`);
      }
    }
  }

  if (invalidImages.length > 0) {
    return {
      valid: false,
      error: `不正な画像があります: ${invalidImages.join(', ')}`,
    };
  }

  // Calculate total size (base64 to bytes: length * 0.75)
  const totalSize = images.reduce((sum, img) => {
    return sum + Math.ceil(img.image_data.length * 0.75);
  }, 0);

  if (totalSize > MAX_TOTAL_SIZE) {
    const totalMB = (totalSize / (1024 * 1024)).toFixed(1);
    const limitMB = (MAX_TOTAL_SIZE / (1024 * 1024)).toFixed(0);
    return {
      valid: false,
      error: `ヒント画像の総容量が${limitMB}MBを超えています（現在: ${totalMB}MB）。API制限のため、画像を減らすか圧縮してください。`,
    };
  }

  return { valid: true };
}

/**
 * Trims hint images to fit within API constraints
 * Removes invalid images (size/MIME) first, then trims from end until within limits
 * @param images Array of images to trim
 * @returns Trimmed array and count of removed images
 */
export function trimHintImagesToLimit(
  images: ValidatableImage[]
): { trimmed: ValidatableImage[]; removedCount: number } {
  if (images.length === 0) {
    return { trimmed: [], removedCount: 0 };
  }

  let removedCount = 0;

  // First, filter out invalid images (size > 5MB or invalid MIME type)
  let trimmed = images.filter((img) => {
    const imageSize = Math.ceil(img.image_data.length * 0.75);

    // Check individual file size
    if (imageSize > MAX_FILE_SIZE) {
      removedCount++;
      return false;
    }

    // Check MIME type if available
    if (img.mime_type) {
      const normalizedMime = img.mime_type === 'image/jpg' ? 'image/jpeg' : img.mime_type;
      if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(normalizedMime)) {
        removedCount++;
        return false;
      }
    }

    return true;
  });

  // Second, trim to count limit
  if (trimmed.length > MAX_IMAGE_COUNT) {
    removedCount += trimmed.length - MAX_IMAGE_COUNT;
    trimmed = trimmed.slice(0, MAX_IMAGE_COUNT);
  }

  // Third, trim to size limit
  let totalSize = trimmed.reduce((sum, img) => {
    return sum + Math.ceil(img.image_data.length * 0.75);
  }, 0);

  while (totalSize > MAX_TOTAL_SIZE && trimmed.length > 0) {
    const removed = trimmed.pop();
    if (removed) {
      removedCount++;
      totalSize -= Math.ceil(removed.image_data.length * 0.75);
    }
  }

  return { trimmed, removedCount };
}
