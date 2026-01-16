//! Permission management commands for macOS

use serde::Serialize;

#[cfg(target_os = "macos")]
use std::ffi::c_void;

/// Permission status for macOS
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatus {
    pub screen_recording: bool,
    pub accessibility: bool,
}

// macOS API bindings for permission checks
// Note: These APIs return Boolean (unsigned char in C), which we map to u8 for ABI safety
#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> u8;
    fn CGRequestScreenCaptureAccess() -> u8;
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> u8;
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
        // Use the official macOS API to request screen recording permission
        // This will show the system permission dialog if not already granted
        let granted = unsafe { CGRequestScreenCaptureAccess() } != 0;

        // If still not granted, open System Preferences to Screen Recording
        if !granted {
            let _ = std::process::Command::new("open")
                .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
                .spawn();
        }

        // Return current permission status
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
        use core_foundation::base::TCFType;
        use core_foundation::boolean::CFBoolean;
        use core_foundation::dictionary::CFDictionary;
        use core_foundation::string::CFString;

        // Create options dictionary with kAXTrustedCheckOptionPrompt = true
        // This will show the system permission dialog if not already granted
        let key = CFString::new("AXTrustedCheckOptionPrompt");
        let value = CFBoolean::true_value();
        let options = CFDictionary::from_CFType_pairs(&[(key, value)]);

        let granted =
            unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef() as *const _) } != 0;

        // If still not granted, also open System Preferences
        if !granted {
            let _ = std::process::Command::new("open")
                .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
                .spawn();
        }

        // Return current permission status
        check_accessibility()
    }

    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Check screen recording permission on macOS using CGPreflightScreenCaptureAccess
#[cfg(target_os = "macos")]
fn check_screen_recording() -> bool {
    // Use the official macOS API to check screen recording permission
    // This is more reliable than trying to capture and checking for errors
    // Returns u8 (0 = false, non-zero = true)
    unsafe { CGPreflightScreenCaptureAccess() != 0 }
}

/// Check accessibility permission on macOS using AXIsProcessTrusted
#[cfg(target_os = "macos")]
fn check_accessibility() -> bool {
    // Use the official macOS API to check accessibility permission
    // Returns u8 (0 = false, non-zero = true)
    unsafe { AXIsProcessTrusted() != 0 }
}
