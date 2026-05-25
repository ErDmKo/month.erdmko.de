/**
 * e2e.ts — build the server and run the e2e test suite.
 *
 * Usage (from repo root):
 *   npm run e2e                           # all suites
 *   npm run e2e -- suites/chat            # specific suite
 *   npm run e2e -- --testNamePattern upload
 */
import { execSync, spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E2E_DIR = path.join(ROOT, 'tests', 'e2e');

/** Run a command synchronously, streaming its output, and throw on non-zero exit. */
const run = (cmd: string, cwd = ROOT): void => {
    console.log(`> ${cmd}`);
    execSync(cmd, { cwd, stdio: 'inherit' });
};

/** Spawn jest, forwarding extra CLI args and inheriting stdio. */
const runJest = (args: string[]): Promise<void> => {
    const jestArgs = ['jest', ...args];
    console.log(`> npx ${jestArgs.join(' ')}`);
    return new Promise((resolve, reject) => {
        const child = spawn('npx', jestArgs, {
            cwd: E2E_DIR,
            stdio: 'inherit',
            shell: false,
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`jest exited with code ${code}`));
        });
    });
};

const main = async (): Promise<void> => {
    // Extra args passed after `--` (e.g. `npm run e2e -- suites/chat`)
    const extraArgs = process.argv.slice(2);

    console.log('\n[e2e] Building server with Bazel...');
    run('bazel build //server:server');

    console.log('\n[e2e] Installing test dependencies...');
    run('npm ci', E2E_DIR);

    console.log('\n[e2e] Running e2e tests...');
    await runJest(extraArgs);
};

await main();
