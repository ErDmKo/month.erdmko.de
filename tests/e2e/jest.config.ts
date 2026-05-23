import type { Config } from 'jest';

const config: Config = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testTimeout: 30000,
    testMatch: ['**/suites/**/*.test.ts'],
    globalSetup: './helpers/global-setup.ts',
    globalTeardown: './helpers/global-teardown.ts',
    verbose: true,
};

export default config;
