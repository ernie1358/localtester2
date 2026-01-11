//! Input operation commands (mouse, keyboard)

use crate::services::keyboard;
use crate::services::mouse::{self, MouseButton, ScrollDirection};

/// Move mouse to absolute position
#[tauri::command]
pub fn mouse_move(x: i32, y: i32) -> Result<(), String> {
    mouse::move_mouse(x, y).map_err(|e| e.to_string())
}

/// Left click at position
#[tauri::command]
pub fn left_click(x: i32, y: i32) -> Result<(), String> {
    mouse::click(x, y, MouseButton::Left).map_err(|e| e.to_string())
}

/// Right click at position
#[tauri::command]
pub fn right_click(x: i32, y: i32) -> Result<(), String> {
    mouse::click(x, y, MouseButton::Right).map_err(|e| e.to_string())
}

/// Middle click at position
#[tauri::command]
pub fn middle_click(x: i32, y: i32) -> Result<(), String> {
    mouse::click(x, y, MouseButton::Middle).map_err(|e| e.to_string())
}

/// Double click at position
#[tauri::command]
pub fn double_click(x: i32, y: i32) -> Result<(), String> {
    mouse::double_click(x, y).map_err(|e| e.to_string())
}

/// Triple click at position
#[tauri::command]
pub fn triple_click(x: i32, y: i32) -> Result<(), String> {
    mouse::triple_click(x, y).map_err(|e| e.to_string())
}

/// Mouse down (press without release)
#[tauri::command]
pub fn left_mouse_down(x: i32, y: i32) -> Result<(), String> {
    mouse::mouse_down(x, y, MouseButton::Left).map_err(|e| e.to_string())
}

/// Mouse up (release)
#[tauri::command]
pub fn left_mouse_up(x: i32, y: i32) -> Result<(), String> {
    mouse::mouse_up(x, y, MouseButton::Left).map_err(|e| e.to_string())
}

/// Drag from start to end position
#[tauri::command]
pub fn left_click_drag(
    start_x: i32,
    start_y: i32,
    end_x: i32,
    end_y: i32,
) -> Result<(), String> {
    mouse::drag(start_x, start_y, end_x, end_y).map_err(|e| e.to_string())
}

/// Scroll at position
/// direction: "up", "down", "left", "right"
#[tauri::command]
pub fn scroll(x: i32, y: i32, direction: String, amount: i32) -> Result<(), String> {
    let dir = match direction.to_lowercase().as_str() {
        "up" => ScrollDirection::Up,
        "down" => ScrollDirection::Down,
        "left" => ScrollDirection::Left,
        "right" => ScrollDirection::Right,
        _ => return Err(format!("Invalid scroll direction: {}", direction)),
    };

    mouse::scroll(x, y, dir, amount).map_err(|e| e.to_string())
}

/// Type text
#[tauri::command]
pub fn type_text(text: String) -> Result<(), String> {
    keyboard::type_text(&text).map_err(|e| e.to_string())
}

/// Press key combination (e.g., "ctrl+s", "cmd+shift+p")
#[tauri::command]
pub fn key(keys: String) -> Result<(), String> {
    keyboard::key_combination(&keys).map_err(|e| e.to_string())
}

/// Hold key (press or release)
#[tauri::command]
pub fn hold_key(key_name: String, hold: bool) -> Result<(), String> {
    keyboard::hold_key(&key_name, hold).map_err(|e| e.to_string())
}
