// ESLint flat config (ESLint 10).
//
// Deliberately minimal: TypeScript is the contract, and the repo's own
// conventions (AGENTS.md) cover what a linter cannot (Tailwind-only styling,
// English commit messages). Rules the codebase intentionally violates are
// relaxed here rather than silenced inline, so the baseline stays meaningful.
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'server/dist/**',
      'node_modules/**',
      'coverage/**',
      'releases/**',
      'preview/**',
      'public/**',
      'server/web/**',
      'website/**',
      '*.config.js',
      '*.config.ts',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    rules: {
      // Unused args/vars prefixed with `_` are a deliberate "intentionally
      // unused" marker used throughout the engine hook signatures.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // The engine models heterogeneous tool payloads as `any` on purpose;
      // TS strict is enforced by `pnpm typecheck`, not by the linter.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      'no-console': 'off',
    },
  },
  {
    // Test files legitimately stub partial objects and use `any` heavily.
    files: ['tests/**/*.{ts,tsx}', 'server/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
)
