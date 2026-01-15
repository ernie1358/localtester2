//! Input operation commands (mouse, keyboard)
//!
//! All input commands are async and use `spawn_blocking` to prevent UI blocking.
//! Mouse operations include intentional delays (thread::sleep) for reliable input,
//! which would block the Tauri main thread if run synchronously.

use crate::services::keyboard;
use crate::services::mouse::{self, MouseButton, ScrollDirection};

/// Move mouse to absolute position
#[tauri::command]
pub async fn mouse_move(x: i32, y: i32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        mouse::move_mouse(x, y).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Input task failed: {}", e))?
}

/// Left click at position
#[tauri::command]
pub async fn left_click(x: i32, y: i32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        mouse::click(x, y, MouseButton::Left).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Input task failed: {}", e))?
}

/// Right click at position
#[tauri::command]
pub async fn right_click(x: i32, y: i32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        mouse::click(x, y, MouseButton::Right).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Input task failed: {}", e))?
}

/// Middle click at position
#[tauri::command]
pub async fn middle_click(x: i32, y: i32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        mouse::click(x, y, MouseButton::Middle).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Input task failed: {}", e))?
}

/// Double click at position
#[tauri::command]
pub async fn double_click(x: i32, y: i32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        mouse::double_click(x, y).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Input task failed: {}", e))?
}

/// Triple click at position
#[tauri::command]
pub async fn triple_click(x: i32, y: i32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        mouse::triple_click(x, y).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Input task failed: {}", e))?
}

/// Mouse down (press without release)
#[tauri::command]
pub async fn left_mouse_down(x: i32, y: i32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        mouse::mouse_down(x, y, MouseButton::Left).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Input task failed: {}", e))?
}

/// Mouse up (release)
#[tauri::command]
pub async fn left_mouse_up(x: i32, y: i32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        mouse::mouse_up(x, y, MouseButton::Left).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Input task failed: {}", e))?
}

/// Drag from start to end position
#[tauri::command]
pub async fn left_click_drag(
    start_x: i32,
    start_y: i32,
    end_x: i32,
    end_y: i32,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        mouse::drag(start_x, start_y, end_x, end_y).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Input task failed: {}", e))?
}

/// Scroll at position
/// direction: "up", "down", "left", "right"
#[tauri::command]
pub async fn scroll(x: i32, y: i32, direction: String, amount: i32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = match direction.to_lowercase().as_str() {
            "up" => ScrollDirection::Up,
            "down" => ScrollDirection::Down,
            "left" => ScrollDirection::Left,
            "right" => ScrollDirection::Right,
            _ => return Err(format!("Invalid scroll direction: {}", direction)),
        };

        mouse::scroll(x, y, dir, amount).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Input task failed: {}", e))?
}

/// Type text
#[tauri::command]
pub async fn type_text(text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        keyboard::type_text(&text).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Input task failed: {}", e))?
}

/// Press key combination (e.g., "ctrl+s", "cmd+shift+p")
#[tauri::command]
pub async fn key(keys: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        keyboard::key_combination(&keys).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Input task failed: {}", e))?
}

/// Hold key (press or release)
#[tauri::command]
pub async fn hold_key(key_name: String, hold: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        keyboard::hold_key(&key_name, hold).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Input task failed: {}", e))?
}
