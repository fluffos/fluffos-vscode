#!/usr/bin/env node
// Extension-local checks: the hand-written extension source in extension/
// plus a smoke test of the synced language engine. The engine itself
// (tokenizer/formatter/linter/grammar) is tested by the fluffos repo's own
// suite -- run `node fluffos/tools/lpc-syntax/test.mjs` for that; this file
// only covers what lives HERE.
//
// Runs `scripts/build.mjs --no-package` first so extension/lib/ and
// extension/syntaxes/ are freshly synced from the submodule.
//
// Usage: node scripts/test.mjs

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extDir = path.join(repoRoot, 'extension');

execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'build.mjs'), '--no-package'], {
  stdio: 'inherit',
});

let failures = 0;
function check(name, ok) {
  console.log(`  ${ok ? 'OK ' : 'FAIL'} ${name}`);
  if (!ok) failures++;
}
const read = (p) => fs.readFileSync(path.join(extDir, p), 'utf8');

// --- extension manifest ------------------------------------------------------

const pkg = JSON.parse(read('package.json'));
check('package.json: name/publisher/main wiring',
      pkg.name === 'fluffos-lpc' && pkg.publisher === 'fluffos' && pkg.main === './extension.js');
check('package.json: contributes the lpc language + grammar + configuration',
      pkg.contributes.languages[0].id === 'lpc' &&
      pkg.contributes.grammars[0].scopeName === 'source.lpc' &&
      pkg.contributes.grammars[0].path === './syntaxes/lpc.tmLanguage.json' &&
      Object.keys(pkg.contributes.configuration.properties).length >= 7);
check('package.json: plain X.Y.Z version (vsce rejects suffixes)',
      /^\d+\.\d+\.\d+$/.test(pkg.version));

// --- extension source --------------------------------------------------------

const src = read('extension.js');
check('extension.js wires up the formatter',
      src.includes('registerDocumentFormattingEditProvider') && src.includes('formatLPC'));
check('extension.js wires up the linter and lpcc diagnostics',
      src.includes('lintLPC') && src.includes('lpcc'));

const langConfig = JSON.parse(read('language-configuration.json'));
check('language-configuration: brackets + doc-comment continuation wired',
      langConfig.brackets.length === 3 &&
      Array.isArray(langConfig.onEnterRules) && langConfig.onEnterRules.length > 0);

// --- synced engine smoke test --------------------------------------------------

const tml = JSON.parse(read('syntaxes/lpc.tmLanguage.json'));
check('synced tmLanguage: scope + patterns',
      tml.scopeName === 'source.lpc' && Array.isArray(tml.patterns));

const { lintLPC } = await import(pathToFileURL(path.join(extDir, 'lib', 'lint.mjs')).href);
const { formatLPC } = await import(pathToFileURL(path.join(extDir, 'lib', 'format.mjs')).href);
check('synced linter runs (unterminated string is caught)',
      lintLPC('string s = "abc;\n').length > 0 && lintLPC('int x = 1;\n').length === 0);
check('synced formatter runs (respaces an assignment)',
      formatLPC('int  f(){return   1;}\n').includes('int f()'));
check('synced lib files carry the generated-copy banner',
      ['tokenizer.mjs', 'format.mjs', 'lint.mjs'].every(
        (n) => read(`lib/${n}`).startsWith('// GENERATED COPY')));

console.log(failures === 0 ? '\nAll fluffos-vscode tests passed.' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
