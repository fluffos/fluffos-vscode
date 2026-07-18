// LPC language server (phase 2): standard LSP over the official
// vscode-languageserver library, serving every editor what the VS Code
// extension's in-process wiring served before -- structural lint, real
// lpcc compiler diagnostics, outline, formatting -- plus hover /
// definition / completion, and the custom lpc/* requests that power the
// Compiler Explorer as a pure renderer.
//
// All language knowledge comes from the SAME two sources as the
// extension: ../lpcc.js (the transport-agnostic pipeline service) and
// ../lib/* (the engine synced from the pinned fluffos submodule). This
// file is protocol plumbing only.
//
// Launch: node server/main.js --stdio   (or IPC when spawned by the
// vscode-languageclient with TransportKind.ipc).

'use strict';

const path = require('path');
const fs = require('fs');
const { pathToFileURL, fileURLToPath } = require('url');

const {
  createConnection, TextDocuments, TextDocumentSyncKind, DiagnosticSeverity,
  SymbolKind, CompletionItemKind, MarkupKind,
} = require('vscode-languageserver/node');
const { TextDocument } = require('vscode-languageserver-textdocument');
const lpcc = require('../lpcc.js');

const connection = createConnection();
const documents = new TextDocuments(TextDocument);

// --- engine (synced lib/) -----------------------------------------------------

let enginePromise = null;
function engine() {
  if (enginePromise === null) {
    const lib = (n) => pathToFileURL(path.join(__dirname, '..', 'lib', n)).href;
    enginePromise = Promise.all([
      import(lib('tokenizer.mjs')), import(lib('lint.mjs')), import(lib('format.mjs')),
    ]).then(([t, l, f]) => ({
      tokenize: t.tokenize, grammar: t.grammar, lintLPC: l.lintLPC, formatLPC: f.formatLPC,
    }));
  }
  return enginePromise;
}

// --- settings -----------------------------------------------------------------

// Full contents of the `lpc.*` configuration section, pushed by the client
// (initializationOptions.settings at startup, didChangeConfiguration after).
let settings = {};
let workspaceFolders = []; // fs paths

function docPath(doc) { return fileURLToPath(doc.uri); }

// Mirror of the extension's config.resolveLpccSettings(), vscode-free.
function resolveLpcc(doc) {
  const p = docPath(doc);
  let mudlibRoot = (settings.mudlibRoot || '').trim();
  if (!mudlibRoot) {
    mudlibRoot = workspaceFolders.find((w) => p.startsWith(w + path.sep)) || path.dirname(p);
  }
  let lpccPath = (settings.lpcc && settings.lpcc.path || '').trim();
  if (!lpccPath) {
    const bundled = path.join(__dirname, '..', 'bin', 'lpcc.js');
    if (fs.existsSync(bundled)) lpccPath = bundled;
  }
  let configFile = (settings.lpcc && settings.lpcc.configFile || '').trim();
  if (!configFile) {
    const scaffold = path.join(mudlibRoot, '.lpc', 'config');
    if (fs.existsSync(scaffold)) configFile = scaffold;
  }
  const relPath = path.relative(mudlibRoot, p).split(path.sep).join('/');
  const available = !!(lpccPath && configFile) && !relPath.startsWith('..');
  return { lpccPath, configFile, mudlibRoot, relPath, available };
}

// Include dirs from the driver config ("include directories : /a:/b",
// mudlib-absolute) -- used to resolve #include targets for definition.
function includeDirs(s) {
  try {
    // configFile may be mudlib-relative (lpcc runs with cwd=mudlibRoot).
    const cfg = path.isAbsolute(s.configFile) ? s.configFile : path.join(s.mudlibRoot, s.configFile);
    const m = /^include directories\s*:\s*(.+)$/m.exec(fs.readFileSync(cfg, 'utf8'));
    if (m) return m[1].trim().split(':').map((d) => d.trim()).filter(Boolean);
  } catch (_e) { /* no config */ }
  return ['/include'];
}

