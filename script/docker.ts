import { exec } from 'node:child_process';
import { stat, chmod, readdir, cp } from 'node:fs/promises';
import { join } from 'node:path';

type CommandOutput = {
    stdout: string;
    stderr: string;
};

type BuildSecrets = {
    apiToken?: string;
};

const execAsync = async (command: string): Promise<CommandOutput> => {
    console.log(`Executing '${command}'`);
    const childProc = exec(command);
    childProc.stdout.pipe(process.stdout);
    childProc.stderr.pipe(process.stderr);
    return new Promise<CommandOutput>((resolve, reject) => {
        const output: CommandOutput = {
            stdout: '',
            stderr: '',
        };
        childProc.stdout.on('data', (eventData) => {
            output.stdout += eventData;
        });
        childProc.stderr.on('data', (eventData) => {
            output.stderr += eventData;
        });
        childProc.on('exit', (code) => {
            if (code === 0) {
                resolve(output);
            } else {
                reject(output);
            }
        });
    });
};

const PROJECT_NAME = 'what_amonth';
const TMP_DIR = '_tmp';

// Helper function to recursively change permissions
async function makeReadWriteRecursive(targetPath: string): Promise<void> {
    const stats = await stat(targetPath);

    // Directories need "execute" permission (7) to open/traverse them.
    // Files just need read/write (6).
    const mode = stats.isDirectory() ? 0o777 : 0o666;
    await chmod(targetPath, mode);

    if (stats.isDirectory()) {
        const items = await readdir(targetPath);
        for (const item of items) {
            // Recursively run this for every file/folder inside
            await makeReadWriteRecursive(join(targetPath, item));
        }
    }
}

async function copyAndMakeReadWrite(
    staticDir: string,
    tmpDir: string
): Promise<void> {
    console.log('Static dir', staticDir);

    // 1. Copy the directory recursively
    // 'dereference: true' resolves symbolic links, acting like '-L'
    await cp(staticDir, tmpDir, { recursive: true, dereference: true });
    console.log(`Copied directory to ${tmpDir}`);

    // 2. Give the new copy Read & Write permissions recursively
    await makeReadWriteRecursive(tmpDir);
    console.log(`Granted read/write permissions to ${tmpDir}`);
}

const main = async (): Promise<void> => {
    await execAsync(`rm -rf ./${TMP_DIR}`);
    await execAsync(`bazel build //server`);
    const { stdout: files } = await execAsync(
        ['bazel', 'cquery', '//server', '--output=files'].join(' ')
    );
    const [serverDeps] = files.trim().split('\n');
    const staticDir = `${serverDeps}.runfiles/_main/assets`;
    let secrets: BuildSecrets = {};
    try {
        ({ default: secrets } = await import('./secret.json', {
            assert: { type: 'json' },
        }));
    } catch {
        console.log('No secrets build');
    }
    /**
      Docker only can use files inside the the project folder,
      but bazel save files to /private/tmp/... just copy them
    */
    await copyAndMakeReadWrite(staticDir, TMP_DIR);
    await execAsync(
        [
            'docker',
            'build .',
            '--platform linux/amd64',
            `--tag ${PROJECT_NAME}`,
            `--build-arg STATIC_DIR=${TMP_DIR}`,
        ]
            .concat(
                secrets.apiToken
                    ? [`--build-arg API_TOKEN=${secrets.apiToken}`]
                    : []
            )
            .join(' ')
    );
    await execAsync(`rm -rf ./${TMP_DIR}`);
};

await main();
