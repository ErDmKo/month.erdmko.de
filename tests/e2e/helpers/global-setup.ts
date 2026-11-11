/**
 * Jest globalSetup — builds and starts a shared server + mock Ethereum JSON-RPC instance.
 * Ports are written to process.env so all test suites can access them.
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
    global.__SERVER_PORT__ = handle.port;
    global.__SERVER_STOP__ = handle.stop;
    process.env.E2E_SERVER_PORT = String(handle.port);
    process.env.E2E_RPC_PORT = String(handle.rpcPort);
    process.env.E2E_RPC_URL = handle.rpcUrl;
    console.log(
        `[e2e] Server ready on port ${handle.port} (mock RPC on ${handle.rpcPort})`
    );
}
