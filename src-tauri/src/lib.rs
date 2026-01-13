//! Xenotester - AI Desktop Agent Core Engine
//!
//! This library provides the Rust backend for the Xenotester application,
//! including screen capture, input automation, and emergency stop functionality.

pub mod commands;
pub mod error;
pub mod services;
pub mod state;
pub mod utils;

use commands::{config, control, input, permission, screenshot, template_match};
use state::AppState;
use tauri_plugin_sql::{Migration, MigrationKind};
use utils::hotkey::register_emergency_stop;

/// Get SQLite migrations
fn get_migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create_scenarios_table",
            sql: include_str!("../migrations/001_create_scenarios.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "create_step_images_table",
            sql: include_str!("../migrations/002_create_step_images.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load environment variables from .env file
    dotenv::dotenv().ok();

    tauri::Builder::default()
        // Initialize plugins
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_oauth::init())
        // SQLite plugin with migrations
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:xenotester.db", get_migrations())
                .build(),
        )
        // Set up emergency stop hotkey
        .setup(|app| {
            // Register emergency stop hotkey (Shift+Escape)
            register_emergency_stop(app.handle().clone());

            Ok(())
        })
        // Manage application state
        .manage(AppState::new())
        // Register IPC command handlers
        .invoke_handler(tauri::generate_handler![
            // Permission commands
            permission::check_permissions,
            permission::request_screen_recording_permission,
            permission::request_accessibility_permission,
            // Screenshot commands
            screenshot::get_monitors,
            screenshot::capture_screen,
            screenshot::capture_monitor_by_id,
            // Input commands
            input::mouse_move,
            input::left_click,
            input::right_click,
            input::middle_click,
            input::double_click,
            input::triple_click,
            input::left_mouse_down,
            input::left_mouse_up,
            input::left_click_drag,
            input::scroll,
            input::type_text,
            input::key,
            input::hold_key,
            // Control commands
            control::request_stop,
            control::clear_stop,
            control::is_stop_requested,
            control::wait,
            // Config commands
            config::get_api_key,
            config::is_api_key_configured,
            config::get_supabase_config,
            // Template matching commands
            template_match::match_hint_images,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
