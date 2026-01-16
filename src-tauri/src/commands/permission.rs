//! Permission management commands for macOS

use serde::Serialize;

/// Permission status for macOS
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatus {
    pub screen_recording: bool,
    pub accessibility: bool,
}

/// Check all required permissions (macOS only)
#[tauri::command]
pub fn check_permissions() -> PermissionStatus {
    #[cfg(target_os = "macos")]
    {
        PermissionStatus {
            screen_recording: check_screen_recording(),
            accessibility: check_accessibility(),
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        // On non-macOS platforms, assume permissions are granted
        PermissionStatus {
            screen_recording: true,
            accessibility: true,
        }
    }
}

/// Request screen recording permission (macOS only)
#[tauri::command]
pub fn request_screen_recording_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        // First try to capture to trigger the permission dialog (first-time only)
        use xcap::Monitor;
        if let Ok(monitors) = Monitor::all() {
            if let Some(monitor) = monitors.into_iter().next() {
                // Attempting to capture will trigger the permission prompt if not granted
                let _ = monitor.capture_image();
            }
        }

        // If still not granted, open System Preferences to Screen Recording
        if !check_screen_recording() {
            let _ = std::process::Command::new("open")
                .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
                .spawn();
        }

        // Check if permission was granted
        check_screen_recording()
    }

    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Request accessibility permission (macOS only)
#[tauri::command]
pub fn request_accessibility_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        // Opening System Preferences to Accessibility
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn();

        // Check current status
        check_accessibility()
    }

    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Check screen recording permission on macOS
#[cfg(target_os = "macos")]
fn check_screen_recording() -> bool {
    use xcap::Monitor;
    // Try to get monitors and capture - if it works, we have permission
    if let Ok(monitors) = Monitor::all() {
        if let Some(monitor) = monitors.into_iter().next() {
            return monitor.capture_image().is_ok();
        }
    }
    false
}

/// Check accessibility permission on macOS using AXIsProcessTrusted
#[cfg(target_os = "macos")]
fn check_accessibility() -> bool {
    // Use enigo to check if we can simulate input
    use enigo::{Enigo, Settings};
    Enigo::new(&Settings::default()).is_ok()
}
