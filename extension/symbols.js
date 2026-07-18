// Document symbols (outline view + editor breadcrumbs) from the bundled
// grammar tokenizer via lpcc.js's outline(). Pure model comes from lpcc.js
// (LSP-liftable); this file is only the vscode provider shim.

'use strict';

const vscode = require('vscode');
const path = require('path');
const { pathToFileURL } = require('url');
const lpcc = require('./lpcc.js');

let tokenizePromise = null;
function loadTokenizer(ctx) {
  if (tokenizePromise === null) {
    const url = pathToFileURL(path.join(ctx.extensionPath, 'lib', 'tokenizer.mjs')).href;
    tokenizePromise = import(url).then((m) => m.tokenize);
  }
  return tokenizePromise;
}

function register(ctx) {
  return vscode.languages.registerDocumentSymbolProvider('lpc', {
    async provideDocumentSymbols(doc) {
      const tokenize = await loadTokenizer(ctx);
      const o = lpcc.outline(tokenize(doc.getText()));
      const sym = (name, kind, start, end, selStart, selEnd) => new vscode.DocumentSymbol(
        name, '', kind,
        new vscode.Range(doc.positionAt(start), doc.positionAt(end)),
        new vscode.Range(doc.positionAt(selStart), doc.positionAt(selEnd)));
      const out = [];
      for (const f of o.functions) {
        out.push(sym(f.name, vscode.SymbolKind.Function, f.start, f.end, f.selStart, f.selEnd));
      }
      for (const v of o.variables) {
        out.push(sym(v.name, vscode.SymbolKind.Variable, v.start, v.end, v.selStart, v.selEnd));
      }
      for (const inh of o.inherits) {
        out.push(sym('inherit ' + inh.name, vscode.SymbolKind.Namespace, inh.start, inh.end, inh.start, inh.end));
      }
      return out;
    },
  });
}

module.exports = { register };