// --- positions ----------------------------------------------------------------
// The tokenizer's offsets are JS string indices == UTF-16 code units, which
// is exactly LSP's default position encoding: doc.positionAt/offsetAt align.

function rangeOf(doc, start, end) {
  return { start: doc.positionAt(start), end: doc.positionAt(end) };
}

// --- diagnostics --------------------------------------------------------------

const lintTimers = new Map();

async function runLint(doc) {
  if ((settings.lint && settings.lint.enabled) === false) {
    connection.sendDiagnostics({ uri: doc.uri, diagnostics: [] });
    return;
  }
  const { lintLPC } = await engine();
  const diagnostics = lintLPC(doc.getText()).map((d) => ({
    range: {
      start: { line: d.line - 1, character: d.col - 1 },
      end: {
        line: (d.endLine || d.line) - 1,
        character: (d.endCol > d.col || d.endLine > d.line ? d.endCol : d.col + 1) - 1,
      },
    },
    severity: d.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
    source: 'lpc-lint',
    message: d.message,
  }));
  connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

// lpcc diagnostics publish per-file (including #include'd files); remember
// which uris we touched so stale ones clear on the next run.
let lpccTouched = new Set();

async function runLpccDiagnostics(doc) {
  const s = resolveLpcc(doc);
  if (!s.available) return;
  const compile = await lpcc.runStageWithLog(s, s.relPath, 'bytecodeJson');
  const byUri = new Map();
  for (const d of compile.diagnostics) {
    const uri = pathToFileURL(path.join(s.mudlibRoot, d.file)).href;
    if (!byUri.has(uri)) byUri.set(uri, []);
    const arr = byUri.get(uri);
    if (arr.some((x) => x.message === d.message && x.range.start.line === d.line - 1)) continue;
    arr.push({
      range: {
        start: { line: d.line - 1, character: Math.max(0, d.col - 1) },
        end: { line: d.line - 1, character: Math.max(0, d.col) },
      },
      severity: d.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
      source: 'lpcc',
      message: d.message,
    });
  }
  const touched = new Set();
  for (const [uri, diagnostics] of byUri) {
    connection.sendDiagnostics({ uri, diagnostics });
    touched.add(uri);
  }
  for (const uri of lpccTouched) {
    if (!touched.has(uri) && uri !== doc.uri) connection.sendDiagnostics({ uri, diagnostics: [] });
  }
  lpccTouched = touched;
}

documents.onDidChangeContent((e) => {
  clearTimeout(lintTimers.get(e.document.uri));
  lintTimers.set(e.document.uri, setTimeout(() => runLint(e.document), 300));
});
documents.onDidOpen((e) => runLint(e.document));
documents.onDidSave((e) => { runLint(e.document); runLpccDiagnostics(e.document); });
documents.onDidClose((e) => {
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

// --- outline helpers ----------------------------------------------------------

async function outlineOf(doc) {
  const { tokenize } = await engine();
  const tokens = tokenize(doc.getText());
  return { tokens, outline: lpcc.outline(tokens) };
}

function tokenAt(tokens, offset) {
  return tokens.find((t) => t.start <= offset && offset < t.end);
}

// --- M1: symbols + formatting -------------------------------------------------

connection.onDocumentSymbol(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const { outline } = await outlineOf(doc);
  const sym = (name, kind, start, end, selStart, selEnd, detail) => ({
    name, kind, detail,
    range: rangeOf(doc, start, end),
    selectionRange: rangeOf(doc, selStart, selEnd),
  });
  return [
    ...outline.functions.map((f) =>
      sym(f.name, SymbolKind.Function, f.start, f.end, f.selStart, f.selEnd)),
    ...outline.variables.map((v) =>
      sym(v.name, SymbolKind.Variable, v.start, v.end, v.selStart, v.selEnd)),
    ...outline.inherits.map((i) =>
      sym('inherit ' + i.name, SymbolKind.Namespace, i.start, i.end, i.start, i.end)),
    ...outline.defines.map((d) =>
      sym(d.name, SymbolKind.Constant, d.start, d.end, d.start, d.end, '#define')),
  ];
});

connection.onDocumentFormatting(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  if ((settings.format && settings.format.enabled) === false) return null;
  const { formatLPC } = await engine();
  try {
    const formatted = formatLPC(doc.getText(), {
      printWidth: (settings.format && settings.format.printWidth) || 100,
      indentSize: (settings.format && settings.format.indentSize) || 2,
    });
    if (!formatted || formatted === doc.getText()) return [];
    return [{ range: rangeOf(doc, 0, doc.getText().length), newText: formatted }];
  } catch (_e) {
    return []; // a bad format never blocks the editor
  }
});

// --- M2: hover / definition / completion ---------------------------------------

connection.onHover(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const offset = doc.offsetAt(params.position);
  const { tokens, outline } = await outlineOf(doc);
  const tok = tokenAt(tokens, offset);
  if (!tok) return null;
  const word = tok.kind === 'directive' ? null : tok.text;

  const fn = word && outline.functions.find((f) => f.name === word);
  if (fn) {
    const line = doc.getText().slice(fn.start, doc.getText().indexOf('{', fn.start)).trim()
      .replace(/\s+/g, ' ');
    return { contents: { kind: MarkupKind.Markdown, value: '```lpc\n' + line + '\n```' } };
  }
  const def = word && outline.defines.find((d) => d.name === word);
  if (def) {
    const dtok = tokens.find((t) => t.kind === 'directive' && t.start === def.start);
    return {
      contents: { kind: MarkupKind.Markdown, value: '```lpc\n' + (dtok ? dtok.text : '#define ' + def.name) + '\n```' },
    };
  }
  const gv = word && outline.variables.find((v) => v.name === word);
  if (gv) {
    const lineText = doc.getText().split('\n')[doc.positionAt(gv.start).line].trim();
    return { contents: { kind: MarkupKind.Markdown, value: '```lpc\n' + lineText + '\n```' } };
  }
  return null;
});

