//! Webhook commands for sending HTTP notifications
//!
//! This module handles sending webhook notifications from the Rust backend
//! to avoid CORS restrictions that would occur in the frontend.

use serde::{Deserialize, Serialize};
use url::Url;

/// Webhook payload structure
#[derive(Debug, Serialize, Deserialize)]
pub struct WebhookPayload {
    pub event: String,
    pub timestamp: String,
    pub scenario: ScenarioInfo,
    pub error: ErrorInfo,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ScenarioInfo {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorInfo {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_at_action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_successful_action: Option<String>,
    pub completed_actions: i32,
}

/// Send a POST request to the specified webhook URL
/// Returns silently on error to avoid interrupting test execution
#[tauri::command]
pub async fn send_webhook(url: String, payload: WebhookPayload) -> Result<bool, String> {
    // Validate URL format
    if url.trim().is_empty() {
        return Ok(false);
    }

    let parsed_url = match Url::parse(&url) {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[Webhook] Invalid URL: {}", e);
            return Ok(false);
        }
    };

    // Only allow http/https schemes
    if parsed_url.scheme() != "http" && parsed_url.scheme() != "https" {
        eprintln!("[Webhook] Invalid URL scheme: {}", parsed_url.scheme());
        return Ok(false);
    }

    let client = reqwest::Client::new();
    match client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&payload)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    {
        Ok(response) => {
            if response.status().is_success() {
                Ok(true)
            } else {
                eprintln!(
                    "[Webhook] Request failed: {} {}",
                    response.status().as_u16(),
                    response.status().canonical_reason().unwrap_or("Unknown")
                );
                Ok(false)
            }
        }
        Err(e) => {
            eprintln!("[Webhook] Request error: {}", e);
            Ok(false)
        }
    }
}
