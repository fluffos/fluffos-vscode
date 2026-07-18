#!/usr/bin/env node
// Protocol-level LSP harness: spawns the REAL server over stdio and drives
// it with a minimal JSON-RPC client (hand-rolled HERE only -- the server
// uses the official vscode-languageserver library). Assumes
// extension/lib/ is synced and extension/node_modules installed (both
// ensured by scripts/test.mjs, which runs this file).
//
// With LPCC_BIN set, additionally scaffolds a temp mudlib and exercises
// the real-compiler paths: lpcc diagnostics on save and the lpc/model
// Compiler Explorer request.

'use strict';

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverPath = path.join(repoRoot, 'extension', 'server', 'main.js');

let failures = 0;
function check(name, ok) {
  console.log(`  ${ok ? 'OK ' : 'FAIL'} lsp: ${name}`);
  if (!ok) failures++;
}

// --- tiny JSON-RPC-over-stdio client -----------------------------------------

const srv = spawn(process.execPath, [serverPath, '--stdio'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
let nextId = 1;
const pending = new Map();     // id -> resolve
const notifications = [];      // {method, params}
const notifyWaiters = [];      // {predicate, resolve}

let buf = Buffer.alloc(0);
srv.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const m = /Content-Length: (\d+)/.exec(buf.slice(0, headerEnd).toString());
    const len = +m[1];
    if (buf.length < headerEnd + 4 + len) return;
    const msg = JSON.parse(buf.slice(headerEnd + 4, headerEnd + 4 + len).toString());
    buf = buf.slice(headerEnd + 4 + len);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      notifications.push(msg);
      for (let i = notifyWaiters.length - 1; i >= 0; i--) {
        if (notifyWaiters[i].predicate(msg)) {
          notifyWaiters[i].resolve(msg);
          notifyWaiters.splice(i, 1);
        }
      }
    }
  }
});

function send(obj) {
  const s = JSON.stringify(obj);
  srv.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
}
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, (msg) => msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result));
    send({ jsonrpc: '2.0', id, method, params });
    setTimeout(() => { if (pending.has(id)) reject(new Error('timeout: ' + method)); }, 30000);
  });
}
function notify(method, params) { send({ jsonrpc: '2.0', method, params }); }
function waitNotify(predicate, ms = 30000) {
  const hit = notifications.find(predicate);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    notifyWaiters.push({ predicate, resolve });
    setTimeout(() => reject(new Error('timeout waiting for notification')), ms);
  });
}

// --- the run ------------------------------------------------------------------

const mudlib = fs.mkdtempSync(path.join(os.tmpdir(), 'lpc-lsp-'));
const lpccBin = process.env.LPCC_BIN || '';
if (lpccBin) {
  const lpccMod = await import(pathToFileURL(path.join(repoRoot, 'extension', 'lpcc.js')).href);
  for (const [rel, content] of Object.entries(lpccMod.default.makeScaffoldFiles(mudlib))) {
    fs.mkdirSync(path.dirname(path.join(mudlib, rel)), { recursive: true });
    fs.writeFileSync(path.join(mudlib, rel), content);
  }
}

const init = await request('initialize', {
  processId: process.pid,
  rootUri: pathToFileURL(mudlib).href,
  workspaceFolders: [{ uri: pathToFileURL(mudlib).href, name: 'mudlib' }],
  capabilities: {},
  initializationOptions: {
    settings: lpccBin ? { lpcc: { path: lpccBin, configFile: path.join(mudlib, '.lpc', 'config') } } : {},
  },
});
check('initialize: capabilities advertised',
      init.capabilities.documentSymbolProvider === true &&
      init.capabilities.hoverProvider === true &&
      init.capabilities.definitionProvider === true &&
      init.capabilities.referencesProvider === true &&
      init.capabilities.documentHighlightProvider === true &&
      init.capabilities.textDocumentSync.save === true &&
      /^lpc-language-server$/.test(init.serverInfo.name));
notify('initialized', {});

const sampleSrc = fs.readFileSync(path.join(repoRoot, 'scripts', 'fixtures', 'sample.lpc'), 'utf8');
const samplePath = path.join(mudlib, 'sample.lpc');
fs.writeFileSync(samplePath, sampleSrc);
const sampleUri = pathToFileURL(samplePath).href;

