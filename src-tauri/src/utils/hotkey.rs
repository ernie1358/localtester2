//! Emergency stop hotkey handler

use global_hotkey::{
    hotkey::{Code, HotKey, Modifiers},
    GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState,
};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

/// Wrapper to hold GlobalHotKeyManager and make it thread-safe for static storage
/// This is necessary because GlobalHotKeyManager doesn't implement Send on Windows
#[allow(dead_code)] // Field is intentionally never read - we just keep the manager alive
struct HotkeyManagerHolder(GlobalHotKeyManager);

// Safety: The hotkey manager is only initialized once from the main thread
// and never accessed from other threads after initialization. It's kept alive
// for the lifetime of the application solely to maintain hotkey registration.
// The inner manager is never mutated or read after being set.
unsafe impl Send for HotkeyManagerHolder {}
unsafe impl Sync for HotkeyManagerHolder {}

/// Global storage for hotkey manager to keep it alive for the app lifetime
/// This is kept separate from AppState because GlobalHotKeyManager doesn't implement Send on Windows
static HOTKEY_MANAGER: OnceLock<HotkeyManagerHolder> = OnceLock::new();

/// Register emergency stop hotkey (Shift + Escape)
pub fn register_emergency_stop(app_handle: AppHandle) {
    let manager = match GlobalHotKeyManager::new() {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[Emergency Stop] Failed to create hotkey manager: {}", e);
            return;
        }
    };

    // Register Shift + Escape as emergency stop
    let hotkey = HotKey::new(Some(Modifiers::SHIFT), Code::Escape);
    if let Err(e) = manager.register(hotkey) {
        eprintln!("[Emergency Stop] Failed to register hotkey: {}", e);
        return;
    }

    // Store manager in global static to prevent it from being dropped
    // Note: GlobalHotKeyManager doesn't implement Send on Windows, so we can't put it in AppState
    let _ = HOTKEY_MANAGER.set(HotkeyManagerHolder(manager));

    // Start hotkey event listener thread
    let app_handle_clone = app_handle.clone();
    std::thread::spawn(move || {
        loop {
            if let Ok(event) = GlobalHotKeyEvent::receiver().recv() {
                if event.state == HotKeyState::Pressed {
                    // Set stop flag
                    let state = app_handle_clone.state::<AppState>();
                    state.request_stop();

                    // Emit event to frontend
                    if let Err(e) = app_handle_clone.emit("emergency-stop", ()) {
                        eprintln!("[Emergency Stop] Failed to emit event: {}", e);
                    }

                    println!("[Emergency Stop] Hotkey triggered, stop requested");
                }
            }
        }
    });

    println!("[Emergency Stop] Registered Shift+Escape as emergency stop");
}
