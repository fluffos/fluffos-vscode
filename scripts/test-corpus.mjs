#!/usr/bin/env node
// Corpus sweep: run the WHOLE fluffos testsuite (every .lpc/.c file)
// through the three layers -- the synced engine (tokenize/lint/outline),
// the lpcc JSON pipeline (compile every file, parse every model), and the
// live LSP server (didOpen + documentSymbol for every file). Hard-fails on
// crashes and model invariant violations; compile failures are EXPECTED
// for the deliberate fail-fixtures and are only tallied.
//
// Env: TESTSUITE=<fluffos testsuite dir> LPCC_BIN=<native lpcc>; skips
// cleanly when unset. Runtime is minutes (thousands of lpcc runs).
//
// Usage: TESTSUITE=... LPCC_BIN=... node scripts/test-corpus.mjs [--limit N]

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TESTSUITE = process.env.TESTSUITE;
const LPCC = process.env.LPCC_BIN;
if (!TESTSUITE || !LPCC) {
  console.log('  (skip) corpus sweep: set TESTSUITE and LPCC_BIN to run');
  process.exit(0);
}
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg >= 0 ? +process.argv[limitArg + 1] : Infinity;

// Raw-byte fixtures that must never be read as text (AGENTS.md §7).
const SKIP = new Set([
  'single/tests/compiler/fail/bad_utf8_string.lpc',
  'single/tests/compiler/fail/bad_utf8_arrayblock.lpc',
]);

const lpccMod = await import(pathToFileURL(path.join(repoRoot, 'extension', 'lpcc.js')).href);
const svc = lpccMod.default;
const { tokenize } = await import(pathToFileURL(path.join(repoRoot, 'extension', 'lib', 'tokenizer.mjs')).href);
const { lintLPC } = await import(pathToFileURL(path.join(repoRoot, 'extension', 'lib', 'lint.mjs')).href);

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs);
    else if (/\.(lpc|c)$/.test(e.name)) {
      const rel = path.relative(TESTSUITE, abs).split(path.sep).join('/');
      if (!SKIP.has(rel)) files.push(rel);
    }
  }
})(TESTSUITE);
files.sort();
const subset = files.slice(0, LIMIT);
console.log(`corpus: ${files.length} files (running ${subset.length})`);

let hardFailures = 0;
const problems = [];
function problem(file, what) {
  hardFailures++;
  problems.push(`  FAIL ${file}: ${what}`);
}

// --- Phase A: engine over every file (fast, in-process) ------------------------

let lintDiags = 0;
for (const rel of subset) {
  const src = fs.readFileSync(path.join(TESTSUITE, rel), 'utf8');
  try {
    const tokens = tokenize(src);
    // token stream must tile the file exactly
    let pos = 0;
    for (const t of tokens) {
      if (t.start !== pos) throw new Error(`token gap at offset ${pos}`);
      pos = t.end;
    }
    if (pos !== src.length) throw new Error(`token stream ends at ${pos}/${src.length}`);
    svc.outline(tokens);
    lintDiags += lintLPC(src).length;
  } catch (e) {
    problem(rel, 'engine: ' + e.message);
  }
}
console.log(`phase A (engine): ${subset.length} files tokenized+outlined, ${lintDiags} lint diagnostics, ${hardFailures} failures`);

// --- Phase B: lpcc JSON pipeline over every file -------------------------------

const s = { lpccPath: LPCC, configFile: 'etc/config.test', mudlibRoot: TESTSUITE };
let okCount = 0, failCount = 0, failNoDiag = 0, agree = 0, agreeChecked = 0;

