//! Screen capture service using xcap

use image::DynamicImage;
use serde::Serialize;
use xcap::Monitor;

use crate::error::XenotesterError;
use crate::services::image_processor::{resize_screenshot, ResizeResult};

#[cfg(target_os = "macos")]
use core_graphics::display::CGDisplay;

/// Get the display scale factor for HiDPI/Retina displays on macOS
/// Returns 2.0 for Retina displays, 1.0 for standard displays
///
/// Note: Currently uses the main display's scale factor. For multi-monitor setups
/// with different scale factors, this may not be accurate for secondary monitors.
/// TODO: Consider passing monitor ID and querying per-monitor scale factor
#[cfg(target_os = "macos")]
fn get_display_scale_factor() -> f64 {
    // Get the main display's scale factor using Core Graphics
    let main_display = CGDisplay::main();
    let mode = main_display.display_mode();

    if let Some(mode) = mode {
        let pixel_width = mode.pixel_width() as f64;
        let logical_width = mode.width() as f64;
        if logical_width > 0.0 {
            return pixel_width / logical_width;
        }
    }

    // Fallback: assume standard display (1.0) if we can't determine
    // This is safer than assuming Retina (2.0) as it won't scale clicks incorrectly
    1.0
}

/// Get the display scale factor (non-macOS fallback)
#[cfg(not(target_os = "macos"))]
fn get_display_scale_factor() -> f64 {
    // On other platforms, assume 1.0 (no HiDPI)
    // This can be extended for Windows/Linux HiDPI support
    1.0
}

/// Monitor information for frontend display
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub id: u32,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
}

/// Capture result including metadata and image
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    pub original_width: u32,
    pub original_height: u32,
    pub resized_width: u32,
    pub resized_height: u32,
    pub scale_factor: f64,
    pub image_base64: String,
    pub monitor_id: u32,
    /// Display scale factor for HiDPI/Retina displays (e.g., 2.0 for Retina)
    /// This is the ratio of physical pixels to logical points
    pub display_scale_factor: f64,
}

/// Get list of all available monitors
pub fn list_monitors() -> Result<Vec<MonitorInfo>, XenotesterError> {
    let monitors = Monitor::all().map_err(|e| XenotesterError::CaptureError(e.to_string()))?;

    let mut result: Vec<MonitorInfo> = Vec::new();
    for (idx, m) in monitors.into_iter().enumerate() {
        result.push(MonitorInfo {
            id: idx as u32,
            name: m.name().unwrap_or_default(),
            x: m.x().unwrap_or(0),
            y: m.y().unwrap_or(0),
            width: m.width().unwrap_or(0),
            height: m.height().unwrap_or(0),
            is_primary: m.is_primary().unwrap_or(false),
        });
    }

    Ok(result)
}

/// Capture primary monitor (default for Computer Use API)
pub fn capture_primary_monitor() -> Result<CaptureResult, XenotesterError> {
    let monitors = Monitor::all().map_err(|e| XenotesterError::CaptureError(e.to_string()))?;

    // Find primary monitor or use first one
    let (monitor_id, monitor) = monitors
        .into_iter()
        .enumerate()
        .find(|(_, m)| m.is_primary().unwrap_or(false))
        .or_else(|| {
            Monitor::all()
                .ok()
                .and_then(|m| m.into_iter().enumerate().next())
        })
        .ok_or_else(|| XenotesterError::CaptureError("No monitors found".to_string()))?;

    capture_monitor_internal(monitor_id as u32, monitor)
}

/// Capture specific monitor by ID
pub fn capture_monitor(monitor_id: u32) -> Result<CaptureResult, XenotesterError> {
    let monitors = Monitor::all().map_err(|e| XenotesterError::CaptureError(e.to_string()))?;

    let monitor = monitors
        .into_iter()
        .nth(monitor_id as usize)
        .ok_or_else(|| {
            XenotesterError::CaptureError(format!("Monitor {} not found", monitor_id))
        })?;

    capture_monitor_internal(monitor_id, monitor)
}

/// Internal capture implementation
fn capture_monitor_internal(monitor_id: u32, monitor: Monitor) -> Result<CaptureResult, XenotesterError> {
    // Get the display scale factor before capture
    let display_scale_factor = get_display_scale_factor();

    // Capture the screen
    let image = monitor
        .capture_image()
        .map_err(|e| XenotesterError::CaptureError(e.to_string()))?;

    // Convert to DynamicImage
    let dynamic_image = DynamicImage::ImageRgba8(image);

    // Resize and encode
    let resize_result: ResizeResult = resize_screenshot(dynamic_image)?;

    Ok(CaptureResult {
        original_width: resize_result.original_width,
        original_height: resize_result.original_height,
        resized_width: resize_result.resized_width,
        resized_height: resize_result.resized_height,
        scale_factor: resize_result.scale_factor,
        image_base64: resize_result.image_base64,
        monitor_id,
        display_scale_factor,
    })
}
