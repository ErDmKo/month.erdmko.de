import { exec } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED_DIR = path.join(ROOT, 'assets/js/gen');

const run = (cmd: string): Promise<string> => {
    console.log(`> ${cmd}`);
    return new Promise((resolve, reject) => {
        const child = exec(cmd, { cwd: ROOT });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d: string) => {
            process.stdout.write(d);
            stdout += d;
        });
        child.stderr?.on('data', (d: string) => {
            process.stderr.write(d);
            stderr += d;
        });
        child.on('exit', (code) =>
            code === 0
                ? resolve(stdout)
                : reject(new Error(stderr || `exit ${code}`))
        );
    });
};

const bazelOut = async (target: string): Promise<string> => {
    const output = await run(`bazel cquery ${target} --output=files`);
    const file = output.trim().split('\n')[0];
    if (!file) throw new Error(`No output file for ${target}`);
    return path.join(ROOT, file);
};

// Bazel makes output files read-only; read+write avoids permission errors on overwrite.
const copyGenerated = async (src: string, dst: string): Promise<void> => {
    await writeFile(dst, await readFile(src));
};

const main = async () => {
    await mkdir(GENERATED_DIR, { recursive: true });

    // ── gen/styles.ts ─────────────────────────────────────────────────────────
    console.log('\nBuilding styles_ts...');
    await run('bazel build //assets/js:styles_ts');
    const stylesSrc = await bazelOut('//assets/js:styles_ts');
    await copyGenerated(stylesSrc, path.join(GENERATED_DIR, 'styles.ts'));
    console.log(`  copied → assets/js/gen/styles.ts`);

    // ── gen/chat.ts ───────────────────────────────────────────────────────────
    console.log('\nBuilding chat_ts...');
    await run('bazel build //assets/js:chat_ts');
    const chatSrc = await bazelOut('//assets/js:chat_ts');
    await copyGenerated(chatSrc, path.join(GENERATED_DIR, 'chat.ts'));
    console.log(`  copied → assets/js/gen/chat.ts`);

    console.log('\nDone. Commit assets/js/gen/ to keep editors in sync.');
};

await main();
