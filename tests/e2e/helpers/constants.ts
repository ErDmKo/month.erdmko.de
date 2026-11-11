/** Shared timeout constants for the e2e test suite. */

/** Default timeout for a single test case (Jest testTimeout). */
export const TEST_TIMEOUT_MS = 25_000;

/** Timeout waiting for the server /healthz endpoint to become ready. */
export const SERVER_READY_TIMEOUT_MS = 20_000;

/** Timeout for Puppeteer page navigations and element waits. */
export const PAGE_TIMEOUT_MS = 10_000;
