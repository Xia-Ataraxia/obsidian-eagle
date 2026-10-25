import { resolve } from 'node:path'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/.claude/**'],
    alias: {
      obsidian: resolve(import.meta.dirname, 'test/mocks/obsidian.ts'),
    },
    coverage: {
      provider: 'v8',
      reporter: ['lcov', 'html'],
    },
    setupFiles: ['test/setup-window.ts'],
    reporters: ['default', 'junit'],
    outputFile: 'test-results.xml',
  },
})
