import { exec } from 'node:child_process';

type CommandOutput = {
    stdout: string;
    stderr: string;
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
const main = async (): Promise<void> => {
    await execAsync(
        [
            'docker',
            'build .',
            '--platform linux/amd64',
            `--tag ${PROJECT_NAME}`,
        ].join(' ')
    );
};

await main();
