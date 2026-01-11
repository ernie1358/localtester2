//! Keyboard operation service using enigo

use enigo::{Direction, Enigo, Key, Keyboard, Settings};

use crate::error::XenotesterError;

/// Create a new Enigo instance
fn create_enigo() -> Result<Enigo, XenotesterError> {
    Enigo::new(&Settings::default()).map_err(|e| XenotesterError::InputError(e.to_string()))
}

/// Type text string
pub fn type_text(text: &str) -> Result<(), XenotesterError> {
    let mut enigo = create_enigo()?;
    enigo
        .text(text)
        .map_err(|e| XenotesterError::InputError(e.to_string()))
}

/// Press a key combination (e.g., "ctrl+s", "cmd+shift+p")
pub fn key_combination(key_str: &str) -> Result<(), XenotesterError> {
    let mut enigo = create_enigo()?;

    // Parse key parts into owned Strings to avoid borrow issues
    let parts: Vec<String> = key_str
        .split('+')
        .map(|s| s.trim().to_lowercase())
        .collect();

    let mut modifiers: Vec<Key> = Vec::new();
    let mut main_key: Option<Key> = None;

    for part in &parts {
        let key = parse_key(part)?;
        if is_modifier(part) {
            modifiers.push(key);
        } else {
            main_key = Some(key);
        }
    }

    // Press modifiers
    for modifier in &modifiers {
        enigo
            .key(*modifier, Direction::Press)
            .map_err(|e| XenotesterError::InputError(e.to_string()))?;
    }

    // Press and release main key
    if let Some(key) = main_key {
        enigo
            .key(key, Direction::Click)
            .map_err(|e| XenotesterError::InputError(e.to_string()))?;
    }

    // Release modifiers in reverse order
    for modifier in modifiers.iter().rev() {
        enigo
            .key(*modifier, Direction::Release)
            .map_err(|e| XenotesterError::InputError(e.to_string()))?;
    }

    Ok(())
}

/// Hold a key (press without release)
pub fn hold_key(key_str: &str, press: bool) -> Result<(), XenotesterError> {
    let mut enigo = create_enigo()?;
    let key = parse_key(key_str)?;

    let direction = if press {
        Direction::Press
    } else {
        Direction::Release
    };

    enigo
        .key(key, direction)
        .map_err(|e| XenotesterError::InputError(e.to_string()))
}

/// Check if a key string represents a modifier
fn is_modifier(key_str: &str) -> bool {
    matches!(
        key_str.to_lowercase().as_str(),
        "ctrl" | "control" | "alt" | "option" | "shift" | "cmd" | "command" | "meta" | "super" | "win"
    )
}

/// Parse a key string to enigo Key
fn parse_key(key_str: &str) -> Result<Key, XenotesterError> {
    let key = match key_str.to_lowercase().as_str() {
        // Modifiers
        "ctrl" | "control" => Key::Control,
        "alt" | "option" => Key::Alt,
        "shift" => Key::Shift,
        "cmd" | "command" | "meta" | "super" | "win" => Key::Meta,

        // Function keys
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,

        // Navigation keys
        "up" | "arrowup" => Key::UpArrow,
        "down" | "arrowdown" => Key::DownArrow,
        "left" | "arrowleft" => Key::LeftArrow,
        "right" | "arrowright" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" | "page_up" => Key::PageUp,
        "pagedown" | "page_down" => Key::PageDown,

        // Special keys
        "enter" | "return" => Key::Return,
        "tab" => Key::Tab,
        "space" => Key::Space,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "escape" | "esc" => Key::Escape,
        "capslock" | "caps_lock" => Key::CapsLock,

        // Single characters
        s if s.len() == 1 => {
            let c = s.chars().next().unwrap();
            Key::Unicode(c)
        }

        _ => {
            return Err(XenotesterError::InputError(format!(
                "Unknown key: {}",
                key_str
            )))
        }
    };

    Ok(key)
}
