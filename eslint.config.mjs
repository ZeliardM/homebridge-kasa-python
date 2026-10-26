import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';

export default [{
  ignores: ['**/dist'],
},
js.configs.recommended,
...tseslint.configs.recommended,
{
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2018,
    sourceType: 'module',
  },

  plugins: {
    '@stylistic': stylistic,
  },

  rules: {
    '@stylistic/quotes': ['warn', 'single'],
    '@stylistic/indent': ['warn', 2, {
      SwitchCase: 1,
    }],
    '@stylistic/comma-dangle': ['warn', 'always-multiline'],
    'dot-notation': 'off',
    eqeqeq: 'warn',
    curly: ['warn', 'all'],
    '@stylistic/brace-style': ['warn'],
    'prefer-arrow-callback': ['warn'],
    '@stylistic/max-len': ['warn', 140],
    'no-console': ['warn'],
    'no-non-null-assertion': ['off'],
    '@stylistic/comma-spacing': ['error'],
    '@stylistic/no-multi-spaces': ['warn', {
      ignoreEOLComments: true,
    }],
    '@stylistic/no-trailing-spaces': ['warn'],
    'no-constant-condition': 'off',
    '@stylistic/lines-between-class-members': ['warn', 'always', {
      exceptAfterSingleLine: true,
    }],
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-unused-vars': ['error', {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
    }],
    '@stylistic/semi': ['warn'],
    '@stylistic/member-delimiter-style': ['warn', {
      multiline: {
        delimiter: 'semi',
        requireLast: true,
      },
      singleline: {
        delimiter: 'semi',
        requireLast: false,
      },
    }],
  },
}];