// diagnostics: open a broken doc, expect a structural lint hit
const badUri = pathToFileURL(path.join(mudlib, 'bad.lpc')).href;
notify('textDocument/didOpen', {
  textDocument: { uri: badUri, languageId: 'lpc', version: 1, text: 'string s = "abc;\n' },
});
const lintDiag = await waitNotify((n) =>
  n.method === 'textDocument/publishDiagnostics' && n.params.uri === badUri &&
  n.params.diagnostics.length > 0);
check('publishDiagnostics: structural lint on open',
      lintDiag.params.diagnostics[0].source === 'lpc-lint');

// ... and that a fix clears them
notify('textDocument/didChange', {
  textDocument: { uri: badUri, version: 2 },
  contentChanges: [{ text: 'int x = 1;\n' }],
});
await waitNotify((n) =>
  n.method === 'textDocument/publishDiagnostics' && n.params.uri === badUri &&
  n.params.diagnostics.length === 0);
check('publishDiagnostics: lint clears after fix', true);

// open the sample for the language features
notify('textDocument/didOpen', {
  textDocument: { uri: sampleUri, languageId: 'lpc', version: 1, text: sampleSrc },
});

const symbols = await request('textDocument/documentSymbol', { textDocument: { uri: sampleUri } });
check('documentSymbol: functions + globals + defines',
      symbols.some((s) => s.name === 'greet') && symbols.some((s) => s.name === 'counter') &&
      symbols.some((s) => s.name === 'GREET'));

const fmt = await request('textDocument/formatting', {
  textDocument: { uri: sampleUri }, options: { tabSize: 2, insertSpaces: true },
});
check('formatting: returns edits (or clean no-op)', Array.isArray(fmt));

// hover over the GREET usage (line 9 col 17 in sample.lpc: `msg = GREET + ...`)
const greetUse = sampleSrc.split('\n').findIndex((l) => l.includes('GREET + '));
const hov = await request('textDocument/hover', {
  textDocument: { uri: sampleUri },
  position: { line: greetUse, character: sampleSrc.split('\n')[greetUse].indexOf('GREET') + 1 },
});
check('hover: #define shows its definition',
      hov && hov.contents.value.includes('#define GREET'));

// definition of add() from its call site in greet()
const callLine = sampleSrc.split('\n').findIndex((l) => l.includes('add(i, 1)'));
const def = await request('textDocument/definition', {
  textDocument: { uri: sampleUri },
  position: { line: callLine, character: sampleSrc.split('\n')[callLine].indexOf('add(') + 1 },
});
check('definition: add() call resolves to its declaration',
      def && def.uri === sampleUri && def.range.start.line ===
        sampleSrc.split('\n').findIndex((l) => l.startsWith('int add')));

// references: add() has exactly its declaration + one call site
const addCol = sampleSrc.split('\n')[callLine].indexOf('add(') + 1;
const refs = await request('textDocument/references', {
  textDocument: { uri: sampleUri },
  position: { line: callLine, character: addCol },
  context: { includeDeclaration: true },
});
const addDeclLine = sampleSrc.split('\n').findIndex((l) => l.startsWith('int add'));
check('references: add() -> declaration + call site',
      refs && refs.length === 2 &&
      refs.some((r) => r.range.start.line === addDeclLine) &&
      refs.some((r) => r.range.start.line === callLine));
const refsNoDecl = await request('textDocument/references', {
  textDocument: { uri: sampleUri },
  position: { line: callLine, character: addCol },
  context: { includeDeclaration: false },
});
check('references: includeDeclaration=false drops the declaration',
      refsNoDecl && refsNoDecl.length === 1 && refsNoDecl[0].range.start.line === callLine);

// references from INSIDE the #define directive (the whole line is one token)
const refG = await request('textDocument/references', {
  textDocument: { uri: sampleUri },
  position: { line: 0, character: sampleSrc.split('\n')[0].indexOf('GREET') + 2 },
  context: { includeDeclaration: true },
});
check('references: #define name from the directive itself',
      refG && refG.length === 2 &&
      refG.some((r) => r.range.start.line === 0) &&
      refG.some((r) => r.range.start.line === greetUse));

