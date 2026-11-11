---
title: "Align Chat Product Copy With Paid Wallet Access"
ticket: "DEPLOY-10"
status: "completed"
draft: false
weight: 10
---

# DEPLOY-10 Align Chat Product Copy With Paid Wallet Access

**Priority: P1. Required before the public paid launch.**

## Depends on

- [AUTH-80](../auth/AUTH-80-payment-network-consistency.md) for effective network, price, and access duration.

Related: the [E2EE backlog](../e2ee/README.md). Completing E2EE is not a dependency for this copy correction.

## Goal

Visible copy, social metadata, and structured data accurately describe the released product.

## Evidence

At `89bf688`, `server/templates/chat_landing.html` still describes anonymous/optional-wallet
access, advertises a zero-price USD offer in JSON-LD, and uses “Encrypted Chat Rooms” in the title.
Room routes now require a paid authenticated session. E2EE is planned in separate tickets.

The FAQ also claims that curated room pages are indexed, although anonymous requests to those
pages redirect to onboarding. Those protected URLs still appear in the sitemap.

## Scope

- Explain wallet sign-in, the free signature step, and the separate paid-access step.
- Show the configured payment network, amount, and access period before payment.
- Remove unsupported free/anonymous access and E2EE claims from visible text and metadata.
- Distinguish HTTPS transport protection from end-to-end encryption when describing security.
- Keep JSON-LD descriptions and any offer data consistent with visible product details.
- Align FAQ content, canonical URLs, robots directives, and sitemap entries with publicly crawlable pages.
- Describe `noindex` as a crawler directive, not a privacy or room-access guarantee.

## Implementation Areas

- `server/templates/chat_landing.html`, `chat.html`, and `base.html`
- `server/src/pages/main_page.rs` sitemap handler
- `server/src/pages/chat/mod.rs` and associated sitemap tests

## Acceptance

- [x] A new visitor can understand the required wallet, network, payment, and access duration before paying.
- [x] Rendered HTML and JSON-LD have no unsupported free, anonymous, or E2EE promises.
- [x] Sitemap URLs resolve anonymously to intended indexable content, rather than authenticated-room redirects.
- [x] The FAQ matches actual access behavior and does not promise search-engine indexing or privacy from `noindex`.
- [x] Metadata and structured data are inspected directly; Lighthouse scores alone are not proof of claim accuracy.
