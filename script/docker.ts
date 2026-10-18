import { execFile } from 'node:child_process';
import { readGitVersion } from './git-version.ts';

type CommandOutput = {
    stdout: string;
    stderr: string;
};

const execAsync = async (
    command: string,
    args: string[] = []
): Promise<CommandOutput> => {
    console.log(`Executing '${[command, ...args].join(' ')}'`);
    const childProc = execFile(command, args);
    childProc.stdout?.pipe(process.stdout);
    childProc.stderr?.pipe(process.stderr);
    return new Promise<CommandOutput>((resolve, reject) => {
        const output: CommandOutput = {
            stdout: '',
            stderr: '',
        };
        childProc.stdout?.on('data', (eventData) => {
            output.stdout += eventData;
        });
        childProc.stderr?.on('data', (eventData) => {
            output.stderr += eventData;
        });
        childProc.on('error', reject);
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
const main = async (): Promise<void> => {
    const version = readGitVersion();
    const buildTime = new Date().toISOString();
    console.log(
        `Version: branch=${version.branch} commit=${version.commit} dirty=${version.dirty} build_time=${buildTime}`
    );
    await execAsync('docker', [
        'build',
        '.',
        '--platform',
        'linux/amd64',
        '--tag',
        PROJECT_NAME,
        '--build-arg',
        `GIT_BRANCH=${version.branch}`,
        '--build-arg',
        `GIT_COMMIT=${version.commit}`,
        '--build-arg',
        `GIT_DIRTY=${version.dirty ? '1' : '0'}`,
        '--build-arg',
        `BUILD_TIME=${buildTime}`,
    ]);
};

await main();
