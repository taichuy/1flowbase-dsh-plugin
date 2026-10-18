import { defineConfig } from 'vitest/config'

/**
 * Test-only configuration. Sources are Node ESM (host half) plus one React
 * client half, so the JSX runtime is explicit here: the test tree is not part
 * of either tsconfig program and would otherwise fall back to the classic
 * runtime.
 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
  },
})
