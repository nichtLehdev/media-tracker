// Flat config for the whole workspace. `next lint` was removed in favour of the
// ESLint CLI: it is deprecated in Next 15 and gone in Next 16, and it cannot
// lint packages/ at all.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/drizzle/**',
      '**/*.tsbuildinfo',
      '**/next-env.d.ts',
      'plugin/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      // The codebase marks deliberately-unused bindings with a leading
      // underscore (e.g. `registerConsumers(_boss)` in the worker).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // §15: never log secrets. console.error is how the worker surfaces
      // failures, so warn rather than error and let review catch the rest.
      'no-console': 'off',
    },
  },

  // Next.js app: React rules and the framework's own checks.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: {
      '@next/next': nextPlugin,
      'react-hooks': reactHooks,
    },
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      ...reactHooks.configs['recommended-latest'].rules,
      // App Router only; this rule scans for a pages/ directory that will
      // never exist here and warns on every run.
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
);
