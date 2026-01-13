//! Template matching service for hint image coordinate detection
//!
//! This module provides functionality to detect hint images within screenshots
//! using template matching (Sum of Squared Differences algorithm).

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use image::{DynamicImage, GenericImageView};
use imageproc::template_matching::{find_extremes, match_template, MatchTemplateMethod};
use serde::Serialize;

use crate::error::XenotesterError;

/// Result of template matching for a single hint image
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchResult {
    /// Whether a match was found above the confidence threshold
    pub found: bool,
    /// X coordinate of the center point (in resized screenshot coordinates)
    pub center_x: Option<i32>,
    /// Y coordinate of the center point (in resized screenshot coordinates)
    pub center_y: Option<i32>,
    /// Match confidence score (0.0 - 1.0, where 1.0 is perfect match)
    pub confidence: Option<f32>,
    /// Template width after scaling
    pub template_width: u32,
    /// Template height after scaling
    pub template_height: u32,
    /// Error message if matching failed for this image
    pub error: Option<String>,
}

/// Find template image within screenshot and return center coordinates
///
/// # Arguments
/// * `screenshot_base64` - Base64 encoded screenshot (already resized)
/// * `template_base64` - Base64 encoded hint image (original size)
/// * `scale_factor` - Scale factor applied to screenshot (e.g., 0.6 means 60% of original)
/// * `confidence_threshold` - Minimum confidence score to consider a match (0.0 - 1.0)
///
/// # Returns
/// MatchResult with center coordinates if found, or error information if failed
///
/// # Scale Alignment
/// The screenshot is already resized (e.g., 2560px → 1560px).
/// The hint image is resized by the same scale_factor before matching.
/// Returned coordinates are in the resized screenshot coordinate system,
/// which matches the coordinate system used when sending to LLM.
pub fn find_template_in_screenshot(
    screenshot_base64: &str,
    template_base64: &str,
    scale_factor: f64,
    confidence_threshold: f32,
) -> MatchResult {
    // Catch all errors and return them in MatchResult.error
    match find_template_internal(screenshot_base64, template_base64, scale_factor, confidence_threshold) {
        Ok(result) => result,
        Err(e) => MatchResult {
            found: false,
            center_x: None,
            center_y: None,
            confidence: None,
            template_width: 0,
            template_height: 0,
            error: Some(e.to_string()),
        },
    }
}

/// Internal implementation that returns Result for error handling
fn find_template_internal(
    screenshot_base64: &str,
    template_base64: &str,
    scale_factor: f64,
    confidence_threshold: f32,
) -> Result<MatchResult, XenotesterError> {
    // Decode base64 images
    let screenshot = decode_base64_image(screenshot_base64)?;
    let template_original = decode_base64_image(template_base64)?;

    // Scale alignment: resize hint image by same factor as screenshot
    // Screenshot is already resized (scale_factor applied)
    // Hint image needs same scale_factor to match sizes
    let template = if scale_factor < 1.0 {
        let (orig_w, orig_h) = template_original.dimensions();
        let new_w = ((orig_w as f64) * scale_factor).round() as u32;
        let new_h = ((orig_h as f64) * scale_factor).round() as u32;

        // Ensure minimum size of 1x1 pixel
        let new_w = new_w.max(1);
        let new_h = new_h.max(1);

        template_original.resize_exact(new_w, new_h, image::imageops::FilterType::Lanczos3)
    } else {
        template_original
    };

    // Convert to grayscale for matching (reduces computation and improves robustness)
    let screenshot_gray = screenshot.to_luma8();
    let template_gray = template.to_luma8();

    let template_width = template_gray.width();
    let template_height = template_gray.height();

    // Check if template is larger than screenshot (cannot match)
    if template_width > screenshot_gray.width() || template_height > screenshot_gray.height() {
        return Ok(MatchResult {
            found: false,
            center_x: None,
            center_y: None,
            confidence: Some(0.0),
            template_width,
            template_height,
            error: Some("Template is larger than screenshot after scaling".to_string()),
        });
    }

    // Perform template matching using Sum of Squared Errors (Normalized)
    // SSE Normalized gives values from 0.0 (perfect match) to higher values (no match)
    let result = match_template(
        &screenshot_gray,
        &template_gray,
        MatchTemplateMethod::SumOfSquaredErrorsNormalized,
    );

    // Find the minimum value location (best match for SSD)
    let extremes = find_extremes(&result);

    // Convert SSD score to confidence (1.0 - min_value)
    // SSD: 0.0 = perfect match, so confidence = 1.0 - 0.0 = 1.0
    let confidence = 1.0 - extremes.min_value;

    if confidence >= confidence_threshold {
        // Calculate center coordinates
        // match_x, match_y is top-left corner of matched region
        // Add half of template dimensions to get center point
        let (match_x, match_y) = extremes.min_value_location;
        let center_x = match_x as i32 + (template_width / 2) as i32;
        let center_y = match_y as i32 + (template_height / 2) as i32;

        Ok(MatchResult {
            found: true,
            center_x: Some(center_x),
            center_y: Some(center_y),
            confidence: Some(confidence),
            template_width,
            template_height,
            error: None,
        })
    } else {
        Ok(MatchResult {
            found: false,
            center_x: None,
            center_y: None,
            confidence: Some(confidence),
            template_width,
            template_height,
            error: None,
        })
    }
}

