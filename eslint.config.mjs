import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/.next/**', '**/out/**', 'dist/**'] },
  ...tseslint.configs.recommended,
  { files: ['apps/desktop/**/*.cjs'], rules: { '@typescript-eslint/no-require-imports': 'off' } },
];
