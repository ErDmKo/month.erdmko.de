import { exec } from 'node:child_process';
import { stat, chmod, readdir, cp } from 'node:fs/promises'
import { join } from 'node:path';


const execAsync = async (fn) => {
    console.log(`Exceuting '${fn}'`);
    const childProc = exec(fn);
    childProc.stdout.pipe(process.stdout);
    childProc.stderr.pipe(process.stderr);
    return new Promise((resolve, reject) => {
        const out = {
            stdout: '',
            stderr: '',
        };
        childProc.stdout.on('data', (eventData) => {
            out.stdout += eventData;
        });
        childProc.stderr.on('data', (eventData) => {
            out.stderr += eventData;
        });
        childProc.on('exit', (code) => {
            if (code === 0) {
                resolve(out);
            } else {
                reject(out);
            }
        });
    });
};

const PROJECT_NAME = 'what_amonth';
const TMP_DIR = '_tmp';

// Helper function to recursively change permissions
async function makeReadWriteRecursive(targetPath) {
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

async function copyAndMakeReadWrite(staticDir, tmpDir) {
      console.log('Static dir', staticDir);

      // 1. Copy the directory recursively
      // 'dereference: true' resolves symbolic links, acting like '-L'
      await cp(staticDir, tmpDir, { recursive: true, dereference: true });
      console.log(`Copied directory to ${tmpDir}`);

      // 2. Give the new copy Read & Write permissions recursively
      await makeReadWriteRecursive(tmpDir);
      console.log(`Granted read/write permissions to ${tmpDir}`);

}

const main = async () => {
    await execAsync(`rm -rf ./${TMP_DIR}`);
    await execAsync(`bazel build //server`);
    const { stdout: files } = await execAsync(
        ['bazel', 'cquery', '//server', '--output=files'].join(' ')
    );
    const [serverDeps] = files.trim().split('\n');
    const staticDir = `${serverDeps}.runfiles/_main/assets`;
    let secrets = {};
    try {
        ({ default: secrets } = await import('./secret.json', {
            assert: { type: 'json' },
        }));
    } catch (e) {
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
