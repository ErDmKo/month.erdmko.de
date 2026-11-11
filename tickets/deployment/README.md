# Paid Chat Deployment Tickets

Source: deployment-readiness review on 2026-11-06, candidate `89bf688`.

## Release Status

**Ready for release (`AUTH-60`..`AUTH-90`, `DEPLOY-10`, and `DEPLOY-20` completed on 2026-11-11).**

- Authenticated broadcast membership, client-initiated `ClientPing`, and session/access enforcement completed in [AUTH-60](../auth/AUTH-60-authorized-room-broadcasts.md).
- Shared server-to-browser payment/network contract and binary Protobuf `/auth/*` endpoints completed in [AUTH-80](../auth/AUTH-80-payment-network-consistency.md) & [DEPLOY-10](DEPLOY-10-accurate-chat-product-copy.md).
- Atomic SQLite payment claiming, nickname uniqueness, and idempotent replay handling completed in [AUTH-90](../auth/AUTH-90-atomic-payment-activation.md).
- Pending-payment reload persistence and single-transfer retry recovery completed in [AUTH-70](../auth/AUTH-70-pending-payment-recovery.md).
- Accurate `/chat` pricing, onboarding, transport encryption, and indexing metadata completed in [DEPLOY-10](DEPLOY-10-accurate-chat-product-copy.md).
- Full Page Object Puppeteer E2E verification (including HTTPS/`wss://` reverse proxy and SQLite restart persistence), `GET /version` liveness consolidation, and `linux/amd64` Docker release image + volume smoke verification completed in [DEPLOY-20](DEPLOY-20-wallet-flow-release-verification.md).

## Execution Order

1. [AUTH-60](../auth/AUTH-60-authorized-room-broadcasts.md): authenticated broadcast membership — **Completed**
2. [AUTH-80](../auth/AUTH-80-payment-network-consistency.md): shared payment/network contract — **Completed**
3. [AUTH-90](../auth/AUTH-90-atomic-payment-activation.md): atomic activation and replay behavior — **Completed**
4. [AUTH-70](../auth/AUTH-70-pending-payment-recovery.md): pending-payment recovery using that contract — **Completed**
5. [DEPLOY-10](DEPLOY-10-accurate-chat-product-copy.md): accurate product copy and metadata — **Completed**
6. [DEPLOY-20](DEPLOY-20-wallet-flow-release-verification.md): complete browser and release-image verification — **Completed**
7. [DEPLOY-30](DEPLOY-30-client-error-logging.md): forward frontend runtime and wallet errors to server logs — **Planned**

[PERF-10](../performance/PERF-10-static-asset-compression.md) tracks the separate static compression improvement.
It is not a prerequisite for the paid-auth release.
