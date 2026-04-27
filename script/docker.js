import { exec } from 'node:child_process';
import { stat } from 'node:fs/promises';

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
         assert: { type: "json" }
      }));
    } catch (e) {
      console.log('No secrets build');
    }
    /**
      Docker only can use files inside the the project folder,
      but bazel save files to /private/tmp/... just copy them
    */
    const statInfo = await stat(staticDir);
    console.log('Static dir', staticDir);
    await execAsync(`cp -rL ${staticDir} ./${TMP_DIR}`);
    await execAsync(
        [
            'docker',
            'build .',
            '--platform linux/amd64',
            `--tag ${PROJECT_NAME}`,
            `--build-arg STATIC_DIR=${TMP_DIR}`,
        ].concat(secrets.apiToken ? [
            `--build-arg API_TOKEN=${secrets.apiToken}`,
        ] : [])
      .join(' ')
    );
    await execAsync(`rm -rf ./${TMP_DIR}`);
};

await main();
