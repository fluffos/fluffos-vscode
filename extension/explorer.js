// LPC Compiler Explorer: a per-file webview with Source / Tokens / AST /
// Bytecode / Preprocessed views of the compile pipeline, breadcrumbs, an
// AST graph, and click-through links back to the source.
//
// Layering contract (phase-2 LSP): this file is the RENDERER. All data
// acquisition and parsing lives in lpcc.js (transport-agnostic) so it can
// move into the language server later; this webview would then consume the
// same models over custom LSP requests instead of calling lpcc.js directly.

'use strict';

const vscode = require('vscode');
const path = require('path');
const { pathToFileURL } = require('url');
const lpcc = require('./lpcc.js');

const panels = new Map(); // doc uri string -> ExplorerPanel

let tokenizePromise = null;
function loadTokenizer(ctx) {
  if (tokenizePromise === null) {
    const url = pathToFileURL(path.join(ctx.extensionPath, 'lib', 'tokenizer.mjs')).href;
    tokenizePromise = import(url).then((m) => m.tokenize);
  }
  return tokenizePromise;
}

function lpccSettings(doc) {
  const cfg = vscode.workspace.getConfiguration('lpc', doc.uri);
  const lpccPath = cfg.get('lpcc.path', '');
  const configFile = cfg.get('lpcc.configFile', '');
  let mudlibRoot = cfg.get('mudlibRoot', '');
  if (!mudlibRoot) {
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    mudlibRoot = folder ? folder.uri.fsPath : path.dirname(doc.uri.fsPath);
  }
  const relPath = path.relative(mudlibRoot, doc.uri.fsPath).split(path.sep).join('/');
  const available = !!(lpccPath && configFile) && !relPath.startsWith('..');
  return { lpccPath, configFile, mudlibRoot, relPath, available };
}

async function buildModel(ctx, doc) {
  const tokenize = await loadTokenizer(ctx);
  const source = doc.getText();
  const tokens = tokenize(source);
  const model = {
    file: vscode.workspace.asRelativePath(doc.uri),
    source,
    tokens,
    outline: lpcc.outline(tokens),
    lpcc: { available: false },
  };
  const s = lpccSettings(doc);
  if (s.available) {
    // Prefer the --json stages (token names, AST source lines); older lpcc
    // rejects --json, so fall back to parsing the human text formats.
    const [pp, toksJ, astJ, bytecode, bytecodeO0] = await Promise.all([
      lpcc.runStage(s, s.relPath, 'preprocessed'),
      lpcc.runStage(s, s.relPath, 'tokensJson'),
      lpcc.runStage(s, s.relPath, 'astJson'),
      lpcc.runStage(s, s.relPath, 'bytecode'),
      lpcc.runStage(s, s.relPath, 'bytecodeO0'),
    ]);
    let tokens = lpcc.tokensFromJson(lpcc.parseEnvelopes(toksJ.raw));
    if (tokens === null) {
      const t = await lpcc.runStage(s, s.relPath, 'tokens');
      tokens = t.ok ? lpcc.parseTokens(t.raw) : [];
    }
    const astJson = lpcc.astFromJson(lpcc.parseEnvelopes(astJ.raw));
    let ast;
    if (astJson !== null) {
      ast = astJson.sections;
    } else {
      const a = await lpcc.runStage(s, s.relPath, 'ast');
      ast = a.ok ? lpcc.parseAst(a.raw) : [];
    }
    model.lpcc = {
      available: true,
      relPath: s.relPath,
      json: astJson !== null,
      preprocessed: pp.ok ? lpcc.stripNoise(pp.raw) : null,
      tokens,
      ast,
      bytecode: bytecode.ok ? lpcc.parseBytecode(bytecode.raw) : null,
      bytecodeO0: bytecodeO0.ok ? lpcc.parseBytecode(bytecodeO0.raw) : null,
      diagnostics: bytecode.diagnostics,
    };
  }
  return model;
}

