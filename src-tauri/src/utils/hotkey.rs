//! Emergency stop hotkey handler

use global_hotkey::{
    hotkey::{Code, HotKey, Modifiers},
    GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState,
};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

/// Flag to track if hotkey has already been registered (prevents duplicate registration)
static HOTKEY_REGISTERED: AtomicBool = AtomicBool::new(false);
/// Stored hotkey ID for filtering events (only respond to our hotkey)
static HOTKEY_ID: AtomicU32 = AtomicU32::new(0);

/// Register emergency stop hotkey (Shift + Escape)
pub fn register_emergency_stop(app_handle: AppHandle) {
    // Guard: Use compare_exchange to atomically check and set, preventing race conditions
    // Only proceeds if the flag was false, and atomically sets it to true
    if HOTKEY_REGISTERED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
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
    let hotkey_id = hotkey.id(); // Get the hotkey ID for event filtering

    if let Err(e) = manager.register(hotkey) {
        eprintln!("[Emergency Stop] Failed to register hotkey: {}", e);
        HOTKEY_REGISTERED.store(false, Ordering::SeqCst); // Reset flag on failure
        return;
    }

    // Store the hotkey ID for event filtering
    HOTKEY_ID.store(hotkey_id, Ordering::SeqCst);

    // Leak the manager to keep it alive for the app lifetime without requiring Send/Sync
    // This is intentional: the manager needs to stay alive to maintain hotkey registration,
    // and GlobalHotKeyManager doesn't implement Send on Windows so we can't use OnceLock
    std::mem::forget(manager);

    // Start hotkey event listener thread
    let app_handle_clone = app_handle.clone();
    std::thread::spawn(move || {
        let expected_id = HOTKEY_ID.load(Ordering::SeqCst);

        // Use while let to properly handle channel disconnection
        while let Ok(event) = GlobalHotKeyEvent::receiver().recv() {
            // Filter by hotkey ID to only respond to our registered hotkey
            if event.id == expected_id && event.state == HotKeyState::Pressed {
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
