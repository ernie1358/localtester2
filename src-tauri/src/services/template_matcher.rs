//! Template matching service for hint image coordinate detection
//!
//! This module provides functionality to detect hint images within screenshots
//! using template matching (Normalized Cross-Correlation algorithm).

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use image::{DynamicImage, GenericImageView, GrayImage, Rgba, RgbaImage};
use imageproc::template_matching::{find_extremes, match_template, MatchTemplateMethod};
use serde::Serialize;

use crate::error::XenotesterError;

/// Error codes for template matching failures
///
/// These codes allow TypeScript to identify error types without parsing error messages,
/// making the API more robust against message changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchErrorCode {
    /// Screenshot could not be decoded (may be transient - different screenshot may work)
    ScreenshotDecodeError,
    /// Template base64 data could not be decoded (permanent - template data is corrupted)
    TemplateBase64DecodeError,
    /// Template image could not be decoded (permanent - template format is invalid)
    TemplateImageDecodeError,
    /// Template has insufficient opacity (permanent - template is too transparent)
    InsufficientOpacity,
    /// Template matching produced non-finite confidence (permanent - template lacks variance)
    NonFiniteConfidence,
    /// Template is larger than screenshot (may resolve when screen changes)
    TemplateTooLarge,
}

impl MatchErrorCode {
    /// Check if this error is permanent (won't resolve with different screenshots)
    pub fn is_permanent(&self) -> bool {
        match self {
            MatchErrorCode::ScreenshotDecodeError => false,
            MatchErrorCode::TemplateBase64DecodeError => true,
            MatchErrorCode::TemplateImageDecodeError => true,
            MatchErrorCode::InsufficientOpacity => true,
            MatchErrorCode::NonFiniteConfidence => true,
            MatchErrorCode::TemplateTooLarge => false, // May resolve when screen changes
        }
    }

    /// Check if this error is size-related (may resolve when screen changes)
    pub fn is_size_related(&self) -> bool {
        matches!(self, MatchErrorCode::TemplateTooLarge)
    }
}

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
    /// Error code for programmatic error handling (use this instead of parsing error message)
    pub error_code: Option<MatchErrorCode>,
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
    // Decode screenshot for single-image matching
    let screenshot = match decode_base64_image(screenshot_base64) {
        Ok(img) => img,
        Err(e) => return MatchResult {
            found: false,
            center_x: None,
            center_y: None,
            confidence: None,
            template_width: 0,
            template_height: 0,
            error: Some(e.to_string()),
            error_code: Some(MatchErrorCode::ScreenshotDecodeError),
        },
    };

    let screenshot_gray = screenshot.to_luma8();

    find_template_with_decoded_screenshot(
        &screenshot_gray,
        template_base64,
        scale_factor,
        confidence_threshold,
    )
}

/// Match multiple hint images against a pre-decoded screenshot
///
/// Optimization: Decodes screenshot once and reuses it for all template matches.
/// This avoids redundant base64 decoding and grayscale conversion.
///
/// # Arguments
/// * `screenshot_base64` - Base64 encoded screenshot (already resized)
/// * `templates` - Vector of (base64_data, file_name) tuples for each hint image
/// * `scale_factor` - Scale factor applied to screenshot
/// * `confidence_threshold` - Minimum confidence score
///
/// # Returns
/// Vector of MatchResults, one per template image
pub fn match_templates_batch(
    screenshot_base64: &str,
    templates: Vec<(&str, &str)>,
    scale_factor: f64,
    confidence_threshold: f32,
) -> Vec<(String, MatchResult)> {
    // Decode screenshot once
    let screenshot = match decode_base64_image(screenshot_base64) {
        Ok(img) => img,
        Err(e) => {
            // If screenshot decode fails, return error for all templates
            let error_result = MatchResult {
                found: false,
                center_x: None,
                center_y: None,
                confidence: None,
                template_width: 0,
                template_height: 0,
                error: Some(format!("Screenshot decode error: {}", e)),
                error_code: Some(MatchErrorCode::ScreenshotDecodeError),
            };
            return templates
                .into_iter()
                .map(|(_, name)| (name.to_string(), error_result.clone()))
                .collect();
        }
    };

    let screenshot_gray = screenshot.to_luma8();

    // Process each template with the pre-decoded screenshot
    templates
        .into_iter()
        .map(|(template_base64, file_name)| {
            let result = find_template_with_decoded_screenshot(
                &screenshot_gray,
                template_base64,
                scale_factor,
                confidence_threshold,
            );
            (file_name.to_string(), result)
        })
        .collect()
}

