// Workspace cross-index for the LPC language server.
//
// Definitions (functions / globals / #defines / inherits) are indexed
// EAGERLY: every .lpc/.c/.h file under the root is tokenized and outlined
// once at startup and re-indexed on save/change. References are resolved
// ON DEMAND: files are prefiltered with a cheap \bword\b content test and
// only the matches are re-tokenized -- so the index holds outlines only
// (no token streams, no file bodies) and memory stays flat on large
// mudlibs.
//
// vscode-free and dependency-injected (tokenize/outline come from the
// caller) so tests and any editor's server can use it directly. All
// positions are the tokenizer's 1-based line/col, converted to LSP
// 0-based here at the edge.

'use strict';

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', '.lpc']);
const MAX_FILES = 20000;
const MAX_FILE_SIZE = 1024 * 1024;

function createIndex({ tokenize, outline }) {
  // abs path -> { defs: outline(), mtimeMs }
  const files = new Map();
  const roots = [];
  let built = false;

  function indexText(abs, text, mtimeMs) {
    try {
      files.set(abs, { defs: outline(tokenize(text)), mtimeMs: mtimeMs || 0 });
    } catch (_e) {
      files.delete(abs); // unparseable: drop rather than keep stale results
    }
  }

  function indexFile(abs) {
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > MAX_FILE_SIZE) return;
      const cached = files.get(abs);
      if (cached && cached.mtimeMs === st.mtimeMs) return;
      indexText(abs, fs.readFileSync(abs, 'utf8'), st.mtimeMs);
    } catch (_e) { /* unreadable: skip */ }
  }

  function listSources(rootDir) {
    const out = [];
    (function walk(dir) {
      if (out.length >= MAX_FILES) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return; }
      for (const e of entries) {
        if (out.length >= MAX_FILES) return;
        if (e.name.startsWith('.')) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(abs);
        } else if (/\.(lpc|c|h)$/.test(e.name)) {
          out.push(abs);
        }
      }
    })(rootDir);
    return out;
  }

  return {
    // Full scan. Synchronous per file but call sites may await between
    // chunks; for a 761-file corpus this is well under a second.
    build(rootDir) {
      if (!roots.includes(rootDir)) roots.push(rootDir);
      for (const abs of listSources(rootDir)) indexFile(abs);
      built = true;
      return files.size;
    },
    built: () => built,
    size: () => files.size,

    // Re-index one file from live buffer text (didOpen/didChange/didSave).
    update(abs, text) {
      if (roots.length > 0 && !roots.some((r) => abs.startsWith(r + path.sep))) return;
      indexText(abs, text, Date.now());
    },
    // Re-index one file from disk (didChangeWatchedFiles: files changed
    // OUTSIDE the editor -- git pull, generators).
    updateFromDisk(abs) {
      if (roots.length > 0 && !roots.some((r) => abs.startsWith(r + path.sep))) return;
      if (!/\.(lpc|c|h)$/.test(abs)) return;
      files.delete(abs); // drop the mtime short-circuit: always re-read
      indexFile(abs);
    },
    remove(abs) { files.delete(abs); },

    // name -> [{file, kind, name, line, col}] (tokenizer 1-based positions
    // of the declaration's name token).
    findDefinitions(name) {
      const out = [];
      for (const [file, { defs }] of files) {
        for (const f of defs.functions) if (f.name === name) out.push({ file, kind: 'function', name, line: f.line, col: f.col });
        for (const v of defs.variables) if (v.name === name) out.push({ file, kind: 'variable', name, line: v.line, col: v.col });
        for (const d of defs.defines) if (d.name === name) out.push({ file, kind: 'define', name, line: d.line, col: d.col });
      }
      return out;
    },

    // Substring symbol search (workspace/symbol). Empty query = everything
    // (capped); match is case-insensitive.
    findSymbols(query, cap = 500) {
      const q = String(query || '').toLowerCase();
      const out = [];
      for (const [file, { defs }] of files) {
        for (const [kind, arr] of [['function', defs.functions], ['variable', defs.variables], ['define', defs.defines]]) {
          for (const s of arr) {
            if (out.length >= cap) return out;
            if (!q || s.name.toLowerCase().includes(q)) {
              out.push({ file, kind, name: s.name, line: s.line, col: s.col });
            }
          }
        }
      }
      return out;
    },

    // Workspace-wide lexical references: prefilter indexed files with a
    // \bname\b content test, tokenize only the hits, collect identifier
    // tokens with that exact spelling. openTexts (abs -> text) supplies
    // live buffer contents; skipFiles are excluded (the caller already has
    // better data for them, e.g. the request's own document).
    findReferences(name, { openTexts = new Map(), skipFiles = new Set() } = {}) {
      const wordRe = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
      const out = [];
      for (const file of files.keys()) {
        if (skipFiles.has(file)) continue;
        let text = openTexts.get(file);
        if (text === undefined) {
          try {
            if (fs.statSync(file).size > MAX_FILE_SIZE) continue;
            text = fs.readFileSync(file, 'utf8');
          } catch (_e) { continue; }
        }
        if (!wordRe.test(text)) continue;
        let tokens;
        try { tokens = tokenize(text); } catch (_e) { continue; }
        const spans = [];
        for (const t of tokens) {
          if (t.kind === 'identifier' && t.text === name) {
            spans.push({ line: t.line, col: t.col, length: name.length });
          }
        }
        if (spans.length > 0) out.push({ file, spans });
      }
      return out;
    },
  };
}

module.exports = { createIndex };
