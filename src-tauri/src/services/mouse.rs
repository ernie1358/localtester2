//! Mouse operation service using enigo

use enigo::{Button, Coordinate, Direction, Enigo, Mouse, Settings};
use std::thread;
use std::time::Duration;

use crate::error::XenotesterError;

/// Mouse button types
#[derive(Debug, Clone, Copy)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

impl From<MouseButton> for Button {
    fn from(button: MouseButton) -> Self {
        match button {
            MouseButton::Left => Button::Left,
            MouseButton::Right => Button::Right,
            MouseButton::Middle => Button::Middle,
        }
    }
}

/// Scroll direction
#[derive(Debug, Clone, Copy)]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

/// Create a new Enigo instance
fn create_enigo() -> Result<Enigo, XenotesterError> {
    Enigo::new(&Settings::default()).map_err(|e| XenotesterError::InputError(e.to_string()))
}

/// Move mouse to absolute position
pub fn move_mouse(x: i32, y: i32) -> Result<(), XenotesterError> {
    let mut enigo = create_enigo()?;
    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| XenotesterError::InputError(e.to_string()))
}

/// Click at absolute position
pub fn click(x: i32, y: i32, button: MouseButton) -> Result<(), XenotesterError> {
    let mut enigo = create_enigo()?;

    // Move to position
    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    // Small delay for position to settle
    thread::sleep(Duration::from_millis(10));

    // Click
    enigo
        .button(button.into(), Direction::Click)
        .map_err(|e| XenotesterError::InputError(e.to_string()))
}

/// Double click at absolute position
pub fn double_click(x: i32, y: i32) -> Result<(), XenotesterError> {
    let mut enigo = create_enigo()?;

    // Move to position
    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    thread::sleep(Duration::from_millis(10));

    // Double click
    enigo
        .button(Button::Left, Direction::Click)
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    thread::sleep(Duration::from_millis(50));

    enigo
        .button(Button::Left, Direction::Click)
        .map_err(|e| XenotesterError::InputError(e.to_string()))
}

/// Triple click at absolute position
pub fn triple_click(x: i32, y: i32) -> Result<(), XenotesterError> {
    let mut enigo = create_enigo()?;

    // Move to position
    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    thread::sleep(Duration::from_millis(10));

    // Triple click
    for _ in 0..3 {
        enigo
            .button(Button::Left, Direction::Click)
            .map_err(|e| XenotesterError::InputError(e.to_string()))?;
        thread::sleep(Duration::from_millis(50));
    }

    Ok(())
}

/// Mouse down at absolute position
pub fn mouse_down(x: i32, y: i32, button: MouseButton) -> Result<(), XenotesterError> {
    let mut enigo = create_enigo()?;

    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    thread::sleep(Duration::from_millis(10));

    enigo
        .button(button.into(), Direction::Press)
        .map_err(|e| XenotesterError::InputError(e.to_string()))
}

/// Mouse up at absolute position
pub fn mouse_up(x: i32, y: i32, button: MouseButton) -> Result<(), XenotesterError> {
    let mut enigo = create_enigo()?;

    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    thread::sleep(Duration::from_millis(10));

    enigo
        .button(button.into(), Direction::Release)
        .map_err(|e| XenotesterError::InputError(e.to_string()))
}

/// Drag from start position to end position
pub fn drag(start_x: i32, start_y: i32, end_x: i32, end_y: i32) -> Result<(), XenotesterError> {
    let mut enigo = create_enigo()?;

    // Move to start position
    enigo
        .move_mouse(start_x, start_y, Coordinate::Abs)
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    thread::sleep(Duration::from_millis(50));

    // Press left button
    enigo
        .button(Button::Left, Direction::Press)
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    thread::sleep(Duration::from_millis(50));

    // Move to end position
    enigo
        .move_mouse(end_x, end_y, Coordinate::Abs)
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    thread::sleep(Duration::from_millis(50));

    // Release left button
    enigo
        .button(Button::Left, Direction::Release)
        .map_err(|e| XenotesterError::InputError(e.to_string()))
}

/// Scroll at position
pub fn scroll(x: i32, y: i32, direction: ScrollDirection, amount: i32) -> Result<(), XenotesterError> {
    let mut enigo = create_enigo()?;

    // Move to position
    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    thread::sleep(Duration::from_millis(10));

    // Scroll
    let (dx, dy) = match direction {
        ScrollDirection::Up => (0, -amount),
        ScrollDirection::Down => (0, amount),
        ScrollDirection::Left => (-amount, 0),
        ScrollDirection::Right => (amount, 0),
    };

    enigo
        .scroll(dx, enigo::Axis::Horizontal)
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    enigo
        .scroll(dy, enigo::Axis::Vertical)
        .map_err(|e| XenotesterError::InputError(e.to_string()))
}
