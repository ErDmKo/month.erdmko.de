use std::error::Error;
use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatErrorKind {
    Validation,
    BadPayload,
    Internal,
}

#[derive(Debug, Clone)]
pub struct ChatError {
    kind: ChatErrorKind,
    code: &'static str,
    message: String,
    details: Option<String>,
}

pub type ChatResult<T> = Result<T, ChatError>;

impl ChatError {
    pub fn validation(message: impl Into<String>) -> Self {
        Self {
            kind: ChatErrorKind::Validation,
            code: "VALIDATION_ERROR",
            message: message.into(),
            details: None,
        }
    }

    pub fn bad_payload(message: impl Into<String>) -> Self {
        Self {
            kind: ChatErrorKind::BadPayload,
            code: "BAD_PAYLOAD",
            message: message.into(),
            details: None,
        }
    }

    pub fn internal(message: impl Into<String>, details: impl Into<String>) -> Self {
        Self {
            kind: ChatErrorKind::Internal,
            code: "INTERNAL_ERROR",
            message: message.into(),
            details: Some(details.into()),
        }
    }

    pub fn kind(&self) -> ChatErrorKind {
        self.kind
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn details(&self) -> Option<&str> {
        self.details.as_deref()
    }
}

impl Display for ChatError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        if let Some(details) = self.details() {
            write!(f, "{}: {} ({})", self.code, self.message, details)
        } else {
            write!(f, "{}: {}", self.code, self.message)
        }
    }
}

impl Error for ChatError {}
