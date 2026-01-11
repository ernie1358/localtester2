//! Screenshot capture commands

use crate::services::capture::{
    capture_monitor, capture_primary_monitor, list_monitors, CaptureResult, MonitorInfo,
};

/// Get list of all available monitors
#[tauri::command]
pub fn get_monitors() -> Result<Vec<MonitorInfo>, String> {
    list_monitors().map_err(|e| e.to_string())
}

/// Capture screenshot from primary monitor (for Computer Use API)
#[tauri::command]
pub fn capture_screen() -> Result<CaptureResult, String> {
    capture_primary_monitor().map_err(|e| e.to_string())
}

/// Capture screenshot from specific monitor
#[tauri::command]
pub fn capture_monitor_by_id(monitor_id: u32) -> Result<CaptureResult, String> {
    capture_monitor(monitor_id).map_err(|e| e.to_string())
}
