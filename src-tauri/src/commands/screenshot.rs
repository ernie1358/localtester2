//! Screenshot capture commands
//!
//! All commands that involve CPU-intensive operations (capture, image processing,
//! Base64 decode, file I/O) are async and use `spawn_blocking` to prevent UI blocking.

use crate::services::capture::{
    capture_monitor, capture_primary_monitor, list_monitors, CaptureResult, MonitorInfo,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use std::fs;
use std::path::Path;

/// Get list of all available monitors
/// This is a lightweight operation, no need for spawn_blocking
#[tauri::command]
pub fn get_monitors() -> Result<Vec<MonitorInfo>, String> {
    list_monitors().map_err(|e| e.to_string())
}

/// Capture screenshot from primary monitor (for Computer Use API)
/// Now async with spawn_blocking to prevent UI blocking during capture and image processing
#[tauri::command]
pub async fn capture_screen() -> Result<CaptureResult, String> {
    // Offload CPU-intensive capture and image processing to worker thread
    tauri::async_runtime::spawn_blocking(move || capture_primary_monitor().map_err(|e| e.to_string()))
        .await
        .map_err(|e| format!("Capture task failed: {}", e))?
}

/// Capture screenshot from specific monitor
/// Now async with spawn_blocking to prevent UI blocking
#[tauri::command]
pub async fn capture_monitor_by_id(monitor_id: u32) -> Result<CaptureResult, String> {
    tauri::async_runtime::spawn_blocking(move || capture_monitor(monitor_id).map_err(|e| e.to_string()))
        .await
        .map_err(|e| format!("Capture task failed: {}", e))?
}

/// Ensure a directory exists (create if needed)
/// Now async with spawn_blocking to prevent UI blocking during directory operations
#[tauri::command]
pub async fn ensure_directory(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Directory creation task failed: {}", e))?
}

/// Save base64-encoded image data to a file
/// Now async with spawn_blocking to prevent UI blocking during Base64 decode and file I/O
#[tauri::command]
pub async fn save_base64_image(base64_data: String, file_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let image_data = BASE64_STANDARD
            .decode(&base64_data)
            .map_err(|e| format!("Failed to decode base64: {}", e))?;

        // Ensure parent directory exists
        if let Some(parent) = Path::new(&file_path).parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
        }

        fs::write(&file_path, image_data).map_err(|e| format!("Failed to write file: {}", e))
    })
    .await
    .map_err(|e| format!("Save image task failed: {}", e))?
}
