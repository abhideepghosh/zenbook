import { builtinModules } from 'node:module'
import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

// The renderer is sandboxed: it reaches the filesystem only through window.zenbook.*
const nodeOnlyModules = [...builtinModules, ...builtinModules.map((m) => `node:${m}`), 'electron']

export default defineConfig(
  {
    ignores: ['out/**', 'dist/**', 'coverage/**', 'test-results/**', 'playwright-report/**'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // TypeScript already reports undefined names, with better type awareness.
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest']],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: nodeOnlyModules.map((name) => ({
            name,
            message: 'The renderer must not use Node or Electron APIs. Go through window.zenbook.*',
          })),
        },
      ],
    },
  },
)