class ExplorerPanel {
  constructor(ctx, doc) {
    this.ctx = ctx;
    this.docUri = doc.uri;
    this.panel = vscode.window.createWebviewPanel(
      'lpcExplorer', `LPC Explorer — ${path.basename(doc.uri.fsPath)}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true });
    this.panel.webview.html = webviewHtml(this.panel.webview);
    this.disposables = [];

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);

    vscode.workspace.onDidSaveTextDocument((d) => {
      if (d.uri.toString() === this.docUri.toString()) this.refresh();
    }, null, this.disposables);

    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor.document.uri.toString() !== this.docUri.toString()) return;
      const doc = e.textEditor.document;
      const pos = e.selections[0].active;
      this.panel.webview.postMessage({
        type: 'cursor', offset: doc.offsetAt(pos), line: pos.line + 1, col: pos.character + 1,
      });
    }, null, this.disposables);
  }

  async onMessage(msg) {
    if (msg.type === 'ready' || msg.type === 'refresh') return this.refresh();
    if (msg.type === 'reveal') {
      const doc = await vscode.workspace.openTextDocument(this.docUri);
      const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.One, preserveFocus: false,
      });
      const start = new vscode.Position(Math.max(0, (msg.line || 1) - 1), Math.max(0, (msg.col || 1) - 1));
      const end = msg.endLine
        ? new vscode.Position(msg.endLine - 1, Math.max(0, (msg.endCol || 1) - 1))
        : start;
      editor.selection = new vscode.Selection(start, end);
      editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      return;
    }
    if (msg.type === 'openFile') {
      // mudlib-relative path from a "; file:line" bytecode annotation
      const s = lpccSettings(await vscode.workspace.openTextDocument(this.docUri));
      const abs = path.join(s.mudlibRoot, msg.file);
      try {
        const doc = await vscode.workspace.openTextDocument(abs);
        const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
        const pos = new vscode.Position(Math.max(0, (msg.line || 1) - 1), 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      } catch (_e) {
        vscode.window.showWarningMessage(`LPC Explorer: cannot open ${msg.file}`);
      }
      return;
    }
  }

  async refresh() {
    try {
      const doc = await vscode.workspace.openTextDocument(this.docUri);
      const model = await buildModel(this.ctx, doc);
      this.panel.webview.postMessage({ type: 'model', model });
    } catch (err) {
      this.panel.webview.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
  }

  dispose() {
    panels.delete(this.docUri.toString());
    for (const d of this.disposables) d.dispose();
  }
}

function openExplorer(ctx) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'lpc') {
    vscode.window.showInformationMessage('LPC Explorer: open an LPC file first.');
    return;
  }
  const key = editor.document.uri.toString();
  let p = panels.get(key);
  if (p) {
    p.panel.reveal();
  } else {
    p = new ExplorerPanel(ctx, editor.document);
    panels.set(key, p);
  }
}

function nonceStr() {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function webviewHtml(webview) {
  const nonce = nonceStr();
  // Self-contained: CSP allows only our inline nonce'd script/style.
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { font-family: var(--vscode-editor-font-family, monospace); font-size: 13px;
         color: var(--vscode-editor-foreground); background: var(--vscode-editor-background);
         margin: 0; padding: 0; }
  #crumbs { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: 4px;
            flex-wrap: wrap; padding: 5px 10px; font-size: 12px;
            background: var(--vscode-breadcrumb-background, var(--vscode-editor-background));
            color: var(--vscode-breadcrumb-foreground, inherit);
            border-bottom: 1px solid var(--vscode-panel-border, #8883); }
  #crumbs .crumb { cursor: pointer; }
  #crumbs .crumb:hover { color: var(--vscode-breadcrumb-focusForeground, inherit); text-decoration: underline; }
  #crumbs .sep { opacity: .5; }
  #tabs { position: sticky; top: 27px; z-index: 3; display: flex; gap: 2px; padding: 4px 8px 0;
          background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border, #8883); }
  #tabs button { border: none; cursor: pointer; padding: 5px 12px; font: inherit;
                 color: var(--vscode-foreground); background: transparent;
                 border-bottom: 2px solid transparent; opacity: .75; }
  #tabs button.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder, #07f); }
  #tabs button:hover { opacity: 1; }
  #content { padding: 8px 10px 40px; }
  .muted { opacity: .65; }
  .hint { padding: 10px; border: 1px dashed var(--vscode-panel-border, #8886); border-radius: 4px; margin: 8px 0; }
  code, pre { font-family: var(--vscode-editor-font-family, monospace); }
  pre { line-height: 1.45; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; font-weight: 600; padding: 2px 10px 2px 0; border-bottom: 1px solid var(--vscode-panel-border, #8883); }
  td { padding: 1px 10px 1px 0; vertical-align: top; white-space: pre; }
  tr.rowlink { cursor: pointer; }
  tr.rowlink:hover, tr.hl { background: var(--vscode-editor-selectionHighlightBackground, #07f3); }
  /* source view */
  #src { white-space: pre; }
  #src span[data-s] { cursor: pointer; }
  #src span[data-s]:hover { text-decoration: underline; }
  #src .cursor-hl { background: var(--vscode-editor-selectionHighlightBackground, #07f3); border-radius: 2px; }
  .lpc-keyword { color: var(--vscode-charts-purple, #c586c0); }
  .lpc-type, .lpc-modifier { color: var(--vscode-charts-blue, #569cd6); }
  .lpc-string, .lpc-template, .lpc-textblock, .lpc-char { color: var(--vscode-charts-orange, #ce9178); }
  .lpc-number { color: var(--vscode-charts-green, #b5cea8); }
  .lpc-comment { color: var(--vscode-descriptionForeground, #6a9955); font-style: italic; }
  .lpc-directive { color: var(--vscode-charts-yellow, #dcdcaa); }
  .lpc-identifier { color: var(--vscode-editor-foreground); }
  .lpc-operator, .lpc-punctuation { opacity: .9; }
  .lpc-illegal { text-decoration: wavy underline var(--vscode-errorForeground, red); }
  /* AST */
  #ast-wrap { display: flex; gap: 14px; align-items: flex-start; }
  #ast-tree { flex: 1 1 45%; min-width: 260px; max-height: 70vh; overflow: auto; }
  #ast-graph { flex: 1 1 55%; overflow: auto; max-height: 70vh;
               border-left: 1px solid var(--vscode-panel-border, #8883); padding-left: 10px; }
  .astnode { cursor: pointer; }
  .astnode > .lbl:hover { text-decoration: underline; }
  .astnode.sel > .lbl { background: var(--vscode-editor-selectionBackground, #07f5); border-radius: 2px; }
  ul.ast { list-style: none; margin: 0; padding-left: 16px; border-left: 1px dotted #8884; }
  ul.ast.root { border-left: none; padding-left: 0; }
  .twist { display: inline-block; width: 12px; cursor: pointer; opacity: .6; user-select: none; }
  .atom { color: var(--vscode-charts-green, #b5cea8); }
  .strlit { color: var(--vscode-charts-orange, #ce9178); }
  svg .gnode rect { fill: var(--vscode-editorWidget-background, #2223); stroke: var(--vscode-panel-border, #888); rx: 4; }
  svg .gnode.sel rect { stroke: var(--vscode-focusBorder, #07f); stroke-width: 2; }
  svg .gnode text { fill: var(--vscode-editor-foreground); font-size: 11px; }
  svg path.edge { fill: none; stroke: var(--vscode-panel-border, #888a); }
  /* bytecode */
  #bc-bar { display: flex; gap: 14px; align-items: center; margin: 4px 0 8px; }
  #bc-bar label { cursor: pointer; }
  tr.ins.haslink { cursor: pointer; }
  tr.ins.fnl td:first-child { border-left: 3px solid var(--vscode-charts-purple, #c586c0); padding-left: 6px; }
  tr.ins.fnl .addr { opacity: .9; }
  .fnl-tag { color: var(--vscode-charts-purple, #c586c0); font-size: 11px; margin-left: 6px; }
  #bc-tip { position: fixed; z-index: 10; display: none; max-width: 640px; overflow: hidden;
            background: var(--vscode-editorWidget-background, #252526);
            border: 1px solid var(--vscode-focusBorder, #07f); border-radius: 4px;
            padding: 6px 10px; box-shadow: 0 4px 12px #0008; pointer-events: none; }
  #bc-tip .tip-file { opacity: .6; font-size: 11px; margin-bottom: 3px; }
  #bc-tip .srcline { white-space: pre; }
  #bc-tip .srcline .ln { display: inline-block; width: 2.6em; text-align: right; padding-right: 8px;
                         opacity: .45; }
  #bc-tip .srcline.cur { background: var(--vscode-editor-selectionHighlightBackground, #07f3);
                         border-radius: 2px; }
  details { margin: 6px 0; }
  summary { cursor: pointer; font-weight: 600; }
  summary .jump { font-weight: 400; margin-left: 8px; }
  .addr { opacity: .7; }
  .hex { opacity: .55; }
  a.link { color: var(--vscode-textLink-foreground, #3794ff); cursor: pointer; text-decoration: none; }
  a.link:hover { text-decoration: underline; }
  .flash { animation: flash 1.2s; }
  @keyframes flash { 0% { background: var(--vscode-editor-findMatchBackground, #fa5a); } 100% { background: transparent; } }
</style>
</head>
<body>
  <div id="crumbs"></div>
  <div id="tabs"></div>
  <div id="content"><div class="hint">Loading…</div></div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  let model = null;
  const TABS = ['Source', 'Tokens', 'AST', 'Bytecode', 'Preprocessed'];
  let active = (vscode.getState() || {}).tab || 'Source';
  let astSelPath = []; // indices from section root

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                              .replace(/"/g, '&quot;');

  function post(m) { vscode.postMessage(m); }
  function setTab(t) { active = t; vscode.setState({ tab: t }); render(); }

  function crumbs(parts) {
    $('crumbs').innerHTML = parts.map((p, i) =>
      (i ? '<span class="sep">›</span>' : '') +
      '<span class="crumb" data-i="' + i + '">' + esc(p.label) + '</span>').join('');
    const els = $('crumbs').querySelectorAll('.crumb');
    els.forEach((el, i) => { el.onclick = () => parts[i].onClick && parts[i].onClick(); });
  }

  function renderTabs() {
    $('tabs').innerHTML = TABS.map((t) =>
      '<button data-t="' + t + '" class="' + (t === active ? 'active' : '') + '">' + t + '</button>').join('');
    $('tabs').querySelectorAll('button').forEach((b) => b.onclick = () => setTab(b.dataset.t));
  }

  // ---- Source ------------------------------------------------------------
  function renderSource(el) {
    const html = model.tokens.map((t, i) =>
      '<span class="lpc-' + t.kind + '" data-s="' + t.start + '" data-e="' + t.end +
      '" data-l="' + t.line + '" data-c="' + t.col + '" data-i="' + i + '">' + esc(t.text) + '</span>'
    ).join('');
    el.innerHTML = '<pre id="src">' + html + '</pre>';
    el.querySelectorAll('#src span').forEach((sp) => {
      sp.onclick = () => post({ type: 'reveal', line: +sp.dataset.l, col: +sp.dataset.c });
    });
  }

  // ---- Tokens ------------------------------------------------------------
  function renderTokens(el) {
    const rows = model.tokens.filter((t) => t.kind !== 'whitespace');
    let html = '<h3>Grammar tokenizer (' + rows.length + ' tokens)</h3>' +
      '<table><tr><th>#</th><th>line:col</th><th>kind</th><th>text</th></tr>' +
      rows.map((t, i) =>
        '<tr class="rowlink" data-l="' + t.line + '" data-c="' + t.col + '" data-s="' + t.start +
        '" data-e="' + t.end + '"><td class="muted">' + i + '</td><td>' + t.line + ':' + t.col +
        '</td><td>' + esc(t.kind) + '</td><td>' + esc(t.text) + '</td></tr>').join('') +
      '</table>';
    if (model.lpcc.available && model.lpcc.tokens.length) {
      html += '<details><summary>Compiler token stream — after preprocessing (' +
        model.lpcc.tokens.length + ' tokens)</summary>' +
        '<p class="muted">The stream the parser actually sees: macros expanded, includes inlined. ' +
        'kind is the internal bison token number.</p>' +
        '<table><tr><th>line:col</th><th>kind</th><th>spelling</th></tr>' +
        model.lpcc.tokens.map((t) =>
          '<tr class="rowlink" data-l="' + t.line + '" data-c="' + t.col + '"><td>' + t.line + ':' +
          t.col + '</td><td class="muted">' + esc(t.name || t.kind) + '</td><td>' + esc(t.text) +
          '</td></tr>').join('') +
        '</table></details>';
    } else if (!model.lpcc.available) {
      html += lpccHint('the compiler token stream');
    }
    el.innerHTML = html;
    el.querySelectorAll('tr.rowlink').forEach((tr) => {
      tr.onclick = () => post({ type: 'reveal', line: +tr.dataset.l, col: +tr.dataset.c });
    });
  }

  // ---- AST ---------------------------------------------------------------
  function stringsTable() {
    const bc = model.lpcc.bytecode;
    const map = new Map();
    if (bc) for (const s of bc.strings) map.set(s.index, s.text);
    return map;
  }

  function astNodeLabel(node, ctxInfo) {
    // JSON path: the string literal is resolved onto the node already.
    if (node.str != null) {
      return { html: '<span class="lbl">' + esc(node.label) +
        ' <span class="strlit">"' + esc(node.str).slice(0, 30) + '"</span>' + lineBadge(node) + '</span>' };
    }
    // Text path: (string N) with N resolvable via the bytecode strings table.
    const strs = ctxInfo.strings;
    if (node.label === 'string' && node.children.length === 1 && strs.has(+node.children[0].label)) {
      return { html: '<span class="lbl">string ' + node.children[0].label +
        ' <span class="strlit">"' + esc(strs.get(+node.children[0].label)).slice(0, 30) + '"</span></span>' };
    }
    return null;
  }

  function lineBadge(node) {
    return node.src ? ' <span class="muted">' + esc(node.src.file.split('/').pop()) + ':' + node.src.line + '</span>' : '';
  }

  function renderAstNode(node, path, ctxInfo) {
    const sel = path.join('.') === astSelPath.join('.');
    const isLeaf = node.children.length === 0;
    const special = astNodeLabel(node, ctxInfo);
    let inner;
    if (special) {
      inner = special.html;
    } else {
      const dec = ctxInfo.refs && decorateLabel(node.label || '', ctxInfo.refs);
      inner = '<span class="lbl' + (isLeaf ? ' atom' : '') + '">' +
        (dec !== null && dec !== undefined ? dec : esc(node.label || '()')) +
        lineBadge(node) + '</span>';
    }
    let html = '<li><span class="astnode' + (sel ? ' sel' : '') + '" data-p="' + path.join('.') + '">' +
      (isLeaf || special ? '<span class="twist"> </span>' : '<span class="twist">▾</span>') + inner + '</span>';
    if (!special && !isLeaf) {
      html += '<ul class="ast">' + node.children.map((c, i) =>
        renderAstNode(c, path.concat(i), ctxInfo)).join('') + '</ul>';
    }
    return html + '</li>';
  }

  function findAstNode(path) {
    if (!model.lpcc.ast.length || !path.length) return null;
    let list = model.lpcc.ast[path[0]] ? model.lpcc.ast[path[0]].roots : null;
    if (!list) return null;
    let node = null;
    for (let i = 1; i < path.length; i++) {
      node = list[path[i]];
      if (!node) return null;
      list = node.children;
    }
    return node;
  }

  // Reference decoration: constants show their VALUE (string literals via
  // the string table), variable/function references show idx AND name
  // (globals via the VARIABLES table, calls via the FUNCTIONS table).
  function refMaps() {
    const bc = model.lpcc.bytecode;
    const globals = new Map(), fns = new Map();
    if (bc) {
      for (const g of bc.globals) globals.set(g.index, g.name);
      for (const v of bc.variables) if (!globals.has(v.index)) globals.set(v.index, v.decl);
      for (const f of bc.functionsTable) fns.set(f.index, f.name);
    }
    return { globals, fns };
  }

  function decorateLabel(label, refs) {
    let m = /^(global|global_lvalue) (\d+)$/.exec(label);
    if (m && refs.globals.has(+m[2])) return label + ' <span class="muted">(' + esc(refs.globals.get(+m[2])) + ')</span>';
    m = /^F_CALL_FUNCTION_BY_ADDRESS (\d+)( |$)/.exec(label);
    if (m && refs.fns.has(+m[1])) return label.replace(/^F_CALL_FUNCTION_BY_ADDRESS (\d+)/, 'call ' + esc(refs.fns.get(+m[1])) + '($1)');
    m = /^(local|local_lvalue|transfer_local|loop_incr) (\d+)/.exec(label);
    if (m) return label + ' <span class="muted">LV' + m[2] + '</span>';
    return null;
  }

  function renderAst(el) {
    if (!model.lpcc.available) { el.innerHTML = lpccHint('the AST view'); return; }
    if (!model.lpcc.ast.length) { el.innerHTML = '<div class="hint">No AST captured — check for compile errors below or hit refresh.</div>'; return; }
    const ctxInfo = { strings: stringsTable(), refs: refMaps() };
    const fnNames = (model.outline.functions || []).map((f) => f.name);
    let html = '<div id="ast-wrap"><div id="ast-tree">';
    model.lpcc.ast.forEach((sec, si) => {
      html += '<h3>' + esc(sec.title) + '</h3><ul class="ast root">';
      sec.roots.forEach((r, ri) => {
        // TREE_MAIN roots are (function ...) in source definition order
        // (JSON labels carry the function index: "function 2").
        let label = r.label;
        if (/^function($| )/.test(label) && si === 0 && fnNames[ri]) label += ' — ' + fnNames[ri] + '()';
        html += renderAstNode({ ...r, label }, [si, ri], ctxInfo);
      });
      html += '</ul>';
    });
    html += '</div><div id="ast-graph"></div></div>';
    el.innerHTML = html;
    el.querySelectorAll('.astnode').forEach((n) => {
      n.onclick = (ev) => {
        ev.stopPropagation();
        astSelPath = n.dataset.p.split('.').map(Number);
        const p = astSelPath;
        const node = findAstNode(p);
        if (node && node.src) {
          // JSON AST: every positioned node click-reveals its source line.
          const f = node.src.file;
          if (model.lpcc.relPath && (f === model.lpcc.relPath || '/' + f === model.lpcc.relPath)) {
            post({ type: 'reveal', line: node.src.line, col: 1 });
          } else {
            post({ type: 'openFile', file: f, line: node.src.line });
          }
        } else if (p.length === 2 && p[0] === 0 && model.outline.functions[p[1]]) {
          // Text AST fallback: only function roots anchor (definition order).
          const f = model.outline.functions[p[1]];
          post({ type: 'reveal', line: f.line, col: f.col });
        }
        render(); // re-render to update selection/breadcrumbs/graph
      };
    });
    drawAstGraph($('ast-graph'), ctxInfo);
    updateAstCrumbs();
  }

  function updateAstCrumbs() {
    const parts = [{ label: model.file }, { label: 'AST', onClick: () => { astSelPath = []; render(); } }];
    if (astSelPath.length) {
      const sec = model.lpcc.ast[astSelPath[0]];
      if (sec) parts.push({ label: sec.title.replace(/^.*-- /, ''), onClick: () => { astSelPath = astSelPath.slice(0, 1); render(); } });
      let list = sec ? sec.roots : [];
      for (let i = 1; i < astSelPath.length; i++) {
        const node = list[astSelPath[i]];
        if (!node) break;
        const upto = astSelPath.slice(0, i + 1);
        parts.push({ label: node.label || '()', onClick: () => { astSelPath = upto; render(); } });
        list = node.children;
      }
    }
    crumbs(parts);
  }

  function drawAstGraph(el, ctxInfo) {
    // Graph the selected subtree; a selected LEAF graphs its parent so the
    // pane always shows context, not a single lonely box.
    let selPath = astSelPath;
    let root = selPath.length >= 2 ? findAstNode(selPath) : null;
    while (root && root.children.length === 0 && selPath.length > 2) {
      selPath = selPath.slice(0, -1);
      root = findAstNode(selPath);
    }
    if (!root) root = (model.lpcc.ast[0] && model.lpcc.ast[0].roots[0]) || null;
    if (!root) { el.innerHTML = '<p class="muted">Select a node to graph its subtree.</p>'; return; }
    // Tidy-ish layout: x from leaf ordering, y from depth. Cap size.
    const MAXN = 400;
    let count = 0;
    const nodes = [], edges = [];
    const measure = (n) => Math.max(30, 8 + 6.6 * Math.min(24, (n.label || '()').length));
    function layout(n, depth) {
      if (count >= MAXN) return null;
      count++;
      const me = { n, depth, x: 0, w: measure(n), leaves: 0 };
      nodes.push(me);
      const kids = [];
      for (const c of n.children) {
        const k = layout(c, depth + 1);
        if (k) { kids.push(k); edges.push([me, k]); }
      }
      me.kids = kids;
      return me;
    }
    const rootL = layout(root, 0);
    let leafX = 0;
    (function place(m) {
      if (!m.kids.length) { m.x = leafX; leafX += Math.max(m.w + 14, 56); return; }
      m.kids.forEach(place);
      m.x = (m.kids[0].x + m.kids[m.kids.length - 1].x) / 2;
    })(rootL);
    const H = 46, PAD = 10;
    const width = Math.max(leafX + 40, 200);
    const height = (Math.max(...nodes.map((m) => m.depth)) + 1) * H + 30;
    let svg = '<svg width="' + width + '" height="' + height + '">';
    for (const [a, b] of edges) {
      const x1 = a.x + a.w / 2 + PAD, y1 = a.depth * H + 22 + PAD;
      const x2 = b.x + b.w / 2 + PAD, y2 = b.depth * H + PAD;
      svg += '<path class="edge" d="M' + x1 + ',' + y1 + ' C' + x1 + ',' + (y1 + 14) + ' ' + x2 + ',' + (y2 - 14) + ' ' + x2 + ',' + y2 + '"/>';
    }
    nodes.forEach((m, i) => {
      let lbl = m.n.label || '()';
      if (m.n.label === 'string' && m.n.children.length === 1 && ctxInfo.strings.has(+m.n.children[0].label)) {
        lbl = '"' + ctxInfo.strings.get(+m.n.children[0].label).slice(0, 12) + '"';
      }
      if (lbl.length > 24) lbl = lbl.slice(0, 23) + '…';
      svg += '<g class="gnode' + (i === 0 && astSelPath.length >= 2 ? ' sel' : '') + '">' +
        '<rect x="' + (m.x + PAD) + '" y="' + (m.depth * H + PAD) + '" width="' + m.w + '" height="22"/>' +
        '<text x="' + (m.x + m.w / 2 + PAD) + '" y="' + (m.depth * H + 15 + PAD) + '" text-anchor="middle">' + esc(lbl) + '</text></g>';
    });
    svg += '</svg>';
    el.innerHTML = (count >= MAXN ? '<p class="muted">Subtree truncated at ' + MAXN + ' nodes — select a smaller node.</p>' : '') + svg;
  }

  // ---- Bytecode ------------------------------------------------------------
  let bcMode = 'opt'; // 'opt' (default optimized dump) | 'O0'

  function srcLineHtml() {
    // Line-addressable syntax-colored source: tokens re-chunked per line.
    // NB: this code lives inside webviewHtml's outer template literal --
    // escape sequences must be doubled or they expand at THAT level.
    const lines = [[]];
    for (const t of model.tokens) {
      const parts = t.text.split('\\n');
      parts.forEach((p, i) => {
        if (i > 0) lines.push([]);
        if (p) lines[lines.length - 1].push('<span class="lpc-' + t.kind + '">' + esc(p) + '</span>');
      });
    }
    return lines.map((spans) => spans.join(''));
  }

  function renderBytecode(el) {
    if (!model.lpcc.available) { el.innerHTML = lpccHint('the bytecode view'); return; }
    const bc = bcMode === 'O0' ? (model.lpcc.bytecodeO0 || model.lpcc.bytecode) : model.lpcc.bytecode;
    if (!bc) { el.innerHTML = '<div class="hint">No bytecode captured — the file may not compile; see Problems.</div>'; return; }
    const outlineByName = new Map((model.outline.functions || []).map((f) => [f.name, f]));
    const programs = bc.programs && bc.programs.length ? bc.programs
      : [{ file: bc.name, functions: bc.functions, functionsTable: bc.functionsTable,
           variables: bc.variables, strings: bc.strings }];
    let html = '<div id="bc-bar"><strong>' + esc(bc.name || model.file) + '</strong>' +
      '<label><input type="radio" name="bcmode" value="opt"' + (bcMode === 'opt' ? ' checked' : '') +
      '> optimized</label>' +
      '<label><input type="radio" name="bcmode" value="O0"' + (bcMode === 'O0' ? ' checked' : '') +
      '> -O0 (optimizer off)</label>' +
      (bcMode === 'O0' && !model.lpcc.bytecodeO0 ? '<span class="muted">-O0 dump unavailable; showing optimized</span>' : '') +
      '<span class="muted">hover a row for its source; click to jump</span></div>';
    html += '<details><summary>Program tables</summary>' +
      '<h4>Functions</h4><table>' + bc.functionsTable.map((f) =>
        '<tr><td class="muted">' + f.index + '</td><td>' + esc(f.name) + '</td></tr>').join('') + '</table>' +
      (programs.map((p) =>
        '<h4>' + esc(p.file || '') + '</h4>' +
        '<h5>Variables</h5><table>' + p.variables.map((v) =>
          '<tr><td class="muted">' + v.index + '</td><td>' + esc(v.decl) + '</td></tr>').join('') + '</table>' +
        '<h5>Strings</h5><table>' + p.strings.map((s) =>
          '<tr><td class="muted">' + s.index + '</td><td>' + esc(s.text) + '</td></tr>').join('') + '</table>'
      ).join('')) + '</details>';
    for (const p of programs) {
      if (programs.length > 1) {
        html += '<h3>' + esc(p.file || '') + (p !== programs[0] ? ' <span class="muted">(inherited)</span>' : '') + '</h3>';
      }
      html += renderProgramFns(p, outlineByName, p === programs[0]);
    }
    html += '<div id="bc-tip"></div>';
    el.innerHTML = html;
    wireBytecode(el);
  }

  function renderProgramFns(p, outlineByName, isTop) {
    let html = '';
    for (const fn of p.functions) {
      // A (: ... :) functional's body is EMBEDDED inline right after its
      // F_FUNCTION_CONSTRUCTOR header (the runtime records offset = here
      // and skips it). Delimit those rows so the embedding is visible.
      const fnlRanges = [];
      for (const ins of fn.instructions) {
        const fm = /<functional, (\\d+) args?>: Code size: (\\d+)/.exec(ins.comment);
        if (fm) {
          const headerLen = ins.hex ? ins.hex.trim().split(/\\s+/).length : 5;
          const start = parseInt(ins.addr, 16) + headerLen;
          fnlRanges.push([start, start + (+fm[2])]);
          ins.isFnlHead = true;
        }
        // Anonymous closures print their end address in DECIMAL (%04tu).
        const am = /<anonymous function, \\d+ args?, \\d+ locals, ends at (\\d+)>/.exec(ins.comment);
        if (am) {
          const headerLen = ins.hex ? ins.hex.trim().split(/\\s+/).length : 6;
          fnlRanges.push([parseInt(ins.addr, 16) + headerLen, parseInt(am[1], 10)]);
          ins.isFnlHead = true;
        }
      }
      const inFnl = (addrHex) => {
        const a = parseInt(addrHex, 16);
        return fnlRanges.some((r) => a >= r[0] && a < r[1]);
      };
      const o = isTop ? outlineByName.get(fn.name) : null;
      html += '<details open><summary>' + esc(fn.signature) +
        (o ? ' <a class="link jump" data-l="' + o.line + '" data-c="' + o.col + '">go to source ↗</a>' : '') +
        '</summary><table><tr><th>addr</th><th>bytes</th><th>instruction</th><th>operands</th><th>src</th></tr>';
      for (const ins of fn.instructions) {
        // Garbage rows from the known disassembler decode bug can be huge.
        let comment = esc(ins.comment.length > 120 ? ins.comment.slice(0, 117) + '…' : ins.comment);
        if (ins.target) {
          comment = comment.replace('(' + ins.target + ')',
            '(<a class="link tgt" data-a="' + ins.target + '">' + ins.target + '</a>)');
        }
        const inFile = ins.srcFile && model.lpcc.relPath &&
          (ins.srcFile === model.lpcc.relPath || '/' + ins.srcFile === model.lpcc.relPath);
        const fnlCls = inFnl(ins.addr) ? ' fnl' : '';
        html += '<tr id="a' + ins.addr + '" class="ins' + fnlCls + (inFile ? ' haslink' : '') +
          (inFile ? '" data-srcl="' + ins.srcLine : '') + '"><td class="addr">' + ins.addr + '</td><td class="hex">' +
          esc(ins.hex.length > 26 ? ins.hex.slice(0, 24) + '…' : ins.hex) + '</td><td>' +
          (fnlCls ? '<span class="fnl-tag">│ </span>' : '') + esc(ins.mnemonic) +
          (ins.isFnlHead ? ' <span class="fnl-tag">closure body follows ↓</span>' : '') +
          '</td><td>' + comment + '</td><td>' +
          (ins.srcLine ? '<a class="link src" data-f="' + esc(ins.srcFile) + '" data-l="' + ins.srcLine +
            '">' + esc(ins.srcFile.split('/').pop()) + ':' + ins.srcLine + '</a>' : '') +
          '</td></tr>';
      }
      html += '</table></details>';
    }
    return html;
  }

  function wireBytecode(el) {
    // mode toggle
    el.querySelectorAll('input[name=bcmode]').forEach((r) => r.onchange = () => {
      bcMode = r.value; render();
    });
    // hover box: the source line (with a little context) for this instruction
    const lines = srcLineHtml();
    const tip = el.querySelector('#bc-tip');
    el.querySelectorAll('tr.ins.haslink').forEach((tr) => {
      const l = +tr.dataset.srcl;
      tr.onmouseenter = () => {
        let body = '';
        for (let i = Math.max(1, l - 1); i <= Math.min(lines.length, l + 1); i++) {
          body += '<div class="srcline' + (i === l ? ' cur' : '') + '"><span class="ln">' + i +
                  '</span>' + (lines[i - 1] || '') + '</div>';
        }
        tip.innerHTML = '<div class="tip-file">' + esc(model.file) + ':' + l + '</div>' + body;
        tip.style.display = 'block';
      };
      tr.onmousemove = (ev) => {
        const pad = 14;
        tip.style.left = Math.min(ev.clientX + pad, window.innerWidth - tip.offsetWidth - 8) + 'px';
        tip.style.top = (ev.clientY + pad + tip.offsetHeight > window.innerHeight
          ? ev.clientY - tip.offsetHeight - pad : ev.clientY + pad) + 'px';
      };
      tr.onmouseleave = () => { tip.style.display = 'none'; };
      tr.onclick = () => post({ type: 'reveal', line: l, col: 1 });
    });
    el.querySelectorAll('a.jump').forEach((a) => a.onclick = (e) => {
      e.stopPropagation(); e.preventDefault();
      post({ type: 'reveal', line: +a.dataset.l, col: +a.dataset.c });
    });
    el.querySelectorAll('a.src').forEach((a) => a.onclick = () => {
      const f = a.dataset.f;
      if (model.lpcc.relPath && (f === model.lpcc.relPath || ('/' + f) === model.lpcc.relPath)) {
        post({ type: 'reveal', line: +a.dataset.l, col: 1 });
      } else {
        post({ type: 'openFile', file: f, line: +a.dataset.l });
      }
    });
    el.querySelectorAll('a.tgt').forEach((a) => a.onclick = () => {
      const row = document.getElementById('a' + a.dataset.a);
      if (row) {
        row.scrollIntoView({ block: 'center' });
        row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
      }
    });
  }

  // ---- Preprocessed -------------------------------------------------------
  function renderPreprocessed(el) {
    if (!model.lpcc.available) { el.innerHTML = lpccHint('the preprocessed view'); return; }
    if (model.lpcc.preprocessed == null) { el.innerHTML = '<div class="hint">Preprocessing failed — see Problems.</div>'; return; }
    el.innerHTML = '<p class="muted">Token-reconstructed source as the parser sees it (macros expanded).</p>' +
      '<pre>' + esc(model.lpcc.preprocessed) + '</pre>';
  }

  function lpccHint(what) {
    return '<div class="hint">Configure <code>lpc.lpcc.path</code> and <code>lpc.lpcc.configFile</code> ' +
      'to enable ' + what + ' (build the <code>lpcc</code> target in your fluffos checkout). ' +
      'The Source and Tokens views work without it.</div>';
  }

  function render() {
    renderTabs();
    const el = $('content');
    if (!model) { el.innerHTML = '<div class="hint">Loading…</div>'; return; }
    if (active !== 'AST') crumbs([{ label: model.file }, { label: active }]);
    if (active === 'Source') renderSource(el);
    else if (active === 'Tokens') renderTokens(el);
    else if (active === 'AST') renderAst(el);
    else if (active === 'Bytecode') renderBytecode(el);
    else renderPreprocessed(el);
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg.type === 'model') { model = msg.model; render(); }
    else if (msg.type === 'error') {
      $('content').innerHTML = '<div class="hint">Explorer error: ' + esc(msg.message) + '</div>';
    } else if (msg.type === 'cursor' && model && active === 'Source') {
      const spans = document.querySelectorAll('#src span[data-s]');
      let target = null;
      for (const sp of spans) {
        sp.classList.remove('cursor-hl');
        if (+sp.dataset.s <= msg.offset && msg.offset < +sp.dataset.e) target = sp;
      }
      if (target) { target.classList.add('cursor-hl'); target.scrollIntoView({ block: 'nearest' }); }
    }
  });

  post({ type: 'ready' });
})();
</script>
</body>
</html>`;
}

module.exports = { openExplorer };
