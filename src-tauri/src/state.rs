//! Application state management

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Global application state shared across commands
#[derive(Clone)]
pub struct AppState {
    /// Flag to request stop of all operations
    pub stop_requested: Arc<AtomicBool>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            stop_requested: Arc::new(AtomicBool::new(false)),
        }
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
