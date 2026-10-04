// Minimal flat config so `npx eslint src` runs. ESLint's recommended rules,
// read from the built-in rules' own metadata (what @eslint/js's
// configs.recommended is generated from) so no extra package is needed.
// Node's globals are listed by hand for the same reason.
const { builtinRules } = require('eslint/use-at-your-own-risk');

const recommendedRules = Object.fromEntries(
  [...builtinRules]
    .filter(([, rule]) => rule.meta?.docs?.recommended && !rule.meta.deprecated)
    .map(([name]) => [name, 'error'])
);

const nodeGlobals = Object.fromEntries([
  'process', 'console', 'Buffer', 'global', '__dirname', '__filename',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask',
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal', 'structuredClone',
  'fetch', 'FormData', 'Blob', 'Headers', 'Request', 'Response'
].map((name) => [name, 'readonly']));

module.exports = [
  // .kilo/ holds editor worktrees (full repo copies), not this repo's code.
  { ignores: ['.kilo/**'] },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: nodeGlobals
    },
    rules: recommendedRules
  }
];
