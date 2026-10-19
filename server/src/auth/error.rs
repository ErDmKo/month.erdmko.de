use std::error::Error;
use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthErrorKind {
    Validation,
    Unauthorized,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthError {
    kind: AuthErrorKind,
    code: &'static str,
    message: String,
    details: Option<String>,
}

pub type AuthResult<T> = Result<T, AuthError>;

impl AuthError {
    pub fn validation(message: impl Into<String>) -> Self {
        Self {
            kind: AuthErrorKind::Validation,
            code: "AUTH_VALIDATION_ERROR",
            message: message.into(),
            details: None,
        }
    }

    pub fn unauthorized(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind: AuthErrorKind::Unauthorized,
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn internal(message: impl Into<String>, details: impl Into<String>) -> Self {
        Self {
            kind: AuthErrorKind::Internal,
            code: "INTERNAL_ERROR",
            message: message.into(),
            details: Some(details.into()),
        }
    }

    pub fn kind(&self) -> AuthErrorKind {
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

impl Display for AuthError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        if let Some(details) = self.details() {
            write!(f, "{}: {} ({})", self.code, self.message, details)
        } else {
            write!(f, "{}: {}", self.code, self.message)
        }
    }
}

impl Error for AuthError {}
