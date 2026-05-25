import type { Config } from 'jest';
import { TEST_TIMEOUT_MS } from './helpers/constants';

const config: Config = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testTimeout: TEST_TIMEOUT_MS,
    testMatch: ['**/suites/**/*.test.ts'],
    globalSetup: './helpers/global-setup.ts',
    globalTeardown: './helpers/global-teardown.ts',
    verbose: true,
};

export default config;
