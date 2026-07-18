#!/usr/bin/env node
// Stage and package the LPC (FluffOS) VS Code extension from the pinned
// fluffos submodule.
//
// The extension's source of record is fluffos/tools/lpc-syntax/vscode in
// the fluffos repository (the submodule at ./fluffos). This script:
//
//   1. Copies that directory into out/extension/ (excluding *.vsix).
//   2. Patches the staged package.json: sets the release version when
//      --version is given, points `repository` at this packaging repo,
//      and records the pinned fluffos commit under a `fluffos` key.
//   3. Writes the MIT license text the upstream package.json declares
//      ("license": "MIT") into the stage so vsce ships a LICENSE file.
//   4. Runs `npx @vscode/vsce package` to produce
//      out/fluffos-lpc-<version>.vsix (skipped with --no-package).
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
const srcDir = path.join(repoRoot, 'fluffos', 'tools', 'lpc-syntax', 'vscode');
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

// --- stage -------------------------------------------------------------------

if (!fs.existsSync(path.join(srcDir, 'package.json'))) {
  console.error(`${srcDir} not found -- init the submodule first:`);
  console.error('  git submodule update --init');
  process.exit(1);
}

fs.rmSync(stageDir, { recursive: true, force: true });
fs.cpSync(srcDir, stageDir, {
  recursive: true,
  filter: (src) => !src.endsWith('.vsix'),
});

const pinnedCommit = execFileSync('git', ['-C', path.join(repoRoot, 'fluffos'), 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();

const pkgPath = path.join(stageDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (version !== null) pkg.version = version;
pkg.repository = { type: 'git', url: 'https://github.com/fluffos/fluffos-vscode' };
pkg.fluffos = { commit: pinnedCommit };
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// Upstream declares "license": "MIT" but ships no license file; vsce wants one
// in the package. This is the standard MIT text for that declaration.
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

console.log(`staged ${srcDir}`);
console.log(`  -> ${stageDir}`);
console.log(`  version: ${pkg.version}, fluffos commit: ${pinnedCommit}`);

// --- package -----------------------------------------------------------------

if (doPackage) {
  const vsix = path.join(outDir, `fluffos-lpc-${pkg.version}.vsix`);
  execFileSync('npx', ['--yes', '@vscode/vsce', 'package', '--out', vsix], {
    cwd: stageDir,
    stdio: 'inherit',
  });
  console.log(`packaged ${vsix}`);
}
