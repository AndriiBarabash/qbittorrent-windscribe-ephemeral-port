import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/', 'node_modules/'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2021,
        sourceType: 'module',
      },
    },
    rules: {
      'max-len': 'off',
      'comma-dangle': 'off',
      'indent': ['error', 2],
      'linebreak-style': 'off',
      'arrow-parens': ['warn', 'as-needed'],
      'operator-linebreak': ['error', 'before'],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
