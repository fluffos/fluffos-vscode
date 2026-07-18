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

// --- lpcc pipeline service (Compiler Explorer data layer) -----------------------
// Parsers are exercised against REAL lpcc output captured in scripts/fixtures/
// (see fixtures/sample.lpc; regenerate with a built lpcc: the four stage flags
// against testsuite/etc/config.test). Fixtures deliberately keep the driver's
// boot noise so the marker-based extraction is what's under test.

const lpccMod = await import(pathToFileURL(path.join(repoRoot, 'extension', 'lpcc.js')).href);
const lpccSvc = lpccMod.default;
const fixture = (n) => fs.readFileSync(path.join(repoRoot, 'scripts', 'fixtures', n), 'utf8');

const ptoks = lpccSvc.parseTokens(fixture('sample.tokens.txt'));
check('lpcc tokens: parsed with positions, boot noise skipped',
      ptoks.length > 50 && ptoks[0].line === 3 && ptoks[0].text === 'int' &&
      ptoks.every((t) => t.line > 0 && t.col > 0 && Number.isInteger(t.kind)));

const past = lpccSvc.parseAst(fixture('sample.ast.txt'));
check('lpcc ast: TREE_MAIN + TREE_INIT sections',
      past.length === 2 && past[0].title.includes('TREE_MAIN') && past[1].title.includes('TREE_INIT'));
check('lpcc ast: S-expressions parse ((void)-prefixed atoms stay atoms)',
      (() => {
        const flat = [];
        const walk = (n) => { flat.push(n.label); n.children.forEach(walk); };
        past.forEach((s) => s.roots.forEach(walk));
        return past[0].roots.length === 3 &&
               past[0].roots.every((r) => r.label === 'function') &&
               flat.includes('(void)assign_local') && flat.includes('loop_cond_number') &&
               !flat.includes('void)assign_local');
      })());

const pbc = lpccSvc.parseBytecode(fixture('sample.dis.txt'));
check('lpcc bytecode: header tables parsed',
      pbc.name === '/clone/explorer_sample.lpc' &&
      pbc.functionsTable.some((f) => f.name === 'greet') &&
      pbc.strings.some((s) => s.text === 'world') &&
      pbc.variables.length === 2);
check('lpcc bytecode: instructions carry addr/mnemonic and trailing src annotations',
      (() => {
        const greet = pbc.functions.find((f) => f.name === 'greet');
        if (!greet) return false;
        const branch = greet.instructions.find((i) => i.mnemonic === 'branch_when_zero');
        return branch && branch.target === '0012' &&
               branch.srcFile === 'clone/explorer_sample.lpc' && branch.srcLine === 9;
      })());
check('lpcc bytecode: address->line table parsed',
      pbc.addressLines.length > 0 && pbc.addressLines.every((r) => r.absLine > 0));

check('lpcc diagnostics: clang-style lines extracted from mixed output',
      lpccSvc.parseDiagnostics(fixture('sample.dis.txt')).length === 4);

check('lpcc -E: boot/tracer noise stripped',
      (() => {
        const pp = lpccSvc.stripNoise(fixture('sample.pp.txt'));
        return pp.startsWith('int counter') && !/Trace duration|Processing config/.test(pp);
      })());

// --json envelopes (fluffos >= 2026-07): token names + AST source lines.
const jt = lpccSvc.tokensFromJson(lpccSvc.parseEnvelopes(fixture('sample.tokens-json.txt')));
check('lpcc --json tokens: names + positions',
      jt !== null && jt.length === 95 && jt[0].name === 'L_BASIC_TYPE' && jt[0].text === 'int' &&
      jt.every((t) => typeof t.name === 'string' && t.line > 0));

const jast = lpccSvc.astFromJson(lpccSvc.parseEnvelopes(fixture('sample.ast-json.txt')));
check('lpcc --json ast: sections, resolved string literals',
      jast !== null && jast.sections.length === 2 &&
      jast.sections[0].roots.length === 3 &&
      (() => { // (string 4) resolves to "hello " somewhere under greet
        let found = false;
        const walk = (n) => { if (n.str === 'hello ') found = true; n.children.forEach(walk); };
        jast.sections[0].roots.forEach(walk);
        return found;
      })());
check('lpcc --json ast: absolute lines resolve through include segments',
      (() => { // add()'s "+" node: absolute 74 -> clone/explorer_sample.lpc:6
        let hit = null;
        const walk = (n) => { if (n.label === '+' && !hit) hit = n; n.children.forEach(walk); };
        walk(jast.sections[0].roots[0]);
        return hit && hit.src && hit.src.file === 'clone/explorer_sample.lpc' && hit.src.line === 6;
      })());

// outline() drives document symbols/breadcrumbs and AST/bytecode anchoring.
const { tokenize } = await import(pathToFileURL(path.join(extDir, 'lib', 'tokenizer.mjs')).href);
const sampleSrc = fixture('sample.lpc');
const o = lpccSvc.outline(tokenize(sampleSrc));
check('outline: functions in definition order with body ranges',
      o.functions.map((f) => f.name).join(',') === 'add,greet,create' &&
      o.functions.every((f) => f.end > f.start && f.selEnd > f.selStart));
check('outline: globals and #defines found, locals not',
      o.variables.map((v) => v.name).join(',') === 'counter,name' &&
      o.defines.map((d) => d.name).join(',') === 'GREET');

console.log(failures === 0 ? '\nAll fluffos-vscode tests passed.' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
