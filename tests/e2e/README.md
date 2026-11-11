# Browser E2E Test Suite (`tests/e2e`)

End-to-end Puppeteer + Jest tests exercising the shipped Closure-Compiler `ADVANCED` bundles (`chat-bundle.js`, `month-bundle.js`, `tetris-bundle.js`, `tennis-bundle.js`, `snowflake-bundle.js`), Actix Web HTTP/WebSocket handlers, binary Protobuf `/auth/*` endpoints, real secp256k1 EIP-4361 (SIWE) signatures, and deterministic Ethereum JSON-RPC payment verification.

## Directory Layout

```text
tests/e2e/
├── helpers/
│   ├── constants.ts        # Bounded readiness, page, and Jest timeouts
│   ├── eth-crypto.ts       # Deterministic test-only Keccak-256 + secp256k1 EIP-191 signer
│   ├── global-setup.ts     # Builds //server:server and starts shared server + mock RPC
│   ├── global-teardown.ts  # Stops shared server + mock RPC and cleans temp DBs
│   ├── mock-rpc.ts         # Local JSON-RPC 2.0 server (eth_chainId, tx & receipt lookup)
│   ├── server.ts           # Isolated BASE_PATH + /healthz readiness helper
│   └── wallet.ts           # EIP-1193 window.ethereum provider fixture
├── pages/                  # Page Object Model (REQUIRED for all DOM/navigation interactions)
│   ├── base.page.ts        # BasePage + createIsolatedPageSession (incognito BrowserContext)
│   ├── chat-onboarding.page.ts # /chat and /chat?room={slug} onboarding Page Object
│   ├── chat-room.page.ts   # /chat/{room} messaging, file attachments & WebRTC voice Page Object
│   ├── games.page.ts       # MonthGamePage, TennisGamePage, TetrisGamePage, HomePage
│   └── index.ts            # Barrel exports for Page Objects
└── suites/
    ├── attachments-ui.test.ts          # Chunked file preview, cancel, upload, progress & download
    ├── bundles.test.ts                 # Closure ADVANCED bundle verification across all apps
    ├── page-object-enforcement.test.ts # Automated architectural check enforcing Page Objects
    └── wallet-onboarding.test.ts       # SIWE, ETH payment, pending/conflict/reverted recovery, WS auth & DB restart persistence
```

## Page Object Model Rule (Enforced)

All browser navigation, DOM queries, CSS selectors, form inputs, button clicks, and `window`/`document` evaluations **must** live inside Page Objects under `tests/e2e/pages/` — **never** inline inside `tests/e2e/suites/*.test.ts`.

Specifically:
1. **No raw Puppeteer DOM/navigation calls in `suites/*.test.ts`:**
   Do not call `page.goto`, `page.reload`, `page.$`, `page.$$`, `page.$eval`, `page.$$eval`, `page.waitForSelector`, `page.waitForFunction`, `page.click`, `page.type`, `page.focus`, `page.keyboard`, `page.evaluate`, `page.evaluateOnNewDocument`, `page.cookies`, `page.setCookie`, or `document.querySelector*` directly in test files.
2. **Isolate browser state per test:**
   Always create per-test contexts via `createIsolatedPageSession(browser)` so `HttpOnly` `month_session` cookies and `localStorage` never leak across test cases.
3. **Import hashed CSS module classes in Page Objects:**
   Reference generated CSS class constants from `assets/js/gen/styles` inside `tests/e2e/pages/*.page.ts` rather than hardcoding minified class names.
4. **Automated enforcement:**
   `suites/page-object-enforcement.test.ts` scans every `suites/*.test.ts` file during `npm test` and fails the suite if any direct Puppeteer DOM/navigation call or `document.querySelector*` appears outside `tests/e2e/pages/`.

## Running E2E Tests

```bash
cd tests/e2e
npm test -- --runInBand
```

Run a single suite:

```bash
cd tests/e2e
npm test -- --runInBand suites/wallet-onboarding.test.ts
```
