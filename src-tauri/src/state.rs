//! Application state management

use global_hotkey::GlobalHotKeyManager;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Global application state shared across commands
#[derive(Clone)]
pub struct AppState {
    /// Flag to request stop of all operations
    pub stop_requested: Arc<AtomicBool>,
    /// Global hotkey manager - must be kept alive to maintain hotkey registration
    pub hotkey_manager: Arc<Mutex<Option<GlobalHotKeyManager>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            stop_requested: Arc::new(AtomicBool::new(false)),
            hotkey_manager: Arc::new(Mutex::new(None)),
        }
    }

    /// Set the hotkey manager (must be called during app initialization)
    pub fn set_hotkey_manager(&self, manager: GlobalHotKeyManager) {
        let mut guard = self.hotkey_manager.lock().unwrap();
        *guard = Some(manager);
    }

    /// Request stop of all operations
    pub fn request_stop(&self) {
        self.stop_requested.store(true, Ordering::SeqCst);
    }

    /// Clear the stop request flag
    pub fn clear_stop(&self) {
        self.stop_requested.store(false, Ordering::SeqCst);
    }

    /// Check if stop has been requested
    pub fn is_stop_requested(&self) -> bool {
        self.stop_requested.load(Ordering::SeqCst)
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
