/** Shared timeout constants for the e2e test suite. */

/** Default timeout for a single test case (Jest testTimeout). */
export const TEST_TIMEOUT_MS = 3_000;

/** Timeout waiting for the server TCP port to become ready. */
export const SERVER_READY_TIMEOUT_MS = 1_000;

/** Timeout for Puppeteer page navigations and element waits. */
export const PAGE_TIMEOUT_MS = 1_000;