/// Decode base64 string to DynamicImage
fn decode_base64_image(base64_data: &str) -> Result<DynamicImage, XenotesterError> {
    let bytes = BASE64_STANDARD
        .decode(base64_data)
        .map_err(|e| XenotesterError::ImageError(format!("Base64 decode error: {}", e)))?;

    image::load_from_memory(&bytes)
        .map_err(|e| XenotesterError::ImageError(format!("Image decode error: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, ImageEncoder, Luma, Rgb, RgbImage};

    /// Helper to create a simple test image and encode to base64
    fn create_test_image(width: u32, height: u32, color: [u8; 3]) -> String {
        let mut img: RgbImage = ImageBuffer::new(width, height);
        for pixel in img.pixels_mut() {
            *pixel = Rgb(color);
        }

        let mut buffer = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut buffer);
        encoder
            .write_image(
                img.as_raw(),
                width,
                height,
                image::ExtendedColorType::Rgb8,
            )
            .unwrap();

        BASE64_STANDARD.encode(&buffer)
    }

    /// Helper to create a grayscale image with a specific region
    fn create_screenshot_with_target(
        width: u32,
        height: u32,
        target_x: u32,
        target_y: u32,
        target_w: u32,
        target_h: u32,
    ) -> String {
        let mut img: ImageBuffer<Luma<u8>, Vec<u8>> = ImageBuffer::new(width, height);

        // Fill background with gray
        for pixel in img.pixels_mut() {
            *pixel = Luma([128]);
        }

        // Draw white target region
        for y in target_y..(target_y + target_h).min(height) {
            for x in target_x..(target_x + target_w).min(width) {
                img.put_pixel(x, y, Luma([255]));
            }
        }

        let mut buffer = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut buffer);
        encoder
            .write_image(img.as_raw(), width, height, image::ExtendedColorType::L8)
            .unwrap();

        BASE64_STANDARD.encode(&buffer)
    }

    /// Helper to create a template image
    fn create_template(width: u32, height: u32, value: u8) -> String {
        let img: ImageBuffer<Luma<u8>, Vec<u8>> = ImageBuffer::from_fn(width, height, |_, _| Luma([value]));

        let mut buffer = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut buffer);
        encoder
            .write_image(img.as_raw(), width, height, image::ExtendedColorType::L8)
            .unwrap();

        BASE64_STANDARD.encode(&buffer)
    }

    #[test]
    fn test_template_larger_than_screenshot_returns_error() {
        // Large template (100x100), small screenshot (50x50)
        let screenshot = create_test_image(50, 50, [128, 128, 128]);
        let template = create_test_image(100, 100, [255, 255, 255]);

        let result = find_template_in_screenshot(&screenshot, &template, 1.0, 0.7);

        assert!(!result.found);
        assert!(result.error.is_some());
        assert!(result.error.unwrap().contains("larger than screenshot"));
    }

    #[test]
    fn test_center_coordinate_calculation() {
        // Create screenshot with white target region at (100, 100)
        let screenshot = create_screenshot_with_target(500, 500, 100, 100, 50, 50);

        // Create white template matching the target
        let template = create_template(50, 50, 255);

        let result = find_template_in_screenshot(&screenshot, &template, 1.0, 0.5);

        assert!(result.found);
        // Center should be approximately (100 + 25, 100 + 25) = (125, 125)
        assert!(result.center_x.is_some());
        assert!(result.center_y.is_some());

        let center_x = result.center_x.unwrap();
        let center_y = result.center_y.unwrap();

        // Allow some tolerance for matching algorithm variations
        assert!(
            (center_x - 125).abs() <= 5,
            "center_x {} should be close to 125",
            center_x
        );
        assert!(
            (center_y - 125).abs() <= 5,
            "center_y {} should be close to 125",
            center_y
        );
    }

    #[test]
    fn test_scale_factor_applied_to_template() {
        // Create 100x100 template
        let screenshot = create_test_image(500, 500, [128, 128, 128]);
        let template = create_test_image(100, 100, [255, 255, 255]);

        // Scale factor 0.5 should resize template to 50x50
        let result = find_template_in_screenshot(&screenshot, &template, 0.5, 0.1);

        // Template dimensions should be scaled
        assert_eq!(result.template_width, 50);
        assert_eq!(result.template_height, 50);
    }

    #[test]
    fn test_invalid_base64_returns_error() {
        let result = find_template_in_screenshot("not-valid-base64!!!", "also-invalid!!!", 1.0, 0.7);

        assert!(!result.found);
        assert!(result.error.is_some());
        assert!(result.error.unwrap().contains("decode"));
    }

    #[test]
    fn test_confidence_below_threshold_not_found() {
        // Create mismatched images (gray screenshot, white template in different area)
        let screenshot = create_test_image(200, 200, [50, 50, 50]);
        let template = create_test_image(30, 30, [255, 255, 255]);

        // High threshold that won't be met
        let result = find_template_in_screenshot(&screenshot, &template, 1.0, 0.99);

        assert!(!result.found);
        assert!(result.confidence.is_some());
        // Confidence should be low due to mismatch
        assert!(result.confidence.unwrap() < 0.99);
        // No error, just not found
        assert!(result.error.is_none());
    }
}