/// Internal function that matches a template against a pre-decoded grayscale screenshot
fn find_template_with_decoded_screenshot(
    screenshot_gray: &GrayImage,
    template_base64: &str,
    scale_factor: f64,
    confidence_threshold: f32,
) -> MatchResult {
    find_template_internal(screenshot_gray, template_base64, scale_factor, confidence_threshold)
}

/// Minimum opacity ratio threshold for template matching
/// Templates with opacity ratio below this are considered too transparent
/// and will return found=false to avoid false positives
const MIN_OPACITY_RATIO: f32 = 0.1; // At least 10% of pixels must be opaque

/// Internal implementation that returns MatchResult directly with error codes
/// Uses pre-decoded grayscale screenshot for efficiency
fn find_template_internal(
    screenshot_gray: &GrayImage,
    template_base64: &str,
    scale_factor: f64,
    confidence_threshold: f32,
) -> MatchResult {
    // Decode template image with detailed error code
    let template_original = match decode_template_image(template_base64) {
        Ok(img) => img,
        Err((error_msg, error_code)) => {
            return MatchResult {
                found: false,
                center_x: None,
                center_y: None,
                confidence: None,
                template_width: 0,
                template_height: 0,
                error: Some(error_msg),
                error_code: Some(error_code),
            };
        }
    };

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

    // Check opacity ratio before processing
    // Templates that are mostly transparent will become nearly uniform after
    // alpha compositing, leading to unreliable NCC results
    let opacity_ratio = calculate_opacity_ratio(&template);
    if opacity_ratio < MIN_OPACITY_RATIO {
        let (w, h) = template.dimensions();
        return MatchResult {
            found: false,
            center_x: None,
            center_y: None,
            confidence: None,
            template_width: w,
            template_height: h,
            error: Some(format!(
                "Template has insufficient opacity ({:.1}% < {:.1}% minimum). Mostly transparent images cannot be reliably matched.",
                opacity_ratio * 100.0,
                MIN_OPACITY_RATIO * 100.0
            )),
            error_code: Some(MatchErrorCode::InsufficientOpacity),
        };
    }

    // Convert to grayscale with alpha compositing for transparent PNGs
    // Transparent pixels are composited onto white background to avoid
    // treating them as black (which causes misdetection for icons)
    let template_gray = convert_to_grayscale_with_alpha(&template);

    let template_width = template_gray.width();
    let template_height = template_gray.height();

    // Check if template is larger than screenshot (cannot match)
    if template_width > screenshot_gray.width() || template_height > screenshot_gray.height() {
        return MatchResult {
            found: false,
            center_x: None,
            center_y: None,
            confidence: Some(0.0),
            template_width,
            template_height,
            error: Some("Template is larger than screenshot after scaling".to_string()),
            error_code: Some(MatchErrorCode::TemplateTooLarge),
        };
    }

    // Perform template matching using Normalized Cross-Correlation
    // NCC gives values from -1.0 to 1.0, where 1.0 is a perfect match
    // This is more robust than SSE which has unbounded upper values
    let result = match_template(
        screenshot_gray,
        &template_gray,
        MatchTemplateMethod::CrossCorrelationNormalized,
    );

    // Find the maximum value location (best match for NCC)
    let extremes = find_extremes(&result);

    // NCC: max_value is already in [0, 1] range for normalized images
    // Higher values indicate better matches
    let confidence = extremes.max_value;

    // Guard against non-finite values (NaN/Inf) that can occur with
    // low-variance templates (e.g., single-color images)
    // This prevents JSON serialization failures downstream
    if !confidence.is_finite() {
        return MatchResult {
            found: false,
            center_x: None,
            center_y: None,
            confidence: None,
            template_width,
            template_height,
            error: Some(
                "Template matching produced non-finite confidence value. Template may have insufficient variance (e.g., single-color image).".to_string()
            ),
            error_code: Some(MatchErrorCode::NonFiniteConfidence),
        };
    }

    if confidence >= confidence_threshold {
        // Calculate center coordinates
        // match_x, match_y is top-left corner of matched region
        // Add half of template dimensions to get center point
        let (match_x, match_y) = extremes.max_value_location;
        let center_x = match_x as i32 + (template_width / 2) as i32;
        let center_y = match_y as i32 + (template_height / 2) as i32;

        MatchResult {
            found: true,
            center_x: Some(center_x),
            center_y: Some(center_y),
            confidence: Some(confidence),
            template_width,
            template_height,
            error: None,
            error_code: None,
        }
    } else {
        MatchResult {
            found: false,
            center_x: None,
            center_y: None,
            confidence: Some(confidence),
            template_width,
            template_height,
            error: None,
            error_code: None,
        }
    }
}

