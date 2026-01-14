//! Mouse operation service using enigo

use enigo::{Button, Coordinate, Direction, Enigo, Mouse, Settings};
use std::thread;
use std::time::Duration;

use crate::error::XenotesterError;

// Mouse timing constants
// On macOS, the window manager needs more time to register mouse position
// and update hover state before a click can be properly received
#[cfg(target_os = "macos")]
const MOUSE_MOVE_SETTLE_DELAY_MS: u64 = 200;
#[cfg(not(target_os = "macos"))]
const MOUSE_MOVE_SETTLE_DELAY_MS: u64 = 50;

// Post-action delay to ensure system processes the input
const POST_ACTION_DELAY_MS: u64 = 20;

// Delay between clicks for double/triple click
const MULTI_CLICK_INTERVAL_MS: u64 = 50;

// Delay for drag operations - consistent across platforms since drag
// involves multiple coordinated actions that require reliable timing
const DRAG_STEP_DELAY_MS: u64 = 50;

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

    // Wait for window manager to register mouse position
    thread::sleep(Duration::from_millis(MOUSE_MOVE_SETTLE_DELAY_MS));

    // Click
    enigo
        .button(button.into(), Direction::Click)
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    // Wait for system to process the click
    thread::sleep(Duration::from_millis(POST_ACTION_DELAY_MS));

    Ok(())
}

/// Double click at absolute position
pub fn double_click(x: i32, y: i32) -> Result<(), XenotesterError> {
    let mut enigo = create_enigo()?;

    // Move to position
    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    // Wait for window manager to register mouse position
    thread::sleep(Duration::from_millis(MOUSE_MOVE_SETTLE_DELAY_MS));

    // Double click - interval must be short enough to register as double click
    enigo
        .button(Button::Left, Direction::Click)
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    thread::sleep(Duration::from_millis(MULTI_CLICK_INTERVAL_MS));

    enigo
        .button(Button::Left, Direction::Click)
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    // Wait for system to process the clicks
    thread::sleep(Duration::from_millis(POST_ACTION_DELAY_MS));

    Ok(())
}

/// Triple click at absolute position
pub fn triple_click(x: i32, y: i32) -> Result<(), XenotesterError> {
    let mut enigo = create_enigo()?;

    // Move to position
    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    // Wait for window manager to register mouse position
    thread::sleep(Duration::from_millis(MOUSE_MOVE_SETTLE_DELAY_MS));

    // Triple click - interval must be short enough to register as triple click
    for _ in 0..3 {
        enigo
            .button(Button::Left, Direction::Click)
            .map_err(|e| XenotesterError::InputError(e.to_string()))?;
        thread::sleep(Duration::from_millis(MULTI_CLICK_INTERVAL_MS));
    }

    // Wait for system to process the clicks
    thread::sleep(Duration::from_millis(POST_ACTION_DELAY_MS));

    Ok(())
}

/// Mouse down at absolute position
pub fn mouse_down(x: i32, y: i32, button: MouseButton) -> Result<(), XenotesterError> {
    let mut enigo = create_enigo()?;

    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    // Wait for window manager to register mouse position
    thread::sleep(Duration::from_millis(MOUSE_MOVE_SETTLE_DELAY_MS));

    enigo
        .button(button.into(), Direction::Press)
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    // Wait for system to process the press
    thread::sleep(Duration::from_millis(POST_ACTION_DELAY_MS));

    Ok(())
}

/// Mouse up at absolute position
pub fn mouse_up(x: i32, y: i32, button: MouseButton) -> Result<(), XenotesterError> {
    let mut enigo = create_enigo()?;

    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    // Wait for window manager to register mouse position
    thread::sleep(Duration::from_millis(MOUSE_MOVE_SETTLE_DELAY_MS));

    enigo
        .button(button.into(), Direction::Release)
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    // Wait for system to process the release
    thread::sleep(Duration::from_millis(POST_ACTION_DELAY_MS));

    Ok(())
}

/// Drag from start position to end position
pub fn drag(start_x: i32, start_y: i32, end_x: i32, end_y: i32) -> Result<(), XenotesterError> {
    let mut enigo = create_enigo()?;

    // Move to start position
    enigo
        .move_mouse(start_x, start_y, Coordinate::Abs)
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    // Wait for position to settle (consistent timing for reliable drag)
    thread::sleep(Duration::from_millis(DRAG_STEP_DELAY_MS));

    // Press left button
    enigo
        .button(Button::Left, Direction::Press)
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    thread::sleep(Duration::from_millis(DRAG_STEP_DELAY_MS));

    // Move to end position
    enigo
        .move_mouse(end_x, end_y, Coordinate::Abs)
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    thread::sleep(Duration::from_millis(DRAG_STEP_DELAY_MS));

    // Release left button
    enigo
        .button(Button::Left, Direction::Release)
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    // Wait for system to process the drag completion
    thread::sleep(Duration::from_millis(POST_ACTION_DELAY_MS));

    Ok(())
}

/// Scroll at position
pub fn scroll(x: i32, y: i32, direction: ScrollDirection, amount: i32) -> Result<(), XenotesterError> {
    let mut enigo = create_enigo()?;

    // Move to position
    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    // Wait for window manager to register mouse position
    thread::sleep(Duration::from_millis(MOUSE_MOVE_SETTLE_DELAY_MS));

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
        .map_err(|e| XenotesterError::InputError(e.to_string()))?;

    // Wait for system to process the scroll
    thread::sleep(Duration::from_millis(POST_ACTION_DELAY_MS));

    Ok(())
}
