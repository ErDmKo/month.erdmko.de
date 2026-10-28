use serde::{Deserialize, Serialize};
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use super::error::{AuthError, AuthResult};
use super::service::{normalize_tx_hash, normalize_wallet_address};
use super::{DEFAULT_ACCESS_DURATION_SECS, RECIPIENT_WALLET_ADDRESS};

pub const DEFAULT_ETH_RPC_URL: &str = "https://ethereum-rpc.publicnode.com";
/// Default minimum transfer: 0.001 ETH (10^15 wei).
pub const DEFAULT_MIN_PAYMENT_WEI: u128 = 1_000_000_000_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaymentConfig {
    pub rpc_url: String,
    pub recipient_address: String,
    pub min_payment_wei: u128,
    pub access_duration_secs: i64,
}

impl Default for PaymentConfig {
    fn default() -> Self {
        Self {
            rpc_url: DEFAULT_ETH_RPC_URL.to_string(),
            recipient_address: RECIPIENT_WALLET_ADDRESS.to_string(),
            min_payment_wei: DEFAULT_MIN_PAYMENT_WEI,
            access_duration_secs: DEFAULT_ACCESS_DURATION_SECS,
        }
    }
}

impl PaymentConfig {
    pub fn from_env() -> Self {
        let rpc_url = std::env::var("ETH_RPC_URL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_ETH_RPC_URL.to_string());

        let recipient_address = std::env::var("PAYMENT_RECIPIENT_ADDRESS")
            .ok()
            .and_then(|raw| normalize_wallet_address(&raw).ok())
            .unwrap_or_else(|| RECIPIENT_WALLET_ADDRESS.to_string());

        let min_payment_wei = std::env::var("MIN_PAYMENT_WEI")
            .ok()
            .and_then(|raw| {
                let trimmed = raw.trim();
                if trimmed.starts_with("0x") || trimmed.starts_with("0X") {
                    parse_hex_wei(trimmed).ok()
                } else {
                    trimmed.parse::<u128>().ok()
                }
            })
            .unwrap_or(DEFAULT_MIN_PAYMENT_WEI);

        let access_duration_secs = std::env::var("ACCESS_DURATION_SECS")
            .ok()
            .and_then(|raw| raw.trim().parse::<i64>().ok())
            .filter(|&d| d > 0)
            .unwrap_or(DEFAULT_ACCESS_DURATION_SECS);

        Self {
            rpc_url,
            recipient_address,
            min_payment_wei,
            access_duration_secs,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RpcTransaction {
    pub hash: Option<String>,
    pub from: String,
    pub to: Option<String>,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RpcTransactionReceipt {
    pub status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerifiedPayment {
    pub tx_hash: String,
    pub from_wallet: String,
    pub to_wallet: String,
    pub amount_wei: u128,
    pub access_duration_secs: i64,
}

/// Parse a `0x`-prefixed hexadecimal quantity (such as `tx.value` or `receipt.status`) into `u128`.
pub fn parse_hex_wei(raw: &str) -> AuthResult<u128> {
    let trimmed = raw.trim();
    let hex_digits = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .ok_or_else(|| AuthError::validation("hex quantity must start with 0x"))?;

    if hex_digits.is_empty() {
        return Err(AuthError::validation("hex quantity cannot be empty"));
    }
    let stripped = hex_digits.trim_start_matches('0');
    if stripped.is_empty() {
        return Ok(0);
    }
    u128::from_str_radix(stripped, 16)
        .map_err(|_| AuthError::validation("invalid hex quantity or overflow"))
}

/// Validate RPC transaction + receipt data against the expected sender, configured recipient,
/// minimum payment amount in wei, and confirmed `0x1` receipt status.
pub fn validate_rpc_payment(
    raw_tx_hash: &str,
    expected_sender_wallet: &str,
    config: &PaymentConfig,
    tx: Option<&RpcTransaction>,
    receipt: Option<&RpcTransactionReceipt>,
) -> AuthResult<VerifiedPayment> {
    let tx_hash = normalize_tx_hash(raw_tx_hash)?;
    let expected_sender = normalize_wallet_address(expected_sender_wallet)?;
    let expected_recipient = normalize_wallet_address(&config.recipient_address)?;

    let Some(tx) = tx else {
        return Err(AuthError::validation(
            "Payment transaction was not found on the network.",
        ));
    };

    let Some(receipt) = receipt else {
        return Err(AuthError::validation(
            "Payment transaction is still pending confirmation.",
        ));
    };

    let status_raw = receipt.status.as_deref().unwrap_or("0x0");
    let status_val = parse_hex_wei(status_raw)?;
    if status_val != 1 {
        return Err(AuthError::validation(
            "Payment transaction failed or reverted onchain.",
        ));
    }

    let Some(raw_to) = tx.to.as_deref() else {
        return Err(AuthError::validation(
            "Payment transaction has no recipient address.",
        ));
    };
    let to_wallet = normalize_wallet_address(raw_to)?;
    if to_wallet != expected_recipient {
        return Err(AuthError::validation(
            "Transaction recipient does not match the project payment wallet.",
        ));
    }

    let from_wallet = normalize_wallet_address(&tx.from)?;
    if from_wallet != expected_sender {
        return Err(AuthError::unauthorized(
            "PAYMENT_SENDER_MISMATCH",
            "Transaction sender does not match the authenticated wallet.",
        ));
    }

    let amount_wei = parse_hex_wei(&tx.value)?;
    if amount_wei < config.min_payment_wei {
        return Err(AuthError::validation(
            "Transaction value is below the minimum required payment.",
        ));
    }

    Ok(VerifiedPayment {
        tx_hash,
        from_wallet,
        to_wallet,
        amount_wei,
        access_duration_secs: config.access_duration_secs,
    })
}

pub trait PaymentVerifier: Send + Sync {
    fn verify_payment<'a>(
        &'a self,
        tx_hash: &'a str,
        expected_sender_wallet: &'a str,
    ) -> Pin<Box<dyn Future<Output = AuthResult<VerifiedPayment>> + 'a>>;
}

#[derive(Debug, Clone)]
pub struct RpcPaymentVerifier {
    pub config: PaymentConfig,
}

impl RpcPaymentVerifier {
    pub fn new(config: PaymentConfig) -> Self {
        Self { config }
    }

    pub fn from_env() -> Self {
        Self::new(PaymentConfig::from_env())
    }
}

#[derive(Serialize)]
struct JsonRpcRequest<'a> {
    jsonrpc: &'static str,
    id: u64,
    method: &'static str,
    params: [&'a str; 1],
}

#[derive(Deserialize)]
struct JsonRpcResponse {
    id: u64,
    result: Option<serde_json::Value>,
    error: Option<serde_json::Value>,
}

impl PaymentVerifier for RpcPaymentVerifier {
    fn verify_payment<'a>(
        &'a self,
        raw_tx_hash: &'a str,
        expected_sender_wallet: &'a str,
    ) -> Pin<Box<dyn Future<Output = AuthResult<VerifiedPayment>> + 'a>> {
        Box::pin(async move {
            let tx_hash = normalize_tx_hash(raw_tx_hash)?;
            let expected_sender = normalize_wallet_address(expected_sender_wallet)?;

            let batch_payload = [
                JsonRpcRequest {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "eth_getTransactionByHash",
                    params: [&tx_hash],
                },
                JsonRpcRequest {
                    jsonrpc: "2.0",
                    id: 2,
                    method: "eth_getTransactionReceipt",
                    params: [&tx_hash],
                },
            ];

            let client = awc::Client::builder()
                .timeout(Duration::from_secs(10))
                .finish();

            let mut response = client
                .post(&self.config.rpc_url)
                .insert_header(("Content-Type", "application/json"))
                .send_json(&batch_payload)
                .await
                .map_err(|err| {
                    AuthError::internal(
                        "Failed to reach ETH JSON-RPC endpoint.",
                        format!("{err:?}"),
                    )
                })?;

            if !response.status().is_success() {
                return Err(AuthError::internal(
                    "ETH JSON-RPC returned non-success HTTP status.",
                    format!("status={}", response.status()),
                ));
            }

            let body_bytes = response.body().await.map_err(|err| {
                AuthError::internal(
                    "Failed to read ETH JSON-RPC response body.",
                    format!("{err:?}"),
                )
            })?;

            let rpc_items: Vec<JsonRpcResponse> =
                serde_json::from_slice(&body_bytes).map_err(|err| {
                    AuthError::internal(
                        "Failed to parse ETH JSON-RPC response.",
                        format!("{err:?}"),
                    )
                })?;

            let mut tx: Option<RpcTransaction> = None;
            let mut receipt: Option<RpcTransactionReceipt> = None;

            for item in rpc_items {
                if let Some(rpc_err) = item.error {
                    return Err(AuthError::internal(
                        "ETH JSON-RPC returned an error.",
                        rpc_err.to_string(),
                    ));
                }
                match item.id {
                    1 => {
                        if let Some(val) = item.result {
                            if !val.is_null() {
                                tx = Some(serde_json::from_value(val).map_err(|err| {
                                    AuthError::internal(
                                        "Malformed transaction object from RPC.",
                                        format!("{err:?}"),
                                    )
                                })?);
                            }
                        }
                    }
                    2 => {
                        if let Some(val) = item.result {
                            if !val.is_null() {
                                receipt = Some(serde_json::from_value(val).map_err(|err| {
                                    AuthError::internal(
                                        "Malformed transaction receipt from RPC.",
                                        format!("{err:?}"),
                                    )
                                })?);
                            }
                        }
                    }
                    _ => {}
                }
            }

            validate_rpc_payment(
                &tx_hash,
                &expected_sender,
                &self.config,
                tx.as_ref(),
                receipt.as_ref(),
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALICE_WALLET: &str = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
    const BOB_WALLET: &str = "0x1111111111111111111111111111111111111111";
    const VALID_TX_HASH: &str =
        "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

    fn sample_config() -> PaymentConfig {
        PaymentConfig {
            rpc_url: "http://127.0.0.1:8545".to_string(),
            recipient_address: RECIPIENT_WALLET_ADDRESS.to_string(),
            min_payment_wei: 1_000_000_000_000_000, // 0.001 ETH = 0x38d7ea4c68000
            access_duration_secs: DEFAULT_ACCESS_DURATION_SECS,
        }
    }

    fn valid_tx() -> RpcTransaction {
        RpcTransaction {
            hash: Some(VALID_TX_HASH.to_string()),
            from: ALICE_WALLET.to_string(),
            to: Some("0xEFF121F128e0e64C0E64AE8Eb6eB042a0E5Aa81c".to_string()),
            value: "0x38d7ea4c68000".to_string(), // 1_000_000_000_000_000 wei
        }
    }

    fn valid_receipt() -> RpcTransactionReceipt {
        RpcTransactionReceipt {
            status: Some("0x1".to_string()),
        }
    }

    #[test]
    fn parses_hex_wei_quantities() {
        assert_eq!(parse_hex_wei("0x0").unwrap(), 0);
        assert_eq!(parse_hex_wei("0x0000").unwrap(), 0);
        assert_eq!(parse_hex_wei("0x1").unwrap(), 1);
        assert_eq!(
            parse_hex_wei("0x38d7ea4c68000").unwrap(),
            1_000_000_000_000_000
        );
        assert!(parse_hex_wei("1234").is_err(), "missing 0x must fail");
        assert!(parse_hex_wei("0x").is_err(), "empty hex must fail");
        assert!(parse_hex_wei("0xZZ").is_err(), "non-hex must fail");
    }

    #[test]
    fn validates_confirmed_direct_eth_payment() {
        let cfg = sample_config();
        let tx = valid_tx();
        let receipt = valid_receipt();

        let verified =
            validate_rpc_payment(VALID_TX_HASH, ALICE_WALLET, &cfg, Some(&tx), Some(&receipt))
                .expect("valid payment should succeed");

        assert_eq!(verified.tx_hash, VALID_TX_HASH);
        assert_eq!(verified.from_wallet, ALICE_WALLET);
        assert_eq!(verified.to_wallet, RECIPIENT_WALLET_ADDRESS);
        assert_eq!(verified.amount_wei, 1_000_000_000_000_000);
    }

    #[test]
    fn rejects_pending_reverted_wrong_recipient_wrong_sender_or_underpaid_tx() {
        let cfg = sample_config();
        let tx = valid_tx();
        let receipt = valid_receipt();

        // 1. Missing tx
        assert!(
            validate_rpc_payment(VALID_TX_HASH, ALICE_WALLET, &cfg, None, Some(&receipt)).is_err()
        );

        // 2. Pending tx (receipt: None)
        assert!(validate_rpc_payment(VALID_TX_HASH, ALICE_WALLET, &cfg, Some(&tx), None).is_err());

        // 3. Reverted tx (status: 0x0)
        let reverted = RpcTransactionReceipt {
            status: Some("0x0".to_string()),
        };
        assert!(
            validate_rpc_payment(
                VALID_TX_HASH,
                ALICE_WALLET,
                &cfg,
                Some(&tx),
                Some(&reverted)
            )
            .is_err()
        );

        // 4. Wrong recipient
        let mut wrong_to = valid_tx();
        wrong_to.to = Some(BOB_WALLET.to_string());
        assert!(
            validate_rpc_payment(
                VALID_TX_HASH,
                ALICE_WALLET,
                &cfg,
                Some(&wrong_to),
                Some(&receipt)
            )
            .is_err()
        );

        // 5. Wrong sender
        let wrong_sender_err =
            validate_rpc_payment(VALID_TX_HASH, BOB_WALLET, &cfg, Some(&tx), Some(&receipt))
                .expect_err("wrong sender must fail");
        assert_eq!(wrong_sender_err.code(), "PAYMENT_SENDER_MISMATCH");

        // 6. Underpaid amount
        let mut underpaid = valid_tx();
        underpaid.value = "0x1".to_string();
        assert!(
            validate_rpc_payment(
                VALID_TX_HASH,
                ALICE_WALLET,
                &cfg,
                Some(&underpaid),
                Some(&receipt)
            )
            .is_err()
        );
    }
}