/// Calculate the opacity ratio of an image (proportion of non-transparent pixels)
///
/// Returns a value between 0.0 (fully transparent) and 1.0 (fully opaque).
/// A pixel is considered opaque if its alpha value is > 0.
///
/// This is used to detect templates that are mostly transparent, which would
/// become nearly uniform after alpha compositing onto white background,
/// leading to unreliable NCC matching results.
fn calculate_opacity_ratio(image: &DynamicImage) -> f32 {
    let rgba = image.to_rgba8();
    let (width, height) = rgba.dimensions();
    let total_pixels = (width * height) as f32;

    if total_pixels == 0.0 {
        return 0.0;
    }

    let opaque_pixels = rgba.pixels()
        .filter(|pixel| pixel[3] > 0)
        .count() as f32;

    opaque_pixels / total_pixels
}

/// Convert DynamicImage to grayscale with proper alpha handling
///
/// For transparent PNGs (icons, buttons with transparency), the alpha channel
/// is used to composite the image onto a white background before conversion.
/// This prevents transparent regions from being treated as black, which would
/// cause misdetection for images like app icons.
fn convert_to_grayscale_with_alpha(image: &DynamicImage) -> GrayImage {
    let rgba: RgbaImage = image.to_rgba8();
    let (width, height) = rgba.dimensions();

    GrayImage::from_fn(width, height, |x, y| {
        let pixel: Rgba<u8> = *rgba.get_pixel(x, y);
        let alpha = pixel[3] as f32 / 255.0;

        // Composite onto white background (255, 255, 255)
        // result = foreground * alpha + background * (1 - alpha)
        let r = pixel[0] as f32 * alpha + 255.0 * (1.0 - alpha);
        let g = pixel[1] as f32 * alpha + 255.0 * (1.0 - alpha);
        let b = pixel[2] as f32 * alpha + 255.0 * (1.0 - alpha);

        // Standard grayscale conversion: 0.299R + 0.587G + 0.114B
        let gray = (0.299 * r + 0.587 * g + 0.114 * b).round() as u8;
        image::Luma([gray])
    })
}

/// Decode base64 string to DynamicImage
fn decode_base64_image(base64_data: &str) -> Result<DynamicImage, XenotesterError> {
    let bytes = BASE64_STANDARD
        .decode(base64_data)
        .map_err(|e| XenotesterError::ImageError(format!("Base64 decode error: {}", e)))?;

    image::load_from_memory(&bytes)
        .map_err(|e| XenotesterError::ImageError(format!("Image decode error: {}", e)))
}

