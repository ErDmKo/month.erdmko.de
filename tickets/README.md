# Project Tickets

## Paid Chat Deployment Readiness

The 2026-11-06 review of commit `89bf688` found the open work below.
All 15 Bazel test targets passed, but that did not establish browser purchase-flow readiness.
Production was healthy on `0119811` at the time of the review.

| Ticket | Priority | Work | Status |
| --- | --- | --- | --- |
| [AUTH-60](auth/AUTH-60-authorized-room-broadcasts.md) | P0 | Prevent unauthenticated WebSocket clients from receiving room broadcasts | Completed |
| [AUTH-70](auth/AUTH-70-pending-payment-recovery.md) | P0 | Recover pending payments without requesting another transfer | Completed |
| [AUTH-80](auth/AUTH-80-payment-network-consistency.md) | P1 | Align wallet network and payment configuration with the server | Completed |
| [AUTH-90](auth/AUTH-90-atomic-payment-activation.md) | P1 | Atomically record payment, nickname, and access | Completed |
| [DEPLOY-10](deployment/DEPLOY-10-accurate-chat-product-copy.md) | P1 | Correct pricing, authentication, encryption, and indexing claims | Completed |
| [DEPLOY-20](deployment/DEPLOY-20-wallet-flow-release-verification.md) | P1 | Verify the browser wallet flow and Linux release image | Completed |
| [DEPLOY-30](deployment/DEPLOY-30-client-error-logging.md) | P2 | Forward frontend runtime and wallet errors to server logs | Planned |

See the [deployment backlog](deployment/README.md) for dependencies and release acceptance.

## Performance

| Ticket | Priority | Work | Status |
| --- | --- | --- | --- |
| [PERF-10](performance/PERF-10-static-asset-compression.md) | P2 | Build and serve precompressed Brotli/gzip static assets | Planned |

The [compression design](../assets/compression.md) is the detailed specification for PERF-10.
Compression is independent of the paid-chat deployment blockers.

## Existing Backlogs

- [Chat MVP](chat-mvp/README.md)
- [Wallet authentication and paid access](auth/README.md)
- [Attachments](assets/README.md)
- [Voice](video/README.md)
- [End-to-end encryption](e2ee/README.md)
