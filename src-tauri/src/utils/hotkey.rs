//! Emergency stop hotkey handler

use global_hotkey::{
    hotkey::{Code, HotKey, Modifiers},
    GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState,
};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

/// Flag to track if hotkey has already been registered (prevents duplicate registration)
static HOTKEY_REGISTERED: AtomicBool = AtomicBool::new(false);

/// Register emergency stop hotkey (Shift + Escape)
pub fn register_emergency_stop(app_handle: AppHandle) {
    // Guard: Early return if already registered to prevent duplicate hotkeys and listener threads
    if HOTKEY_REGISTERED.swap(true, Ordering::SeqCst) {
        println!("[Emergency Stop] Hotkey already registered, skipping");
        return;
    }

    let manager = match GlobalHotKeyManager::new() {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[Emergency Stop] Failed to create hotkey manager: {}", e);
            HOTKEY_REGISTERED.store(false, Ordering::SeqCst); // Reset flag on failure
            return;
        }
    };

    // Register Shift + Escape as emergency stop
    let hotkey = HotKey::new(Some(Modifiers::SHIFT), Code::Escape);
    if let Err(e) = manager.register(hotkey) {
        eprintln!("[Emergency Stop] Failed to register hotkey: {}", e);
        HOTKEY_REGISTERED.store(false, Ordering::SeqCst); // Reset flag on failure
        return;
    }

    // Leak the manager to keep it alive for the app lifetime without requiring Send/Sync
    // This is intentional: the manager needs to stay alive to maintain hotkey registration,
    // and GlobalHotKeyManager doesn't implement Send on Windows so we can't use OnceLock
    std::mem::forget(manager);

    // Start hotkey event listener thread
    let app_handle_clone = app_handle.clone();
    std::thread::spawn(move || {
        // Use while let to properly handle channel disconnection
        while let Ok(event) = GlobalHotKeyEvent::receiver().recv() {
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
        // Channel disconnected, thread will exit cleanly
        println!("[Emergency Stop] Event channel closed, listener thread exiting");
    });

    println!("[Emergency Stop] Registered Shift+Escape as emergency stop");
}
