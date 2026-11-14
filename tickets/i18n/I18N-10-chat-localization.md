---
title: "Support Multi-Language Localization (English & Russian) for Chat"
ticket: "I18N-10"
status: "planned"
draft: false
weight: 10
---

# I18N-10 Support Multi-Language Localization (English & Russian) for Chat

**Priority: P2. Independent growth & UX improvement.**

## Depends on

- [DEPLOY-10](../deployment/DEPLOY-10-accurate-chat-product-copy.md) for accurate paid-wallet, transport-encryption, and crawler-indexing disclosures.
- [AUTH-80](../auth/AUTH-80-payment-network-consistency.md) for server-configured network, ETH amount, and access duration values interpolated into localized copy.

## Goal

Allow `/chat` and `/chat/{room}` to render in **English (`en`)** and **Russian (`ru`)** — including social preview metadata (X / Open Graph), structured data, wallet onboarding UI, and live room controls — so links shared with Russian-speaking audiences convert cleanly without duplicating templates or bloating the Closure-compiled browser bundle.

## Scope

- **Locale negotiation & persistence:**
  - Resolve locale in deterministic priority order: explicit `?lang=en|ru` query parameter → `month_lang` preference cookie → `Accept-Language` header → `en` default.
  - Provide a lightweight visible `EN / RU` switcher on `/chat` and `/chat/{room}` that updates preference cleanly while preserving any `?room=...` invite target.
- **Server-side templates & SEO metadata:**
  - Parameterize `<html lang="{{ lang }}">` in `server/templates/base.html` (defaulting to `"en"` for non-localized routes).
  - Serve typed server-side translation catalogs (compile-time Rust structs/maps, zero external runtime files to misplace) into Tera context for `chat_landing.html` and `chat.html`.
  - Localize `<title>`, `<meta name="description">`, Open Graph, Twitter Card (`twitter:title`, `twitter:description`), and JSON-LD `@graph` (`WebApplication` + `FAQPage`) when `?lang=ru` is requested so social network link previews render in Russian.
  - Emit accurate `canonical` and `<link rel="alternate" hreflang="en|ru|x-default">` tags on publicly crawlable `/chat` URLs while keeping `/chat?room=...` (`noindex, follow`) and `/chat/{room}` (`noindex, nofollow`) crawler rules intact.
  - Preserve every `DEPLOY-10` accuracy requirement in all locales: clearly distinguish the free off-chain SIWE signature from the paid on-chain ETH transfer, interpolate effective `PaymentConfig` values, and state explicitly that traffic is protected in transit (`HTTPS/WSS` + `DTLS-SRTP`) rather than end-to-end encrypted.
- **Client-side TypeScript string catalog:**
  - Add a zero-dependency typed message catalog under `assets/js/chat/i18n/` compatible with esbuild → Closure Compiler `ADVANCED` optimization (tuple/indexed constants, reading `document.documentElement.lang`).
  - Localize wallet onboarding banners, buttons, validation messages, pending-payment recovery notices, room message controls, attachment upload/download states, and voice bar statuses.

## Implementation Areas

- `server/src/i18n/` (new) and `server/src/pages/chat/mod.rs`
- `server/templates/base.html`, `server/templates/chat_landing.html`, and `server/templates/chat.html`
- `assets/js/chat/i18n/` (new), `assets/js/chat/chat-ui/`, `assets/js/chat/voice/`, and `assets/js/chat/attachments/`
- `tests/e2e/pages/chat-onboarding.page.ts`, `tests/e2e/pages/chat-room.page.ts`, and E2E suites

## Tests and Acceptance

- [ ] `GET /chat` defaults to English (`<html lang="en">`), while `GET /chat?lang=ru` and `Accept-Language: ru-RU,ru;q=0.9` render Russian visible copy, Twitter/OG metadata, and valid localized JSON-LD.
- [ ] Every locale interpolates live `PaymentConfig` network, ETH amount, recipient address, and duration accurately and contains no unsupported anonymous, free-room, or E2EE claims.
- [ ] Invite redirects (`/chat/my-room` → `/chat?room=my-room`) preserve or negotiate locale cleanly and retain `noindex` protections.
- [ ] Client-side onboarding, error recovery, voice status, and room UI render in the active locale under Closure `ADVANCED` bundling without raw untranslated keys or console errors.
- [ ] Page Object Puppeteer E2E tests cover switching between `en` and `ru` and completing wallet onboarding in Russian.
