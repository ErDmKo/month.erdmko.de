---
title: "Verify Wallet Onboarding and the Linux Release Image"
ticket: "DEPLOY-20"
status: "planned"
draft: false
weight: 20
---

# DEPLOY-20 Verify Wallet Onboarding and the Linux Release Image

**Priority: P1. Final paid-chat release gate.**

## Depends on

- [AUTH-60](../auth/AUTH-60-authorized-room-broadcasts.md)
- [AUTH-70](../auth/AUTH-70-pending-payment-recovery.md)
- [AUTH-80](../auth/AUTH-80-payment-network-consistency.md)
- [AUTH-90](../auth/AUTH-90-atomic-payment-activation.md)
- [DEPLOY-10](DEPLOY-10-accurate-chat-product-copy.md)

Related: [ASSETS-60](../assets/ASSETS-60-e2e-tests.md) for attachment coverage.
Reuse and update the existing browser harness instead of creating a parallel one.

## Goal

Demonstrate that the built application supports new purchases and returning paid users,
rejects unauthorized room access, and retains access records across deployment restarts.

## Current Verification Gap

At `89bf688`, all 15 `bazel test //...` targets passed.
The targeted browser command below failed in global setup:

```bash
cd tests/e2e
npm test -- --runInBand suites/bundles.test.ts \
  --testNamePattern='chat preserves dataset' --testTimeout=15000
```

```text
Server on port <ephemeral-port> did not become ready within 1000ms
```

`SERVER_READY_TIMEOUT_MS` and `PAGE_TIMEOUT_MS` are both `1000` in
`tests/e2e/helpers/constants.ts`. The failure proves that this attempt did not run
the browser assertions; it does not by itself establish why startup missed the deadline.
Existing chat browser helpers also still expect a nickname form and **Join room** button on a room page.

## Scope

- Diagnose startup with captured process exit status and logs; use realistic, bounded readiness/navigation timeouts.
- Check `/healthz` readiness and always clean up child processes and temporary databases after setup failures.
- Update browser helpers for `/chat` onboarding, room redirects, and automatic joining.
- Exercise the shipped Closure-optimized bundle against real HTTP/WebSocket handlers.
- Use isolated databases, test-only signing keys, and deterministic wallet/RPC fixtures for automated payments.
- Keep private keys and session cookies out of test reports. Test records must not become production startup seeds.
- Build and smoke-test the Linux Docker image from the candidate commit.
- Verify the `/app/server/db` persistent volume retains sessions, profiles, claimed hashes, and access across restart.
- Document effective public origin, SIWE domain, cookie behavior, payment configuration, and WebSocket proxy settings.
- Record results with candidate commit, environment, commands, and actual pass/fail evidence.

## Required Scenarios

- [ ] New wallet: nonce → SIWE signature → session → payment → confirmation → access → room auto-join.
- [ ] Returning paid wallet: refresh and reconnect restore the correct wallet/nickname without another payment.
- [ ] Room invite: anonymous/unpaid visitor sees room-specific onboarding and returns to the same room after activation.
- [ ] Wrong chain, rejected signature/transfer, pending/reverted payment, RPC failure, and nickname conflict give actionable feedback.
- [ ] Pending payment survives refresh and retries without a second transfer.
- [ ] Duplicate/concurrent claims and lost responses never grant duplicate access.
- [ ] Anonymous, unpaid, expired, revoked, and unjoined WebSocket clients cannot receive room data.
- [ ] Authorized members exchange text, upload/download attachments, and join/leave voice.
- [ ] Secure session cookies and WSS work through an HTTPS deployment-like endpoint.
- [ ] Database activation failure rolls back, and retry can recover.
- [ ] Linux image starts healthy and preserves paid access through a container restart.
- [ ] `bazel test //...` and the updated browser suite pass.

## Acceptance

Attach the verification results here before marking this ticket complete.
Local DB-granted access and mocked browser UI state do not establish a real purchase flow by themselves.
Record any real-wallet smoke separately from automated fixture results.
Deployment and any real transfer remain explicit execution steps, not side effects of running the test suite.
