import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Build output and generated bundles.
  globalIgnores(['**/dist/', 'release/', 'electron/server.cjs']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // `_`-prefixed names mark intentionally unused params/vars, including
      // `const { omitted: _x, ...rest } = obj` destructures.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
      // `try { ... } catch {}` is used deliberately for best-effort localStorage writes.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Server code runs on Node, not in the browser.
    files: ['server/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    // Tests stub request/response shapes; `any` is acceptable there.
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // Electron main/preload scripts are plain CommonJS.
    files: ['electron/**/*.cjs'],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
])
