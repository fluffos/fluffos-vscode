#!/usr/bin/env node
// Sync generated inputs from the pinned fluffos submodule, stage the
// extension, and package it.
//
// The extension SOURCE (extension.js, package.json, language config,
// README) lives in this repo under extension/. The language engine and
// grammar assets are OUTPUTS of the fluffos driver repo, taken from the
// submodule pin:
//
//   extension/lib/{tokenizer,format,lint}.mjs + lpc-grammar.json
//       <- fluffos/tools/lpc-syntax/  (the grammar-driven JS tooling)
//   extension/syntaxes/lpc.tmLanguage.json
//       <- fluffos/tools/lpc-syntax/lpc.tmLanguage.json
//          (older pins: tools/lpc-syntax/vscode/syntaxes/lpc.tmLanguage.json)
//
// Those synced paths are gitignored -- regenerated on every build, never
// edited, never committed.
//
// Steps:
//   1. Sync the generated inputs above into extension/ (also enables F5
//      "Run Extension" development directly on extension/).
//   2. Stage extension/ into out/extension/ (excluding *.vsix), patching
//      package.json: --version when given, plus a `fluffos.commit` field
//      recording the pin.
//   3. Write the MIT license text ("license": "MIT" in package.json) into
//      the stage so vsce ships a LICENSE file.
//   4. Run `npx @vscode/vsce package` -> out/fluffos-lpc-<version>.vsix
//      (skipped with --no-package, the only mode that works offline).
//
// Dependency-free by design (Node >= 18 + git; vsce is fetched by npx).
//
// Usage: node scripts/build.mjs [--version X.Y.Z] [--no-package]

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const toolsDir = path.join(repoRoot, 'fluffos', 'tools', 'lpc-syntax');
const extDir = path.join(repoRoot, 'extension');
const outDir = path.join(repoRoot, 'out');
const stageDir = path.join(outDir, 'extension');

// --- arguments ---------------------------------------------------------------

let version = null;
let doPackage = true;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--version') {
    version = process.argv[++i];
  } else if (a === '--no-package') {
    doPackage = false;
  } else {
    console.error(`unknown argument: ${a}`);
    process.exit(2);
  }
}
// vsce rejects semver prerelease/build suffixes, so only accept plain X.Y.Z.
if (version !== null && !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`--version must be plain X.Y.Z (vsce rejects suffixes), got: ${version}`);
  process.exit(2);
}

// --- sync generated inputs from the submodule ---------------------------------

if (!fs.existsSync(path.join(toolsDir, 'lpc-grammar.json'))) {
  console.error(`${toolsDir} not found -- init the submodule first:`);
  console.error('  git submodule update --init');
  process.exit(1);
}

const pinnedCommit = execFileSync('git', ['-C', path.join(repoRoot, 'fluffos'), 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();

const libDir = path.join(extDir, 'lib');
const synDir = path.join(extDir, 'syntaxes');
fs.rmSync(libDir, { recursive: true, force: true });
fs.rmSync(synDir, { recursive: true, force: true });
fs.mkdirSync(libDir, { recursive: true });
fs.mkdirSync(synDir, { recursive: true });

for (const name of ['tokenizer.mjs', 'format.mjs', 'lint.mjs']) {
  const header =
    `// GENERATED COPY of fluffos/tools/lpc-syntax/${name} at commit\n` +
    `// ${pinnedCommit} -- do not edit;\n` +
    `// re-run scripts/build.mjs (or change it upstream and bump the pin).\n`;
  fs.writeFileSync(path.join(libDir, name), header + fs.readFileSync(path.join(toolsDir, name), 'utf8'));
}
fs.copyFileSync(path.join(toolsDir, 'lpc-grammar.json'), path.join(libDir, 'lpc-grammar.json'));

// The TextMate grammar moved to the tools root when the extension moved out
// of the fluffos repo; older pins still have it under vscode/syntaxes/.
const tmCandidates = [
  path.join(toolsDir, 'lpc.tmLanguage.json'),
  path.join(toolsDir, 'vscode', 'syntaxes', 'lpc.tmLanguage.json'),
];
const tmSrc = tmCandidates.find((p) => fs.existsSync(p));
if (!tmSrc) {
  console.error(`lpc.tmLanguage.json not found in the pin (looked at:\n  ${tmCandidates.join('\n  ')})`);
  process.exit(1);
}
fs.copyFileSync(tmSrc, path.join(synDir, 'lpc.tmLanguage.json'));

console.log(`synced generated inputs from fluffos @ ${pinnedCommit}`);

// --- optional: bundle the wasm lpcc (zero-setup compiler) ---------------------
// Sources, first hit wins: $LPCC_WASM_DIR, or a wasm build inside the
// submodule (fluffos/build-wasm/src). When present, lpcc.js/lpcc.wasm land
// in extension/bin/ (gitignored) and ship in the vsix; the extension runs
// them through node when lpc.lpcc.path is unset.
const binDir = path.join(extDir, 'bin');
fs.rmSync(binDir, { recursive: true, force: true });
const wasmCandidates = [
  process.env.LPCC_WASM_DIR,
  path.join(repoRoot, 'fluffos', 'build-wasm', 'src'),
].filter(Boolean);
const wasmSrc = wasmCandidates.find(
  (d) => fs.existsSync(path.join(d, 'lpcc.js')) && fs.existsSync(path.join(d, 'lpcc.wasm')));
if (wasmSrc) {
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(path.join(wasmSrc, 'lpcc.js'), path.join(binDir, 'lpcc.js'));
  fs.copyFileSync(path.join(wasmSrc, 'lpcc.wasm'), path.join(binDir, 'lpcc.wasm'));
  console.log(`bundled wasm lpcc from ${wasmSrc}`);
} else {
  console.log('no wasm lpcc found (set LPCC_WASM_DIR or build the wasm preset in the submodule); packaging without a bundled compiler');
}

// --- stage -------------------------------------------------------------------

fs.rmSync(stageDir, { recursive: true, force: true });
fs.cpSync(extDir, stageDir, {
  recursive: true,
  filter: (src) => !src.endsWith('.vsix'),
});

const pkgPath = path.join(stageDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (version !== null) pkg.version = version;
pkg.fluffos = { commit: pinnedCommit };
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// package.json declares "license": "MIT"; vsce wants the file in the package.
const year = new Date().getFullYear();
fs.writeFileSync(
  path.join(stageDir, 'LICENSE.txt'),
  `MIT License

Copyright (c) ${year} FluffOS contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`);

console.log(`staged ${extDir}`);
console.log(`  -> ${stageDir}`);
console.log(`  version: ${pkg.version}, fluffos commit: ${pinnedCommit}`);

// The language server + client run from node_modules at runtime: install
// production deps into the stage so the vsix is self-contained.
if (doPackage) {
  execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'],
               { cwd: stageDir, stdio: 'inherit' });
}

// --- package -----------------------------------------------------------------

if (doPackage) {
  const vsix = path.join(outDir, `fluffos-lpc-${pkg.version}.vsix`);
  execFileSync('npx', ['--yes', '@vscode/vsce', 'package', '--out', vsix], {
    cwd: stageDir,
    stdio: 'inherit',
  });
  console.log(`packaged ${vsix}`);
}
