// ESLint for the TypeScript in server, web and shared, run by `make check` after the type check. The type check already catches what types can, so this adds the rules types cannot see: unused code, hook order and dependencies in the wall, and the usual JavaScript traps.
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '.venv/**', 'out/**', 'data/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['server/**/*.ts', 'shared/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    // The two classic hook rules only. The plugin's recommended set now also carries the React Compiler rules (refs read during render, state set in effects, and so on). The wall does not use the compiler and leans on those patterns on purpose, such as the ranking's memory of each tile's tier, so they would flag working code by the dozen.
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: { globals: globals.node },
  },
);
