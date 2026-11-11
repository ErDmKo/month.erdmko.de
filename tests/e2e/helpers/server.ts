import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { SERVER_READY_TIMEOUT_MS } from './constants';
import { startMockEthRpcServer } from './mock-rpc';
import type { MockRpcHandle } from './mock-rpc';

export interface StartServerOptions {
    workspaceRoot?: string;
    baseDir?: string;
    keepBaseDirOnStop?: boolean;
    rpcUrl?: string;
    envOverrides?: Record<string, string>;
    skipBuild?: boolean;
}

export interface ServerHandle {
    port: number;
    baseDir: string;
    rpcUrl: string;
    rpcPort: number;
    stop: () => Promise<void>;
}

/** Find a free TCP port on localhost. */
function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address() as net.AddressInfo;
            srv.close((err) => (err ? reject(err) : resolve(addr.port)));
        });
    });
}

function checkHealthz(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const req = http.get(
            {
                hostname: '127.0.0.1',
                port,
                path: '/healthz',
                timeout: 500,
            },
            (res) => {
                res.resume();
                resolve(res.statusCode === 200);
            }
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
    });
}

/** Poll GET /healthz until 200 OK, early child exit, or timeout. */
async function waitForHealthz(
    port: number,
    proc: ChildProcess,
    getLogs: () => string,
    timeoutMs = SERVER_READY_TIMEOUT_MS
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
        if (proc.exitCode !== null) {
            throw new Error(
                `Server on port ${port} exited early with code ${proc.exitCode}.\nLogs:\n${getLogs()}`
            );
        }
        if (await checkHealthz(port)) {
            return;
        }
        await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(
        `Server on port ${port} did not pass /healthz within ${timeoutMs}ms.\nLogs:\n${getLogs()}`
    );
}

export async function startServer(
    options: StartServerOptions = {}
): Promise<ServerHandle> {
    const root =
        options.workspaceRoot ?? path.resolve(__dirname, '..', '..', '..');

    // ── 1. Build //server:server (includes all JS/CSS bundles & templates) ──
    if (!options.skipBuild) {
        await new Promise<void>((resolve, reject) => {
            const buildLogs: string[] = [];
            const build = spawn('bazel', ['build', '//server:server'], {
                cwd: root,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            build.stdout?.on('data', (d: Buffer) =>
                buildLogs.push(d.toString())
            );
            build.stderr?.on('data', (d: Buffer) =>
                buildLogs.push(d.toString())
            );
            build.on('close', (code) => {
                if (code === 0) resolve();
                else
                    reject(
                        new Error(
                            `bazel build //server:server exited with code ${code}\n${buildLogs.slice(-20).join('')}`
                        )
                    );
            });
        });
    }

    // ── 2. Start Mock Ethereum JSON-RPC server if none provided ─────────────
    let ownedRpc: MockRpcHandle | null = null;
    if (!options.rpcUrl) {
        ownedRpc = await startMockEthRpcServer('0x1');
    }
    const rpcUrl = options.rpcUrl ?? ownedRpc!.url;
    const rpcPort = ownedRpc ? ownedRpc.port : 0;

    // ── 3. Prepare isolated BASE_PATH ───────────────────────────────────────
    const runfilesMain = path.join(
        root,
        'bazel-bin',
        'server',
        'server.runfiles',
        '_main'
    );
    const runfilesTemplates = path.join(runfilesMain, 'server', 'templates');
    const runfilesAssets = path.join(runfilesMain, 'assets');

    const createdTempBaseDir = !options.baseDir;
    const baseDir =
        options.baseDir ??
        fs.mkdtempSync(path.join(os.tmpdir(), 'e2e_server_'));
    fs.mkdirSync(path.join(baseDir, 'server', 'db'), { recursive: true });
    const tplLink = path.join(baseDir, 'server', 'templates');
    const assetsLink = path.join(baseDir, 'assets');
    if (!fs.existsSync(tplLink)) {
        fs.symlinkSync(runfilesTemplates, tplLink);
    }
    if (!fs.existsSync(assetsLink)) {
        fs.symlinkSync(runfilesAssets, assetsLink);
    }

    // ── 4. Spawn server binary ──────────────────────────────────────────────
    const port = await freePort();
    const serverBin = path.join(root, 'bazel-bin', 'server', 'server');
    const recentLogs: string[] = [];
    const appendLog = (chunk: Buffer) => {
        const text = chunk.toString();
        recentLogs.push(text);
        if (recentLogs.length > 80) recentLogs.shift();
    };

    const proc: ChildProcess = spawn(serverBin, [], {
        cwd: baseDir,
        env: {
            ...process.env,
            HOST: '127.0.0.1',
            PORT: String(port),
            BASE_PATH: baseDir,
            ETH_RPC_URL: rpcUrl,
            RUST_LOG: 'info',
            ...(options.envOverrides ?? {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout?.on('data', appendLog);
    proc.stderr?.on('data', appendLog);

    const cleanupProcessAndFiles = async () => {
        if (proc.exitCode === null) {
            await new Promise<void>((resolve) => {
                const killTimer = setTimeout(() => {
                    proc.kill('SIGKILL');
                }, 3000);
                proc.once('exit', () => {
                    clearTimeout(killTimer);
                    resolve();
                });
                proc.kill('SIGTERM');
            });
        }
        if (ownedRpc) {
            await ownedRpc.stop();
        }
        if (createdTempBaseDir && !options.keepBaseDirOnStop) {
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    };

    try {
        await waitForHealthz(port, proc, () => recentLogs.join(''));
    } catch (err) {
        await cleanupProcessAndFiles();
        throw err;
    }

    proc.unref();

    return {
        port,
        baseDir,
        rpcUrl,
        rpcPort,
        stop: cleanupProcessAndFiles,
    };
}
