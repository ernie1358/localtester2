//! Control commands for stop/clear operations

use crate::state::AppState;
use tauri::State;
use std::time::Duration;

/// Request stop of all operations
#[tauri::command]
pub fn request_stop(state: State<AppState>) {
    state.request_stop();
}

/// Clear stop request flag
#[tauri::command]
pub fn clear_stop(state: State<AppState>) {
    state.clear_stop();
}

/// Check if stop has been requested
#[tauri::command]
pub fn is_stop_requested(state: State<AppState>) -> bool {
    state.is_stop_requested()
}

/// Wait for specified duration (cancellable via stop request)
/// Returns true if completed, false if cancelled
#[tauri::command]
pub async fn wait(state: State<'_, AppState>, duration_ms: u64) -> Result<bool, String> {
    let check_interval = Duration::from_millis(100);
    let total_duration = Duration::from_millis(duration_ms);
    let mut elapsed = Duration::ZERO;

    while elapsed < total_duration {
        // Check for stop request
        if state.is_stop_requested() {
            return Ok(false);
        }

        // Sleep for check interval or remaining time, whichever is shorter
        let remaining = total_duration - elapsed;
        let sleep_time = check_interval.min(remaining);
        tokio::time::sleep(sleep_time).await;
        elapsed += sleep_time;
    }

    Ok(true)
}