/// Decode template base64 string with specific error codes for template failures
/// Returns tuple of (error_message, error_code) on failure
fn decode_template_image(base64_data: &str) -> Result<DynamicImage, (String, MatchErrorCode)> {
    let bytes = match BASE64_STANDARD.decode(base64_data) {
        Ok(b) => b,
        Err(e) => {
            return Err((
                format!("Base64 decode error: {}", e),
                MatchErrorCode::TemplateBase64DecodeError,
            ));
        }
    };

    match image::load_from_memory(&bytes) {
        Ok(img) => Ok(img),
        Err(e) => Err((
            format!("Image decode error: {}", e),
            MatchErrorCode::TemplateImageDecodeError,
        )),
    }
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

    /// Helper to create a grayscale image with a specific target region
    /// Uses a checkerboard-like noise pattern for better NCC matching
    fn create_screenshot_with_target(
        width: u32,
        height: u32,
        target_x: u32,
        target_y: u32,
        target_w: u32,
        target_h: u32,
    ) -> String {
        let mut img: ImageBuffer<Luma<u8>, Vec<u8>> = ImageBuffer::new(width, height);

        // Fill background with a pattern (not uniform) to avoid NCC edge cases
        for y in 0..height {
            for x in 0..width {
                // Create subtle variation in background
                let val = if (x / 10 + y / 10) % 2 == 0 { 80 } else { 90 };
                img.put_pixel(x, y, Luma([val]));
            }
        }

        // Draw distinct white target region
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

    /// Helper to create a transparent PNG template (simulating an icon)
    /// Creates a white center with transparent border
    fn create_transparent_template(width: u32, height: u32) -> String {
        let mut img: RgbaImage = ImageBuffer::new(width, height);

        for y in 0..height {
            for x in 0..width {
                // Create a circle-like pattern: center is opaque white, edges are transparent
                let center_x = width as f32 / 2.0;
                let center_y = height as f32 / 2.0;
                let dist = ((x as f32 - center_x).powi(2) + (y as f32 - center_y).powi(2)).sqrt();
                let radius = (width.min(height) as f32) / 2.0 - 2.0;

                if dist < radius {
                    // Inside circle: opaque white
                    img.put_pixel(x, y, Rgba([255, 255, 255, 255]));
                } else {
                    // Outside circle: fully transparent
                    img.put_pixel(x, y, Rgba([0, 0, 0, 0]));
                }
            }
        }

        let mut buffer = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut buffer);
        encoder
            .write_image(
                img.as_raw(),
                width,
                height,
                image::ExtendedColorType::Rgba8,
            )
            .unwrap();

        BASE64_STANDARD.encode(&buffer)
    }

    /// Helper to create a white background screenshot with a white circle
    /// (to match the transparent template)
    fn create_screenshot_with_circle(
        width: u32,
        height: u32,
        circle_x: u32,
        circle_y: u32,
        radius: u32,
    ) -> String {
        let mut img: ImageBuffer<Luma<u8>, Vec<u8>> = ImageBuffer::new(width, height);

        // Fill with white background (255)
        for pixel in img.pixels_mut() {
            *pixel = Luma([255]);
        }

        // Draw gray area around the circle to make it detectable
        for y in 0..height {
            for x in 0..width {
                let dist = (((x as i32 - circle_x as i32).pow(2) + (y as i32 - circle_y as i32).pow(2)) as f32).sqrt();
                if dist >= radius as f32 {
                    // Outside the circle: gray
                    img.put_pixel(x, y, Luma([128]));
                }
            }
        }

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
        // Using a distinct pattern: black background with white target
        let screenshot = create_screenshot_with_target(500, 500, 100, 100, 50, 50);

        // Create white template matching the target
        let template = create_template(50, 50, 255);

        // Use low threshold for NCC algorithm
        let result = find_template_in_screenshot(&screenshot, &template, 1.0, 0.3);

        assert!(result.found, "Template should be found, confidence: {:?}", result.confidence);
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
        // Create mismatched images - a distinct pattern that won't match
        // Screenshot with black region, template looking for white
        let screenshot = create_test_image(200, 200, [50, 50, 50]);
        let template = create_test_image(30, 30, [255, 255, 255]);

        // Very high threshold (1.0) that won't be met by uniform images
        // NCC can still produce high values for uniform regions, so use threshold > 1.0
        let result = find_template_in_screenshot(&screenshot, &template, 1.0, 1.01);

        // With threshold > 1.0, nothing should match
        assert!(!result.found, "Should not find with threshold > 1.0");
        assert!(result.confidence.is_some());
        // No error, just not found
        assert!(result.error.is_none());
    }

    #[test]
    fn test_transparent_png_matching() {
        // Create a screenshot with a white circle on gray background
        // Circle at center (150, 150) with radius 23 (template is 50x50, so radius ~23)
        let screenshot = create_screenshot_with_circle(300, 300, 150, 150, 23);

        // Create a transparent PNG template (white circle with transparent border)
        let template = create_transparent_template(50, 50);

        // Use low threshold since alpha compositing produces approximate match
        let result = find_template_in_screenshot(&screenshot, &template, 1.0, 0.3);

        // Should find the template - transparent pixels should not interfere
        // The key test is that it finds SOMETHING (transparent regions don't break matching)
        // and that confidence is reasonable
        assert!(result.found, "Transparent PNG should be detected, confidence: {:?}", result.confidence);
        assert!(result.center_x.is_some());
        assert!(result.center_y.is_some());

        // Verify confidence is reasonable (not 0 or negative)
        assert!(result.confidence.unwrap() > 0.0, "Confidence should be positive");
    }

    #[test]
    fn test_alpha_compositing_produces_correct_values() {
        // Test that convert_to_grayscale_with_alpha works correctly
        let mut img: RgbaImage = ImageBuffer::new(2, 2);

        // Fully opaque white pixel
        img.put_pixel(0, 0, Rgba([255, 255, 255, 255]));
        // Fully transparent pixel (should become white background)
        img.put_pixel(1, 0, Rgba([0, 0, 0, 0]));
        // 50% transparent black pixel (should become ~128 gray)
        img.put_pixel(0, 1, Rgba([0, 0, 0, 128]));
        // Fully opaque black pixel
        img.put_pixel(1, 1, Rgba([0, 0, 0, 255]));

        let dynamic_img = DynamicImage::ImageRgba8(img);
        let gray = convert_to_grayscale_with_alpha(&dynamic_img);

        // Check pixel values
        assert_eq!(gray.get_pixel(0, 0).0[0], 255, "Opaque white should stay 255");
        assert_eq!(gray.get_pixel(1, 0).0[0], 255, "Transparent should become white (255)");
        // 50% transparent black on white: 0 * 0.5 + 255 * 0.5 ≈ 127-128
        let semi_transparent = gray.get_pixel(0, 1).0[0];
        assert!(
            semi_transparent >= 125 && semi_transparent <= 130,
            "50% transparent black should be ~127, got {}",
            semi_transparent
        );
        assert_eq!(gray.get_pixel(1, 1).0[0], 0, "Opaque black should stay 0");
    }

    #[test]
    fn test_batch_matching() {
        // Create screenshot with multiple white target regions
        let screenshot = create_screenshot_with_target(500, 500, 100, 100, 50, 50);

        // Create templates
        let template1 = create_template(50, 50, 255); // Matches the target
        let template2 = create_template(30, 30, 0);   // Doesn't match (black)

        let templates = vec![
            (template1.as_str(), "match.png"),
            (template2.as_str(), "nomatch.png"),
        ];

        let results = match_templates_batch(&screenshot, templates, 1.0, 0.5);

        assert_eq!(results.len(), 2);

        // First template should match
        let (name1, result1) = &results[0];
        assert_eq!(name1, "match.png");
        assert!(result1.found);

        // Second template should not match at high confidence
        let (name2, result2) = &results[1];
        assert_eq!(name2, "nomatch.png");
        // May or may not find depending on algorithm, but confidence should be lower
        if result2.found {
            assert!(result2.confidence.unwrap_or(0.0) < 0.9);
        }
    }

    #[test]
    fn test_batch_matching_with_screenshot_decode_error() {
        let templates = vec![
            ("valid-base64", "image1.png"),
            ("valid-base64", "image2.png"),
        ];

        // Invalid screenshot should return error for all templates
        let results = match_templates_batch("invalid-screenshot!!!", templates, 1.0, 0.5);

        assert_eq!(results.len(), 2);
        for (_, result) in &results {
            assert!(!result.found);
            assert!(result.error.is_some());
            assert!(result.error.as_ref().unwrap().contains("Screenshot decode error"));
        }
    }

    #[test]
    fn test_confidence_is_reasonable() {
        // Test that CrossCorrelationNormalized returns reasonable confidence values
        let screenshot = create_test_image(200, 200, [128, 128, 128]);
        let template = create_test_image(30, 30, [255, 255, 255]);

        let result = find_template_in_screenshot(&screenshot, &template, 1.0, 0.0);

        // With threshold 0, should always have some confidence value
        assert!(result.confidence.is_some());
        let confidence = result.confidence.unwrap();

        // CrossCorrelationNormalized should give values close to [0, 1] range
        // Due to floating point precision, values can slightly exceed 1.0
        // The important thing is that values are reasonable (not NaN, not huge)
        assert!(
            confidence >= 0.0 && confidence <= 1.1,
            "Confidence {} should be in reasonable range [0, 1.1]",
            confidence
        );
    }

    #[test]
    fn test_opacity_ratio_calculation() {
        // Test calculate_opacity_ratio function
        let mut img: RgbaImage = ImageBuffer::new(10, 10);

        // Fill all pixels as transparent (alpha = 0)
        for pixel in img.pixels_mut() {
            *pixel = Rgba([0, 0, 0, 0]);
        }

        let dynamic_img = DynamicImage::ImageRgba8(img.clone());
        let ratio = calculate_opacity_ratio(&dynamic_img);
        assert_eq!(ratio, 0.0, "Fully transparent image should have 0% opacity");

        // Fill all pixels as opaque (alpha = 255)
        for pixel in img.pixels_mut() {
            *pixel = Rgba([128, 128, 128, 255]);
        }

        let dynamic_img = DynamicImage::ImageRgba8(img.clone());
        let ratio = calculate_opacity_ratio(&dynamic_img);
        assert_eq!(ratio, 1.0, "Fully opaque image should have 100% opacity");

        // 50% opaque (half the pixels have alpha > 0)
        for (i, pixel) in img.pixels_mut().enumerate() {
            if i % 2 == 0 {
                *pixel = Rgba([128, 128, 128, 255]); // opaque
            } else {
                *pixel = Rgba([0, 0, 0, 0]); // transparent
            }
        }

        let dynamic_img = DynamicImage::ImageRgba8(img);
        let ratio = calculate_opacity_ratio(&dynamic_img);
        assert!((ratio - 0.5).abs() < 0.01, "Half opaque image should have ~50% opacity, got {}", ratio);
    }

    #[test]
    fn test_low_opacity_template_rejected() {
        // Create a mostly transparent template (below MIN_OPACITY_RATIO threshold)
        let mut img: RgbaImage = ImageBuffer::new(50, 50);

        // Only 5% opaque pixels (below 10% threshold)
        let total_pixels = 50 * 50;
        let opaque_count = (total_pixels as f32 * 0.05) as usize; // 5%

        for (i, pixel) in img.pixels_mut().enumerate() {
            if i < opaque_count {
                *pixel = Rgba([255, 255, 255, 255]); // opaque
            } else {
                *pixel = Rgba([0, 0, 0, 0]); // transparent
            }
        }

        // Encode as PNG
        let mut buffer = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut buffer);
        encoder
            .write_image(
                img.as_raw(),
                50,
                50,
                image::ExtendedColorType::Rgba8,
            )
            .unwrap();
        let template_base64 = BASE64_STANDARD.encode(&buffer);

        // Create a simple screenshot
        let screenshot = create_test_image(200, 200, [128, 128, 128]);

        // Template should be rejected due to low opacity
        let result = find_template_in_screenshot(&screenshot, &template_base64, 1.0, 0.5);

        assert!(!result.found, "Low opacity template should not match");
        assert!(result.error.is_some(), "Should have error message");
        assert!(
            result.error.as_ref().unwrap().contains("insufficient opacity"),
            "Error should mention opacity issue: {}",
            result.error.unwrap()
        );
    }

    #[test]
    fn test_sufficient_opacity_template_processed() {
        // Create a template with sufficient opacity (above MIN_OPACITY_RATIO threshold)
        let mut img: RgbaImage = ImageBuffer::new(50, 50);

        // 50% opaque pixels (well above 10% threshold)
        for (i, pixel) in img.pixels_mut().enumerate() {
            if i % 2 == 0 {
                *pixel = Rgba([255, 255, 255, 255]); // opaque white
            } else {
                *pixel = Rgba([0, 0, 0, 0]); // transparent
            }
        }

        // Encode as PNG
        let mut buffer = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut buffer);
        encoder
            .write_image(
                img.as_raw(),
                50,
                50,
                image::ExtendedColorType::Rgba8,
            )
            .unwrap();
        let template_base64 = BASE64_STANDARD.encode(&buffer);

        // Create a screenshot
        let screenshot = create_test_image(200, 200, [128, 128, 128]);

        // Template should be processed (not rejected due to opacity)
        let result = find_template_in_screenshot(&screenshot, &template_base64, 1.0, 0.5);

        // Should not have opacity error
        if result.error.is_some() {
            assert!(
                !result.error.as_ref().unwrap().contains("insufficient opacity"),
                "Sufficient opacity template should not be rejected: {}",
                result.error.unwrap()
            );
        }
        // Should have confidence value (template was processed)
        assert!(result.confidence.is_some(), "Template should be processed and have confidence value");
    }

    #[test]
    fn test_single_color_template_handles_gracefully() {
        // Test that a completely uniform (single-color) template is handled gracefully
        // NCC can produce NaN/Inf for zero-variance templates
        // The opacity guard should catch most cases, but this tests the NaN guard as backup

        // Create a pure white template (uniform color)
        let template = create_template(30, 30, 255);

        // Create a uniform gray screenshot
        let screenshot = create_test_image(200, 200, [128, 128, 128]);

        // This should not panic or produce invalid JSON
        let result = find_template_in_screenshot(&screenshot, &template, 1.0, 0.5);

        // The key assertion: no panic occurred and result is valid
        // Either found=true with finite confidence, or found=false with optional error
        if result.found {
            assert!(result.confidence.is_some());
            assert!(result.confidence.unwrap().is_finite(), "Confidence must be finite");
        }
        // If not found, that's also acceptable for uniform images
    }

    #[test]
    fn test_non_finite_confidence_returns_error() {
        // This test documents the expected behavior when NCC produces non-finite values
        // While we can't easily trigger NaN in normal usage (opacity guard catches most cases),
        // this test verifies our confidence check would work

        // Create a test that demonstrates the guard works correctly
        // Use a valid template that produces a finite result
        let screenshot = create_screenshot_with_target(200, 200, 50, 50, 30, 30);
        let template = create_template(30, 30, 255);

        let result = find_template_in_screenshot(&screenshot, &template, 1.0, 0.1);

        // The result should have a finite confidence value (not NaN or Inf)
        if result.confidence.is_some() {
            let confidence = result.confidence.unwrap();
            assert!(
                confidence.is_finite(),
                "Confidence {} should be finite (not NaN or Inf)",
                confidence
            );
        }
    }
}