connection.onDefinition(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const offset = doc.offsetAt(params.position);
  const { tokens, outline } = await outlineOf(doc);
  const tok = tokenAt(tokens, offset);
  if (!tok) return null;

  // #include "..." / <...> and inherit "..." -> the target file
  const s = resolveLpcc(doc);
  const asFile = (mudlibRel) => {
    for (const ext of ['', '.lpc', '.c', '.h']) {
      const abs = path.join(s.mudlibRoot, mudlibRel + ext);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        return { uri: pathToFileURL(abs).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
      }
    }
    return null;
  };
  if (tok.kind === 'directive' && /^#\s*include/.test(tok.text)) {
    const m = /[<"]([^>"]+)[>"]/.exec(tok.text);
    if (m) {
      if (m[1].startsWith('/')) return asFile(m[1]);
      const local = asFile(path.posix.join(path.posix.dirname('/' + s.relPath), m[1]));
      if (local) return local;
      for (const dir of includeDirs(s)) {
        const hit = asFile(path.posix.join(dir, m[1]));
        if (hit) return hit;
      }
    }
    return null;
  }
  if (tok.kind === 'string') {
    const prev = tokens.filter((t) => t.end <= tok.start && t.kind !== 'whitespace').pop();
    if (prev && prev.text === 'inherit') return asFile(tok.text.replace(/^"|"$/g, ''));
  }

  const word = tok.text;
  const hit = outline.functions.find((f) => f.name === word) ||
              outline.variables.find((v) => v.name === word) ||
              outline.defines.find((d) => d.name === word);
  if (hit) {
    return {
      uri: doc.uri,
      range: rangeOf(doc, hit.selStart != null ? hit.selStart : hit.start,
                     hit.selEnd != null ? hit.selEnd : hit.end),
    };
  }
  return null;
});

// The word under the cursor: an identifier token directly, or a word inside
// a directive token (`#define NAME ...` is ONE token -- the cursor on NAME
// must still resolve to it).
function wordAtOffset(tokens, offset) {
  const tok = tokenAt(tokens, offset);
  if (!tok) return null;
  if (tok.kind === 'identifier') return tok.text;
  if (tok.kind === 'directive') {
    const rel = offset - tok.start;
    const re = /[A-Za-z_][A-Za-z0-9_]*/g;
    let m;
    while ((m = re.exec(tok.text)) !== null) {
      if (m.index <= rel && rel < m.index + m[0].length) return m[0];
    }
  }
  return null;
}