async function sweepOne(rel) {
  const bc = await svc.runStageWithLog(s, rel, 'bytecodeJson');
  if (bc.ok) {
    okCount++;
    const model = svc.bytecodeFromJson(svc.parseEnvelopes(bc.raw));
    if (!model) return problem(rel, 'bytecodeJson: envelope missing on ok compile');
    for (const p of model.programs) {
      for (const fn of p.functions) {
        for (const ins of fn.instructions) {
          if (!ins.mnemonic) return problem(rel, `empty mnemonic at ${fn.name}+${ins.addr}`);
        }
      }
    }
    const ast = await svc.runStage(s, rel, 'astJson');
    if (ast.ok) {
      const a = svc.astFromJson(svc.parseEnvelopes(ast.raw));
      if (!a || a.sections.length !== 2) return problem(rel, 'astJson: bad sections');
      const walkN = (n) => {
        if (typeof n.label !== 'string' || n.label === '') throw new Error('empty AST label');
        n.children.forEach(walkN);
      };
      try { a.sections.forEach((sec) => sec.roots.forEach(walkN)); }
      catch (e) { return problem(rel, 'astJson: ' + e.message); }
    }
    // JSON-vs-text parity on a sample of the corpus
    if (agreeChecked < 40) {
      agreeChecked++;
      const txt = await svc.runStage(s, rel, 'bytecode');
      if (txt.ok) {
        const tm = svc.parseBytecode(txt.raw);
        const jn = model.functions.map((f) => f.name + ':' + f.instructions.length).join(',');
        const tn = tm.functions.map((f) => f.name + ':' + f.instructions.length).join(',');
        if (jn === tn) agree++;
        else problem(rel, `json/text disagree:\n    json ${jn}\n    text ${tn}`);
      }
    }
  } else {
    failCount++;
    if (bc.diagnostics.length === 0 &&
        !/Fail to load|must be loadable/.test(bc.stderr + bc.raw)) {
      failNoDiag++;
      problem(rel, 'failed compile with no diagnostics and no failure banner');
    }
  }
}

const queue = [...subset];
const workers = Array.from({ length: 8 }, async () => {
  for (;;) {
    const rel = queue.shift();
    if (!rel) return;
    try { await sweepOne(rel); }
    catch (e) { problem(rel, 'sweep: ' + e.message); }
  }
});
await Promise.all(workers);
try { fs.unlinkSync(path.join(TESTSUITE, 'trace_lpcc.json')); } catch (_e) { /* none */ }
console.log(`phase B (lpcc): ${okCount} compiled, ${failCount} failed (expected for fail/ fixtures), ` +
            `${failNoDiag} silent failures, json/text parity ${agree}/${agreeChecked}`);

// --- Phase C: the live LSP server over every file ------------------------------

const srv = spawn(process.execPath,
  [path.join(repoRoot, 'extension', 'server', 'main.js'), '--stdio'],
  { stdio: ['pipe', 'pipe', 'inherit'] });
let nextId = 1;
const pending = new Map();
let buf = Buffer.alloc(0);
srv.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const he = buf.indexOf('\r\n\r\n');
    if (he < 0) return;
    const len = +/Content-Length: (\d+)/.exec(buf.slice(0, he).toString())[1];
    if (buf.length < he + 4 + len) return;
    const msg = JSON.parse(buf.slice(he + 4, he + 4 + len).toString());
    buf = buf.slice(he + 4 + len);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
function send(o) {
  const t = JSON.stringify(o);
  srv.stdin.write(`Content-Length: ${Buffer.byteLength(t)}\r\n\r\n${t}`);
}
function request(method, params) {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, (m) => m.error ? rej(new Error(m.error.message)) : res(m.result));
    send({ jsonrpc: '2.0', id, method, params });
    setTimeout(() => { if (pending.has(id)) rej(new Error('timeout ' + method)); }, 30000);
  });
}

await request('initialize', {
  processId: process.pid, rootUri: pathToFileURL(TESTSUITE).href, capabilities: {},
  workspaceFolders: [{ uri: pathToFileURL(TESTSUITE).href, name: 't' }],
  initializationOptions: { settings: { lpcc: { path: LPCC, configFile: 'etc/config.test' } } },
});
send({ jsonrpc: '2.0', method: 'initialized', params: {} });

let symTotal = 0, lspProblems = 0;
for (const rel of subset) {
  const uri = pathToFileURL(path.join(TESTSUITE, rel)).href;
  const text = fs.readFileSync(path.join(TESTSUITE, rel), 'utf8');
  send({
    jsonrpc: '2.0', method: 'textDocument/didOpen',
    params: { textDocument: { uri, languageId: 'lpc', version: 1, text } },
  });
  try {
    const syms = await request('textDocument/documentSymbol', { textDocument: { uri } });
    symTotal += (syms || []).length;
  } catch (e) {
    lspProblems++;
    problem(rel, 'lsp documentSymbol: ' + e.message);
  }
  send({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } });
}
await request('shutdown');
send({ jsonrpc: '2.0', method: 'exit' });
srv.kill();
console.log(`phase C (lsp): ${subset.length} files opened+symbolized (${symTotal} symbols), ${lspProblems} failures`);

if (problems.length) console.log(problems.slice(0, 30).join('\n'));
console.log(hardFailures === 0 ? 'CORPUS SWEEP ALL OK' : `${hardFailures} CORPUS FAILURES`);
process.exit(hardFailures === 0 ? 0 : 1);
