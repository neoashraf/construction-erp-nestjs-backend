/**
 * ESLint config — enforces the Clean/Hexagonal dependency rule (ADR-0002 §2.1, F5/F6).
 *
 * The DOMAIN layer must stay framework- and ORM-free:
 *   - `src/common/**`           (domain primitives, Money, value objects, ports, errors)
 *   - `src/**​/domain/**`        (each core/* and modules/* domain folder)
 * may import NEITHER `@nestjs/*` NOR `typeorm`. Enforced below via `no-restricted-imports`
 * (a core rule — no import-resolver plugin needed) and checked in CI.
 */
const forbidFramework = {
  patterns: [
    {
      group: ['@nestjs/*', '@nestjs'],
      message:
        'Dependency rule (ADR-0002 §2.1): the domain layer must not import NestJS. Move framework wiring to presentation/.',
    },
    {
      group: ['typeorm', 'typeorm/*'],
      message:
        'Dependency rule (ADR-0002 §2.1): the domain layer must not import TypeORM. Move persistence to infrastructure/.',
    },
  ],
};

module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    sourceType: 'module',
    tsconfigRootDir: __dirname,
  },
  plugins: ['@typescript-eslint'],
  extends: ['plugin:@typescript-eslint/recommended', 'prettier'],
  env: { node: true, jest: true },
  ignorePatterns: ['.eslintrc.js', 'dist/**', 'node_modules/**', 'jest.config.js'],
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
    'no-console': 'error',
  },
  overrides: [
    {
      // The domain layer (pure TypeScript) — no NestJS, no TypeORM.
      files: ['src/common/**/*.ts', 'src/**/domain/**/*.ts'],
      rules: {
        '@typescript-eslint/no-restricted-imports': ['error', forbidFramework],
      },
    },
    {
      files: ['**/*.spec.ts', '**/*.e2e-spec.ts', '**/*.int-spec.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
  ],
};