// Lexical references within the document: every identifier token with the
// same spelling (comments and strings are other token kinds, so they never
// pollute the result). #define declarations live inside a directive token
// and are added separately.
function referenceSpans(tokens, outline, word) {
  const spans = tokens
    .filter((t) => t.kind === 'identifier' && t.text === word)
    .map((t) => ({ start: t.start, end: t.end, decl: false }));
  const fn = outline.functions.find((f) => f.name === word);
  if (fn && fn.selStart != null) {
    for (const s of spans) if (s.start === fn.selStart) s.decl = true;
  }
  const gv = outline.variables.find((v) => v.name === word);
  if (gv && gv.selStart != null) {
    for (const s of spans) if (s.start === gv.selStart) s.decl = true;
  }
  const def = outline.defines.find((d) => d.name === word);
  if (def) {
    const dtok = tokens.find((t) => t.kind === 'directive' && t.start === def.start);
    if (dtok) {
      const m = new RegExp('#\\s*define\\s+(' + word + ')\\b').exec(dtok.text);
      if (m) {
        const at = dtok.start + m.index + m[0].length - word.length;
        spans.push({ start: at, end: at + word.length, decl: true });
      }
    }
  }
  spans.sort((a, b) => a.start - b.start);
  return spans;
}

connection.onReferences(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const { tokens, outline } = await outlineOf(doc);
  const word = wordAtOffset(tokens, doc.offsetAt(params.position));
  if (!word) return null;
  const includeDecl = !params.context || params.context.includeDeclaration !== false;
  return referenceSpans(tokens, outline, word)
    .filter((s) => includeDecl || !s.decl)
    .map((s) => ({ uri: doc.uri, range: rangeOf(doc, s.start, s.end) }));
});

connection.onDocumentHighlight(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const { tokens, outline } = await outlineOf(doc);
  const word = wordAtOffset(tokens, doc.offsetAt(params.position));
  if (!word) return null;
  return referenceSpans(tokens, outline, word)
    .map((s) => ({ range: rangeOf(doc, s.start, s.end), kind: 1 /* Text */ }));
});

connection.onCompletion(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const { grammar } = await engine();
  const { outline } = await outlineOf(doc);
  const items = [];
  const push = (label, kind, detail) => items.push({ label, kind, detail });
  for (const f of outline.functions) push(f.name, CompletionItemKind.Function, 'function (this file)');
  for (const v of outline.variables) push(v.name, CompletionItemKind.Variable, 'global (this file)');
  for (const d of outline.defines) push(d.name, CompletionItemKind.Constant, '#define');
  for (const k of grammar.keywords || []) push(k, CompletionItemKind.Keyword, 'keyword');
  for (const t of grammar.typeKeywords || []) push(t, CompletionItemKind.Keyword, 'type');
  for (const m of grammar.modifierKeywords || []) push(m, CompletionItemKind.Keyword, 'modifier');
  return items;
});

// --- M3: Compiler Explorer model over LSP --------------------------------------
// lpc/model returns exactly what the extension's buildModel() assembled
// in-process: the webview (or any other editor's UI) is a pure renderer.

