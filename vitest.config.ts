import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['test/**/*.test.ts'],
        exclude: ['test/fixtures/**', 'dist/**', 'node_modules/**'],
        clearMocks: true,
        reporters: 'default',
    },
});