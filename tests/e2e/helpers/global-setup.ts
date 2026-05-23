/**
 * Jest globalSetup — builds and starts a shared server instance.
 * The port is written to process.env so all test suites can read it.
 */
import { startServer } from './server';

declare global {
    // eslint-disable-next-line no-var
    var __SERVER_PORT__: number;
    // eslint-disable-next-line no-var
    var __SERVER_STOP__: () => Promise<void>;
}

export default async function globalSetup(): Promise<void> {
    const handle = await startServer();
    // Expose via global so globalTeardown and individual suites can access them.
    global.__SERVER_PORT__ = handle.port;
    global.__SERVER_STOP__ = handle.stop;
    process.env.E2E_SERVER_PORT = String(handle.port);
    console.log(`[e2e] Server ready on port ${handle.port}`);
}