async function buildExplorerModel(doc) {
  const { tokenize } = await engine();
  const source = doc.getText();
  const tokens = tokenize(source);
  const model = {
    file: path.basename(docPath(doc)),
    source, tokens,
    outline: lpcc.outline(tokens),
    lpcc: { available: false },
  };
  const s = resolveLpcc(doc);
  model.file = s.relPath || model.file;
  if (!s.available) return model;
  const [pp, toksJ, astJ, bcJ, bcO0J] = await Promise.all([
    lpcc.runStage(s, s.relPath, 'preprocessed'),
    lpcc.runStage(s, s.relPath, 'tokensJson'),
    lpcc.runStage(s, s.relPath, 'astJson'),
    lpcc.runStage(s, s.relPath, 'bytecodeJson'),
    lpcc.runStage(s, s.relPath, 'bytecodeO0Json'),
  ]);
  let ctokens = lpcc.tokensFromJson(lpcc.parseEnvelopes(toksJ.raw));
  if (ctokens === null) {
    const t = await lpcc.runStage(s, s.relPath, 'tokens');
    ctokens = t.ok ? lpcc.parseTokens(t.raw) : [];
  }
  const astJson = lpcc.astFromJson(lpcc.parseEnvelopes(astJ.raw));
  let ast = astJson !== null ? astJson.sections : null;
  if (ast === null) {
    const a = await lpcc.runStage(s, s.relPath, 'ast');
    ast = a.ok ? lpcc.parseAst(a.raw) : [];
  }
  let bytecode = lpcc.bytecodeFromJson(lpcc.parseEnvelopes(bcJ.raw));
  let bytecodeO0 = lpcc.bytecodeFromJson(lpcc.parseEnvelopes(bcO0J.raw));
  let diagnostics = bcJ.diagnostics;
  if (bytecode === null) {
    const bt = await lpcc.runStage(s, s.relPath, 'bytecode');
    bytecode = bt.ok ? lpcc.parseBytecode(bt.raw) : null;
    diagnostics = bt.diagnostics;
    const b0 = await lpcc.runStage(s, s.relPath, 'bytecodeO0');
    bytecodeO0 = b0.ok ? lpcc.parseBytecode(b0.raw) : null;
  }
  model.lpcc = {
    available: true, relPath: s.relPath, json: astJson !== null,
    preprocessed: pp.ok ? lpcc.stripNoise(pp.raw) : null,
    tokens: ctokens, ast, bytecode, bytecodeO0, diagnostics,
  };
  return model;
}

function docFor(params) {
  return documents.get(params.uri || (params.textDocument && params.textDocument.uri));
}

connection.onRequest('lpc/model', async (params) => {
  const doc = docFor(params);
  return doc ? buildExplorerModel(doc) : null;
});
for (const [req, stage] of [
  ['lpc/tokens', 'tokensJson'], ['lpc/ast', 'astJson'],
  ['lpc/bytecode', 'bytecodeJson'], ['lpc/preprocessed', 'preprocessed'],
]) {
  connection.onRequest(req, async (params) => {
    const doc = docFor(params);
    if (!doc) return null;
    const s = resolveLpcc(doc);
    if (!s.available) return null;
    const r = await lpcc.runStage(s, s.relPath, stage);
    return { ok: r.ok, raw: r.raw, envelopes: lpcc.parseEnvelopes(r.raw), diagnostics: r.diagnostics };
  });
}
connection.onRequest('lpc/scaffold', (params) => lpcc.makeScaffoldFiles(params.mudlibRoot));

// --- lifecycle ----------------------------------------------------------------

connection.onInitialize((params) => {
  settings = (params.initializationOptions && params.initializationOptions.settings) || {};
  workspaceFolders = (params.workspaceFolders || [])
    .map((w) => { try { return fileURLToPath(w.uri); } catch (_e) { return null; } })
    .filter(Boolean);
  let pin = 'unknown';
  try {
    pin = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
      .fluffos?.commit || 'dev';
  } catch (_e) { /* dev tree */ }
  return {
    capabilities: {
      // Object form: `save: true` must be advertised or clients (incl. the
      // official one) never send didSave, and lpcc diagnostics never run.
      textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Full, save: true },
      documentSymbolProvider: true,
      documentFormattingProvider: true,
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentHighlightProvider: true,
      completionProvider: {},
    },
    serverInfo: { name: 'lpc-language-server', version: 'fluffos@' + pin },
  };
});

connection.onDidChangeConfiguration((change) => {
  settings = (change.settings && change.settings.lpc) || {};
  for (const doc of documents.all()) runLint(doc);
});

documents.listen(connection);
connection.listen();