// documentHighlight: counter = declaration + two uses
const counterLine = sampleSrc.split('\n').findIndex((l) => l.includes('counter +='));
const hl = await request('textDocument/documentHighlight', {
  textDocument: { uri: sampleUri },
  position: { line: counterLine, character: sampleSrc.split('\n')[counterLine].indexOf('counter') + 1 },
});
check('documentHighlight: counter declaration + 2 uses', hl && hl.length === 3);

// definition on #include / inherit targets (no compiler needed: workspace
// mudlib root + the default /include dir)
fs.mkdirSync(path.join(mudlib, 'include'), { recursive: true });
fs.writeFileSync(path.join(mudlib, 'include', 'inc.h'), '#define FROM_INC 1\n');
fs.writeFileSync(path.join(mudlib, 'base.lpc'), 'int base_fn() { return 1; }\n');
const navSrc = '#include <inc.h>\n#include "include/inc.h"\ninherit "/base";\nint f() { return FROM_INC; }\n';
const navUri = pathToFileURL(path.join(mudlib, 'nav.lpc')).href;
notify('textDocument/didOpen', {
  textDocument: { uri: navUri, languageId: 'lpc', version: 1, text: navSrc },
});
const incHUri = pathToFileURL(path.join(mudlib, 'include', 'inc.h')).href;
const incDef = await request('textDocument/definition', {
  textDocument: { uri: navUri }, position: { line: 0, character: 12 },
});
check('definition: #include <...> resolves via include dirs',
      incDef && incDef.uri === incHUri);
const incDef2 = await request('textDocument/definition', {
  textDocument: { uri: navUri }, position: { line: 1, character: 14 },
});
check('definition: #include "..." resolves mudlib-relative',
      incDef2 && incDef2.uri === incHUri);
const inhDef = await request('textDocument/definition', {
  textDocument: { uri: navUri }, position: { line: 2, character: 10 },
});
check('definition: inherit "/base" resolves extension-less to base.lpc',
      inhDef && inhDef.uri === pathToFileURL(path.join(mudlib, 'base.lpc')).href);

const comp = await request('textDocument/completion', {
  textDocument: { uri: sampleUri }, position: { line: greetUse, character: 2 },
});
check('completion: document symbols + grammar keywords',
      comp.some((c) => c.label === 'greet') && comp.some((c) => c.label === 'foreach'));

// --- real-compiler paths (LPCC_BIN only) --------------------------------------
if (lpccBin) {
  // a file whose only error is a compile-time one (lint can't see it)
  const cUri = pathToFileURL(path.join(mudlib, 'cerr.lpc')).href;
  const cSrc = '#include "missing.h"\nint f() { return 1; }\n';
  fs.writeFileSync(path.join(mudlib, 'cerr.lpc'), cSrc);
  notify('textDocument/didOpen', {
    textDocument: { uri: cUri, languageId: 'lpc', version: 1, text: cSrc },
  });
  notify('textDocument/didSave', { textDocument: { uri: cUri } });
  const cd = await waitNotify((n) =>
    n.method === 'textDocument/publishDiagnostics' && n.params.uri === cUri &&
    n.params.diagnostics.some((d) => d.source === 'lpcc'));
  check('lpcc diagnostics on save (real compiler)',
        cd.params.diagnostics.some((d) => /include/i.test(d.message)));

  const model = await request('lpc/model', { uri: sampleUri });
  check('lpc/model: full Explorer model over LSP',
        model.lpcc.available === true &&
        model.outline.functions.map((f) => f.name).join(',') === 'add,greet,create' &&
        model.lpcc.bytecode.functions.some((f) => f.name === 'greet') &&
        model.lpcc.ast.length === 2);
} else {
  console.log('  (skip) lsp real-compiler paths: set LPCC_BIN to run');
}

await request('shutdown');
notify('exit');
srv.kill();
fs.rmSync(mudlib, { recursive: true, force: true });

console.log(failures === 0 ? 'LSP harness passed.' : `${failures} LSP FAILURES`);
process.exit(failures === 0 ? 0 : 1);
