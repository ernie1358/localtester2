//! Configuration commands (API key retrieval)

use std::env;

/// Get API key by name
/// Supported keys: "anthropic", "gemini"
#[tauri::command]
pub fn get_api_key(key_name: String) -> Result<String, String> {
    let env_key = match key_name.to_lowercase().as_str() {
        "anthropic" => "ANTHROPIC_API_KEY",
        "gemini" => "GEMINI_API_KEY",
        _ => return Err(format!("Unknown key name: {}", key_name)),
    };

    env::var(env_key).map_err(|_| format!("{} is not set in environment", env_key))
}

/// Check if API key is configured
#[tauri::command]
pub fn is_api_key_configured(key_name: String) -> bool {
    let env_key = match key_name.to_lowercase().as_str() {
        "anthropic" => "ANTHROPIC_API_KEY",
        "gemini" => "GEMINI_API_KEY",
        _ => return false,
    };

    env::var(env_key).is_ok()
}
