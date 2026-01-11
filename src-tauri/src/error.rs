//! Custom error types for Xenotester

use serde::Serialize;
use thiserror::Error;

/// Application-level errors
#[derive(Error, Debug)]
pub enum XenotesterError {
    #[error("Screenshot capture failed: {0}")]
    CaptureError(String),

    #[error("Input operation failed: {0}")]
    InputError(String),

    #[error("Permission denied: {0}")]
    PermissionError(String),

    #[error("Configuration error: {0}")]
    ConfigError(String),

    #[error("Image processing error: {0}")]
    ImageError(String),

    #[error("Operation cancelled")]
    Cancelled,
}

/// Serializable error for IPC responses
#[derive(Debug, Serialize)]
pub struct IpcError {
    pub code: String,
    pub message: String,
}

impl From<XenotesterError> for IpcError {
    fn from(err: XenotesterError) -> Self {
        let code = match &err {
            XenotesterError::CaptureError(_) => "CAPTURE_ERROR",
            XenotesterError::InputError(_) => "INPUT_ERROR",
            XenotesterError::PermissionError(_) => "PERMISSION_ERROR",
            XenotesterError::ConfigError(_) => "CONFIG_ERROR",
            XenotesterError::ImageError(_) => "IMAGE_ERROR",
            XenotesterError::Cancelled => "CANCELLED",
        };
        IpcError {
            code: code.to_string(),
            message: err.to_string(),
        }
    }
}

impl From<XenotesterError> for String {
    fn from(err: XenotesterError) -> Self {
        err.to_string()
    }
}

impl From<std::io::Error> for XenotesterError {
    fn from(err: std::io::Error) -> Self {
        XenotesterError::CaptureError(err.to_string())
    }
}

impl From<image::ImageError> for XenotesterError {
    fn from(err: image::ImageError) -> Self {
        XenotesterError::ImageError(err.to_string())
    }
}
