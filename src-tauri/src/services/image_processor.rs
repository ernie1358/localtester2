//! Image processing service for screenshot resizing and encoding

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use image::{DynamicImage, GenericImageView};
use serde::Serialize;
use std::io::Cursor;

use crate::error::XenotesterError;

/// Maximum long edge for API (increased for better text readability)
/// Note: Claude Vision API can handle larger images, prioritizing readability over cost
const MAX_LONG_EDGE: u32 = 1920;
/// Maximum total pixels (~2 megapixels for better text recognition)
const MAX_TOTAL_PIXELS: u32 = 2_000_000;

/// Result of image resize operation
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeResult {
    pub original_width: u32,
    pub original_height: u32,
    pub resized_width: u32,
    pub resized_height: u32,
    pub scale_factor: f64,
    pub image_base64: String,
}

/// Resize screenshot to fit API constraints
/// - Max long edge: 1920px (increased for better text readability)
/// - Max total pixels: ~2 megapixels
pub fn resize_screenshot(image: DynamicImage) -> Result<ResizeResult, XenotesterError> {
    let (original_width, original_height) = image.dimensions();

    let long_edge = original_width.max(original_height);
    let total_pixels = original_width * original_height;

    // Calculate scale factor from both constraints
    let long_edge_scale = MAX_LONG_EDGE as f64 / long_edge as f64;
    let total_pixels_scale = (MAX_TOTAL_PIXELS as f64 / total_pixels as f64).sqrt();

    // Use the smaller scale (more restrictive) and cap at 1.0 (don't upscale)
    let scale_factor = long_edge_scale.min(total_pixels_scale).min(1.0);

    let resized_width = (original_width as f64 * scale_factor).round() as u32;
    let resized_height = (original_height as f64 * scale_factor).round() as u32;

    // Resize if needed
    let final_image = if scale_factor < 1.0 {
        image.resize_exact(
            resized_width,
            resized_height,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        image
    };

    // Encode to PNG and base64
    let mut buffer = Vec::new();
    final_image
        .write_to(&mut Cursor::new(&mut buffer), image::ImageFormat::Png)
        .map_err(|e| XenotesterError::ImageError(e.to_string()))?;

    let image_base64 = BASE64_STANDARD.encode(&buffer);

    Ok(ResizeResult {
        original_width,
        original_height,
        resized_width,
        resized_height,
        scale_factor,
        image_base64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::RgbaImage;

    #[test]
    fn test_resize_large_image() {
        // Create a 2560x1440 test image
        let img = RgbaImage::new(2560, 1440);
        let dynamic = DynamicImage::ImageRgba8(img);

        let result = resize_screenshot(dynamic).unwrap();

        assert!(result.resized_width <= MAX_LONG_EDGE);
        assert!(result.resized_height <= MAX_LONG_EDGE);
        assert!(result.scale_factor <= 1.0);
    }

    #[test]
    fn test_resize_small_image() {
        // Create a small 800x600 test image
        let img = RgbaImage::new(800, 600);
        let dynamic = DynamicImage::ImageRgba8(img);

        let result = resize_screenshot(dynamic).unwrap();

        // Should not be resized
        assert_eq!(result.resized_width, 800);
        assert_eq!(result.resized_height, 600);
        assert!((result.scale_factor - 1.0).abs() < 0.001);
    }
}
