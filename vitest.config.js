import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'happy-dom',
        include: ['test/components.test.js', 'test/models.test.js'],
        exclude: ['test/parser.test.js', 'test/e2e/**', 'node_modules/**'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html', 'json-summary'],
            reportsDirectory: './coverage-components',
            include: [
                'lib/**/*.js'
            ],
            exclude: [
                'node_modules/**',
                'public/**'
            ],
            all: false
        },
        globals: true,
        setupFiles: ['./test/setup.js']
    }
});
