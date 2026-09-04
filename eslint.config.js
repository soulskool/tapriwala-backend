import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * ESLint flat config (ESLint 9).
 *
 * Type-aware linting is on, which is the point: without the type information
 * the useful rules here (floating promises, unsafe `any` flowing into a DB
 * write, misused `await`) cannot fire at all. It costs a few seconds per run.
 *
 *   npm run lint      report
 *   npm run lint:fix  fix what is mechanically fixable
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'logs/**', 'coverage/**', 'eslint.config.js'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },

    rules: {
      // ── Async correctness ────────────────────────────────────────────────
      // The rules that actually catch bugs in an Express + Mongoose codebase:
      // a forgotten `await` on a save() silently loses the write.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        // Express middleware signatures return void; passing an async handler
        // is the normal pattern here (asyncHandler wraps it).
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'warn',
      'no-return-await': 'off',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],

      // ── Type hygiene ─────────────────────────────────────────────────────
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unnecessary-condition': 'off',

      // Unused vars are an error, but a leading underscore marks a deliberate
      // one — Express error handlers must keep their 4th `_next` parameter.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],

      // ── Style / readability ──────────────────────────────────────────────
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': ['error', 'always'],
      curly: ['error', 'multi-line'],

      // console is fine in scripts; app code goes through the winston logger.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // Seed/CLI scripts legitimately print and exit.
  {
    files: ['src/scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  // Tests are looser: fixtures and API responses are untyped JSON by nature.
  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // Must come last: turns off every rule that would fight the formatter.
  prettier,
);
