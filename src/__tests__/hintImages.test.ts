import { describe, it, expect } from 'vitest';
import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
  MAX_IMAGE_COUNT,
  MAX_TOTAL_SIZE,
  validateHintImages,
  trimHintImagesToLimit,
} from '../constants/hintImages';

describe('hintImages constants', () => {
  it('should have correct constant values', () => {
    expect(MAX_FILE_SIZE).toBe(5 * 1024 * 1024); // 5MB
    expect(MAX_IMAGE_COUNT).toBe(20);
    expect(MAX_TOTAL_SIZE).toBe(15 * 1024 * 1024); // 15MB
    expect(ALLOWED_MIME_TYPES).toContain('image/png');
    expect(ALLOWED_MIME_TYPES).toContain('image/jpeg');
    expect(ALLOWED_MIME_TYPES).toContain('image/gif');
    expect(ALLOWED_MIME_TYPES).toContain('image/webp');
  });
});

describe('validateHintImages', () => {
  // Helper to create a mock image with specified base64 size
  const createMockImage = (base64Length: number) => ({
    image_data: 'x'.repeat(base64Length),
  });

  it('should return valid for empty array', () => {
    const result = validateHintImages([]);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return valid for images within limits', () => {
    const images = Array(10)
      .fill(null)
      .map(() => createMockImage(1000)); // 10 small images
    const result = validateHintImages(images);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return error when count exceeds MAX_IMAGE_COUNT', () => {
    const images = Array(25)
      .fill(null)
      .map(() => createMockImage(100)); // 25 images
    const result = validateHintImages(images);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('20枚を超えています');
    expect(result.error).toContain('25枚');
  });

  it('should return error when total size exceeds MAX_TOTAL_SIZE', () => {
    // Create images that exceed 15MB total
    // base64 length * 0.75 ≈ bytes, so for 15MB we need ~20MB of base64
    const base64For5MB = Math.ceil((5 * 1024 * 1024) / 0.75);
    const images = Array(5)
      .fill(null)
      .map(() => createMockImage(base64For5MB)); // 5 images × 5MB = 25MB
    const result = validateHintImages(images);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('15MBを超えています');
  });

  it('should return valid at exactly MAX_IMAGE_COUNT', () => {
    const images = Array(20)
      .fill(null)
      .map(() => createMockImage(100)); // exactly 20 small images
    const result = validateHintImages(images);
    expect(result.valid).toBe(true);
  });
});

describe('trimHintImagesToLimit', () => {
  const createMockImage = (base64Length: number) => ({
    image_data: 'x'.repeat(base64Length),
  });

  it('should return empty array for empty input', () => {
    const { trimmed, removedCount } = trimHintImagesToLimit([]);
    expect(trimmed).toHaveLength(0);
    expect(removedCount).toBe(0);
  });

  it('should not trim images within limits', () => {
    const images = Array(10)
      .fill(null)
      .map(() => createMockImage(1000));
    const { trimmed, removedCount } = trimHintImagesToLimit(images);
    expect(trimmed).toHaveLength(10);
    expect(removedCount).toBe(0);
  });

  it('should trim images exceeding MAX_IMAGE_COUNT', () => {
    const images = Array(25)
      .fill(null)
      .map(() => createMockImage(100));
    const { trimmed, removedCount } = trimHintImagesToLimit(images);
    expect(trimmed).toHaveLength(20);
    expect(removedCount).toBe(5);
  });

  it('should trim images exceeding MAX_TOTAL_SIZE', () => {
    // Create 10 images of ~2MB each (total ~20MB > 15MB limit)
    const base64For2MB = Math.ceil((2 * 1024 * 1024) / 0.75);
    const images = Array(10)
      .fill(null)
      .map(() => createMockImage(base64For2MB));
    const { trimmed, removedCount } = trimHintImagesToLimit(images);
    // Should trim to fit within 15MB
    expect(trimmed.length).toBeLessThan(10);
    expect(removedCount).toBeGreaterThan(0);

    // Verify trimmed result is within limits
    const totalSize = trimmed.reduce(
      (sum, img) => sum + Math.ceil(img.image_data.length * 0.75),
      0
    );
    expect(totalSize).toBeLessThanOrEqual(MAX_TOTAL_SIZE);
  });

  it('should trim by count first, then by size', () => {
    // 25 images of ~1MB each
    const base64For1MB = Math.ceil((1 * 1024 * 1024) / 0.75);
    const images = Array(25)
      .fill(null)
      .map(() => createMockImage(base64For1MB));
    const { trimmed, removedCount } = trimHintImagesToLimit(images);

    // First trimmed to 20, then further trimmed to fit 15MB
    expect(trimmed.length).toBeLessThanOrEqual(20);
    expect(removedCount).toBeGreaterThanOrEqual(5);

    // Verify within limits
    const totalSize = trimmed.reduce(
      (sum, img) => sum + Math.ceil(img.image_data.length * 0.75),
      0
    );
    expect(totalSize).toBeLessThanOrEqual(MAX_TOTAL_SIZE);
  });
});
