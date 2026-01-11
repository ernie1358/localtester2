//! Emergency stop hotkey handler

use global_hotkey::{
    hotkey::{Code, HotKey, Modifiers},
    GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState,
};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

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

    // Store manager in app state to prevent it from being dropped
    let state = app_handle.state::<AppState>();
    state.set_hotkey_manager(manager);

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
