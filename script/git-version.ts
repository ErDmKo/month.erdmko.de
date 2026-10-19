import { execFileSync } from 'node:child_process';

export type GitVersion = {
    branch: string;
    commit: string;
    dirty: boolean;
    commitTime: string;
};

const git = (args: string[]): string | null => {
    try {
        return execFileSync('git', args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return null;
    }
};

/// Read the checkout metadata. Values are `unknown` when git is unavailable,
/// for example inside a Docker build context that excludes `.git`.
export const readGitVersion = (): GitVersion => {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const commit = git(['rev-parse', 'HEAD']);
    const commitTime = git(['log', '-1', '--format=%cI']);
    const status = git(['status', '--porcelain', '--untracked-files=normal']);
    return {
        branch:
            branch === null
                ? 'unknown'
                : branch === 'HEAD'
                  ? 'detached'
                  : branch,
        commit: commit ?? 'unknown',
        dirty: status !== null && status.length > 0,
        commitTime: commitTime ?? 'unknown',
    };
};
