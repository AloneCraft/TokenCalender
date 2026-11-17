import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'release/**', 'node_modules/**', 'tests/fixtures/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // 開発用スクリプトと試験は結果を標準出力へ出す
    files: ['scripts/**', 'tests/**'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-require-imports': 'off' },
  },
);
