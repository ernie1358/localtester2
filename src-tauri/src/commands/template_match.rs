//! Template matching IPC commands
//!
//! Provides Tauri commands for matching hint images against screenshots.

use crate::services::template_matcher::{match_templates_batch, MatchResult};
use serde::{Deserialize, Serialize};

/// Input template image data
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateImage {
    /// Base64 encoded image data (original size)
    pub image_data: String,
    /// Original file name for identification
    pub file_name: String,
}

/// Result of matching a single hint image
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HintImageMatchResult {
    /// Index of the hint image in the input array
    pub index: usize,
    /// Original file name
    pub file_name: String,
    /// Match result with coordinates or error
    pub match_result: MatchResult,
}

/// Match multiple hint images against a screenshot
///
/// # Arguments
/// * `screenshot_base64` - Base64 encoded screenshot (already resized for API)
/// * `template_images` - Array of hint images to match
/// * `scale_factor` - Scale factor applied to screenshot (e.g., 0.6)
/// * `confidence_threshold` - Optional minimum confidence (default: 0.7)
///
/// # Returns
/// Array of match results, one per hint image. Each image is processed independently;
/// errors in one image don't affect others.
///
/// # Design Decision: Per-image Error Handling
/// Individual image decode/matching failures are captured in `MatchResult.error`
/// rather than failing the entire command. This ensures that one corrupted hint
/// image doesn't prevent coordinates from being detected for other valid images.
///
/// # Performance Optimization
/// Screenshot is decoded and converted to grayscale only once, then reused
/// for all template matches. This significantly reduces CPU/memory usage
/// when matching multiple hint images.
#[tauri::command]
pub fn match_hint_images(
    screenshot_base64: String,
    template_images: Vec<TemplateImage>,
    scale_factor: f64,
    confidence_threshold: Option<f32>,
) -> Vec<HintImageMatchResult> {
    let threshold = confidence_threshold.unwrap_or(0.7);

    // Create tuples for batch processing (image_data, file_name)
    // Note: Output index corresponds to input array order (0, 1, 2, ...)
    let templates: Vec<(&str, &str)> = template_images
        .iter()
        .map(|t| (t.image_data.as_str(), t.file_name.as_str()))
        .collect();

    // Process all templates with single screenshot decode
    let batch_results = match_templates_batch(
        &screenshot_base64,
        templates,
        scale_factor,
        threshold,
    );

    // Rebuild results with array index (matches input order)
    batch_results
        .into_iter()
        .enumerate()
        .map(|(index, (file_name, match_result))| HintImageMatchResult {
            index,
            file_name,
            match_result,
        })
        .collect()
}
