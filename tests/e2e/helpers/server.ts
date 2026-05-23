import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';

export interface ServerHandle {
    port: number;
    dbPath: string;
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

/** Poll until TCP connect succeeds or timeout expires. */
function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const attempt = () => {
            if (Date.now() > deadline) {
                return reject(new Error(`Server on port ${port} did not become ready within ${timeoutMs}ms`));
            }
            const sock = net.connect(port, '127.0.0.1');
            sock.on('connect', () => {
                sock.destroy();
                resolve();
            });
            sock.on('error', () => {
                sock.destroy();
                setTimeout(attempt, 100);
            });
        };
        attempt();
    });
}

/**
 * Build the server binary with `cargo build --bin server` then spawn it.
 * The server reads HOST and PORT from env vars.
 *
 * `baseDir` should point to the workspace root (the directory containing
 * Cargo.toml / server/). Defaults to two levels up from this file.
 */
export async function startServer(baseDir?: string): Promise<ServerHandle> {
    const root = baseDir ?? path.resolve(__dirname, '..', '..', '..');

    // Build (skip if already built — cargo is smart about incremental)
    await new Promise<void>((resolve, reject) => {
        const build = spawn('cargo', ['build', '--bin', 'server'], {
            cwd: root,
            env: { ...process.env, RUST_LOG: 'warn' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        build.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`cargo build exited with code ${code}`));
        });
    });

    const port = await freePort();
    const dbPath = path.join(os.tmpdir(), `e2e_chat_${Date.now()}_${port}.sqlite`);

    const serverBin = path.join(root, 'target', 'debug', 'server');
    const proc: ChildProcess = spawn(serverBin, [], {
        cwd: root,
        env: {
            ...process.env,
            HOST: '127.0.0.1',
            PORT: String(port),
            DB_PATH: dbPath,
            RUST_LOG: 'warn',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.on('error', (err) => {
        throw new Error(`Failed to spawn server: ${err.message}`);
    });

    await waitForPort(port);

    const stop = (): Promise<void> =>
        new Promise((resolve) => {
            if (proc.exitCode !== null) return resolve();
            proc.once('exit', () => {
                try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
                resolve();
            });
            proc.kill('SIGTERM');
        });

    return { port, dbPath, stop };
}
