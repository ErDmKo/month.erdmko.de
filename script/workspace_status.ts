#!/usr/bin/env -S node --experimental-strip-types --no-warnings
import { readGitVersion } from './git-version.ts';

/// Bazel --workspace_status_command. Bazel substitutes these STABLE_* keys into
/// `server/version.env`; GIT_* environment variables take precedence so Docker
/// builds can pass metadata without including `.git` in the build context.
const env = process.env;
const git = readGitVersion();

const branch = env.GIT_BRANCH || git.branch;
const commit = env.GIT_COMMIT || git.commit;
const dirty = env.GIT_DIRTY || (git.dirty ? '1' : '0');
const buildTime = env.BUILD_TIME || git.commitTime;

console.log(`STABLE_GIT_BRANCH ${branch}`);
console.log(`STABLE_GIT_COMMIT ${commit}`);
console.log(`STABLE_GIT_DIRTY ${dirty}`);
console.log(`STABLE_BUILD_TIME ${buildTime}`);
