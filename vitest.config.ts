import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/.claude/**'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['lcov', 'html'],
    },
    reporters: ['default', 'junit'],
    outputFile: 'test-results.xml',
  },
})
