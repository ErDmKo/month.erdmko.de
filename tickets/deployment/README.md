# Paid Chat Deployment Tickets

Source: deployment-readiness review on 2026-11-06, candidate `89bf688`.

## Release Status

**Blocked for a public paid launch.**

- Anonymous receipt of a paid room message was reproduced on an isolated local server.
- Duplicate payment requests after a pending response were reproduced with a mocked browser wallet.
- Network selection and non-atomic payment writes were identified in source review.
- All 15 Bazel targets passed, but the browser E2E attempt failed during server startup.
- Production `/healthz` was healthy and `/version` reported `0119811` at review time.

## Execution Order

1. [AUTH-60](../auth/AUTH-60-authorized-room-broadcasts.md): authenticated broadcast membership.
2. [AUTH-80](../auth/AUTH-80-payment-network-consistency.md): shared payment/network contract.
3. [AUTH-90](../auth/AUTH-90-atomic-payment-activation.md): atomic activation and replay behavior.
4. [AUTH-70](../auth/AUTH-70-pending-payment-recovery.md): pending-payment recovery using that contract.
5. [DEPLOY-10](DEPLOY-10-accurate-chat-product-copy.md): accurate product copy and metadata.
6. [DEPLOY-20](DEPLOY-20-wallet-flow-release-verification.md): complete browser and release-image verification.

The auth fixes can progress independently where their interfaces are already agreed.
DEPLOY-20 can start by repairing the test harness, but can close only after the fixes and copy updates pass verification.

[PERF-10](../performance/PERF-10-static-asset-compression.md) tracks the separate static compression improvement.
It is not a prerequisite for the paid-auth release.
