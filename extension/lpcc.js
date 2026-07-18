// lpcc pipeline service: run the FluffOS compiler front-end's stage outputs
// and parse them into plain-data models.
//
// TRANSPORT-AGNOSTIC BY DESIGN: this module never imports 'vscode'. It
// speaks child_process + plain objects (1-based line/col, mudlib-relative
// paths), so the planned phase-2 LSP server can lift it unchanged and serve
// the same models over custom LSP requests (lpc/tokens, lpc/ast,
// lpc/bytecode). Keep it that way: rendering belongs in explorer.js,
// editor plumbing in extension.js.
//
// lpcc stage flags (see fluffos src/main_lpcc.cc):
//   -E        preprocessed source (token-reconstructed)
//   --tokens  post-preprocessing token stream: "line:col kind  spelling"
//   --ast     parse trees (dump_tree S-expressions) before codegen
//   (none)    optimized bytecode disassembly (dump_prog)
//   -O0       disassembly with the tree optimizer off
//
// lpcc's stdout mixes driver boot noise (config processing, simul_efun /
// master loading, warnings, tracer messages) around the payload, so every
// parser here extracts by markers instead of trusting line ranges.

'use strict';

const cp = require('child_process');

const STAGE_FLAGS = {
  preprocessed: ['-E'],
  tokens: ['--tokens'],
  ast: ['--ast'],
  bytecode: [],
  bytecodeO0: ['-O0'],
  // JSON variants (fluffos >= 2026-07): one-line {"fluffos_lpcc":1,...}
  // envelopes -- token NAMES and AST source LINES, which the text formats
  // lack. Older lpcc rejects --json; callers fall back to the text stages.
  tokensJson: ['--json', '--tokens'],
  astJson: ['--json', '--ast'],
};

// One diagnostic line: /path/file.lpc:12:5: error: message
const DIAG_RE = /^\/?(.+?):(\d+):(\d+): (error|warning): (.*)$/;

// Parse clang-style diagnostics out of mixed lpcc output.
// Returns [{file, line, col, severity, message}] (file mudlib-relative,
// no leading slash; positions 1-based).
function parseDiagnostics(text) {
  const out = [];
  for (const l of String(text).split(/\r?\n/)) {
    const m = DIAG_RE.exec(l);
    if (m) {
      out.push({ file: m[1], line: +m[2], col: +m[3], severity: m[4], message: m[5] });
    }
  }
  return out;
}

// Run one lpcc stage. opts: {lpccPath, configFile, mudlibRoot}, relPath is
// the file's mudlib-relative path. Resolves {ok, raw, stderr, diagnostics}.
// lpcc exits nonzero on compile errors -- the diagnostics ARE the result.
function runStage(opts, relPath, stage) {
  const flags = STAGE_FLAGS[stage];
  if (!flags) return Promise.reject(new Error(`unknown lpcc stage: ${stage}`));
  // A .js lpcc is the wasm build (NODERAWFS node CLI, same CLI contract as
  // the native binary) -- run it through the current node executable.
  const isWasm = /\.[cm]?js$/.test(opts.lpccPath);
  const exe = isWasm ? process.execPath : opts.lpccPath;
  const baseArgs = isWasm ? [opts.lpccPath] : [];
  return new Promise((resolve) => {
    cp.execFile(
      exe, [...baseArgs, ...flags, opts.configFile, relPath],
      { cwd: opts.mudlibRoot, timeout: 30000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          raw: String(stdout),
          stderr: String(stderr),
          diagnostics: parseDiagnostics(String(stderr) + '\n' + String(stdout)),
        });
      });
  });
}

// --- JSON envelopes (lpcc --json) ------------------------------------------------

// Extract every {"fluffos_lpcc":1,...} envelope line from mixed output.
function parseEnvelopes(raw) {
  const out = [];
  for (const l of String(raw).split(/\r?\n/)) {
    if (!l.includes('"fluffos_lpcc"')) continue;
    try { out.push(JSON.parse(l)); } catch (_e) { /* partial/garbled line */ }
  }
  return out;
}

// tokens envelope -> same shape as parseTokens() plus the grammar name.
function tokensFromJson(envelopes) {
  const env = envelopes.find((e) => e.stage === 'tokens');
  if (!env) return null;
  return env.tokens.map((t) => ({ line: t.l, col: t.c, kind: t.k, name: t.n, text: t.t }));
}

// ast + files envelopes -> [{title, roots}] with the same {label, children}
// node shape parseAst() produces, PLUS per-node `src: {file, line}` resolved
// through the files envelope's absolute-line segment table (AST "l" values
// are absolute compilation-unit lines, includes inlined; a file's line
// numbering CONTINUES across its non-adjacent segments).
function astFromJson(envelopes) {
  const ast = envelopes.find((e) => e.stage === 'ast');
  if (!ast) return null;
  const files = envelopes.find((e) => e.stage === 'files') || { segments: [], strings: [] };

  const resolve = (abs) => {
    let off = 1;
    const consumed = new Map();
    for (const s of files.segments) {
      if (abs < off + s.lines) return { file: s.file, line: (consumed.get(s.file) || 0) + (abs - off) + 1 };
      consumed.set(s.file, (consumed.get(s.file) || 0) + s.lines);
      off += s.lines;
    }
    return null;
  };

  const conv = (n) => {
    let label = n.k;
    if (n.a && n.a.length) label += ' ' + n.a.join(' ');
    const node = { label, children: (n.c || []).map(conv) };
    if (n.k === 'string' && n.a && files.strings[n.a[0]] != null) node.str = files.strings[n.a[0]];
    if (n.l) node.src = resolve(n.l);
    return node;
  };

  return {
    sections: ast.trees.map((t) => ({ title: t.title, roots: t.roots.map(conv) })),
    strings: files.strings,
  };
}

// --- tokens stage --------------------------------------------------------------

// "   3:1      264  int" -> {line, col, kind, text}. kind is the bison token
// number (internal); text is the spelling as the PARSER sees it, i.e. after
// preprocessing (macros expanded, includes inlined).
const TOKEN_LINE_RE = /^\s*(\d+):(\d+)\s+(\d+)\s\s(.*)$/;

function parseTokens(raw) {
  const out = [];
  for (const l of String(raw).split(/\r?\n/)) {
    const m = TOKEN_LINE_RE.exec(l);
    if (m) out.push({ line: +m[1], col: +m[2], kind: +m[3], text: m[4] });
  }
  return out;
}

// --- ast stage -----------------------------------------------------------------

// dump_tree prints S-expressions:
//   ;;; AST <file> -- TREE_MAIN
//   (function (return (+ (local 0)(local 1))))...
//   ;;; AST -- TREE_INIT
//   ...
// Traps: instruction names may START with a parenthesized prefix --
// "(void)assign_local", "(void)+=" -- which must be read as part of the
// atom, not as a child list; newlines appear inside if/loop nodes and are
// plain whitespace; "(string N)" atoms are string-TABLE indices (resolve
// display text via the bytecode model's strings section).
//
// Returns [{title, roots}] where a node is {label, children} (children
// empty for atoms).
function parseAst(raw) {
  const sections = [];
  const lines = String(raw).split(/\r?\n/);
  let cur = null;
  for (const l of lines) {
    const m = /^;;; AST\s*(.*)$/.exec(l);
    if (m) {
      cur = { title: m[1] || 'AST', body: [] };
      sections.push(cur);
    } else if (cur) {
      // Tracer noise ends the payload.
      if (/^Trace duration:|^\[thread /.test(l)) cur = null;
      else cur.body.push(l);
    }
  }
  return sections.map((s) => ({ title: s.title, roots: parseSexprs(s.body.join('\n')) }));
}

// Atom names that begin with a parenthesized prefix, e.g. "(void)assign".
const PAREN_PREFIX_RE = /^\((?:void|mapping|array \| string)\)/;

function parseSexprs(text) {
  let i = 0;
  const n = text.length;
  const isSpace = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r';

  function skipSpace() { while (i < n && isSpace(text[i])) i++; }

  function readAtom() {
    let s = '';
    if (text[i] === '(') {
      const m = PAREN_PREFIX_RE.exec(text.slice(i, i + 20));
      if (m) { s += m[0]; i += m[0].length; }
    }
    while (i < n && !isSpace(text[i]) && text[i] !== '(' && text[i] !== ')') s += text[i++];
    return s;
  }

  function parseNode() {
    skipSpace();
    if (i >= n) return null;
    if (text[i] === '(' && !PAREN_PREFIX_RE.test(text.slice(i, i + 20))) {
      i++; // consume '('
      skipSpace();
      const label = text[i] === '(' && !PAREN_PREFIX_RE.test(text.slice(i, i + 20))
        ? '' // headless list (rare); children carry the content
        : readAtom();
      const node = { label, children: [] };
      for (;;) {
        skipSpace();
        if (i >= n) break; // tolerate truncated dumps
        if (text[i] === ')') { i++; break; }
        const child = parseNode();
        if (child === null) break;
        node.children.push(child);
      }
      return node;
    }
    const atom = readAtom();
    if (atom === '') { i++; return parseNode(); } // skip stray ')' etc.
    return { label: atom, children: [] };
  }

  const roots = [];
  for (;;) {
    skipSpace();
    if (i >= n) break;
    if (text[i] !== '(') { readAtom(); continue; } // skip stray noise atoms
    const node = parseNode();
    if (node) roots.push(node);
  }
  return roots;
}

// --- bytecode stage --------------------------------------------------------------

// dump_prog output (after boot noise):
//   NAME: /path
//   INHERITS: <table>
//   FUNCTIONS: <table>            index: name offset mods flags ...
//   ;;; <file>
//   Globals: / VARIABLES defined: / STRINGS: sections
//   DISASSEMBLY:
//   ;; Function: <signature>
//   ADDR:  HEX BYTES   MNEMONIC   ; comment
//   ; file:line          <- trailing annotation for the PRECEDING run
//   ;;;  *** Line Number Info ***  (address -> absolute line table)
function parseBytecode(raw) {
  const lines = String(raw).split(/\r?\n/);
  const model = {
    name: null,
    functionsTable: [],   // {index, name}
    globals: [],          // {index, name}
    variables: [],        // {index, decl}
    strings: [],          // {index, text}
    functions: [],        // {signature, name, instructions: [...]}
    addressLines: [],     // {from, to, absLine}
  };

  let section = null;
  let curFn = null;
  let pending = []; // instructions awaiting a trailing "; file:line"

  const flushPending = (file, line) => {
    for (const ins of pending) { ins.srcFile = file; ins.srcLine = line; }
    pending = [];
  };

  for (const l of lines) {
    let m;
    if ((m = /^NAME: (.*)$/.exec(l))) { model.name = m[1]; section = 'head'; continue; }
    if (model.name === null) continue; // boot noise before the payload
    if (/^Trace duration:|^\[thread /.test(l)) break;

    if (/^FUNCTIONS:/.test(l)) { section = 'functions'; continue; }
    if (/^Globals:/.test(l)) { section = 'globals'; continue; }
    if (/^VARIABLES defined:/.test(l)) { section = 'variables'; continue; }
    if (/^STRINGS:/.test(l)) { section = 'strings'; continue; }
    if (/^DISASSEMBLY:/.test(l)) { section = 'disassembly'; continue; }
    if (/\*\*\* Line Number Info \*\*\*/.test(l)) { flushPending(null, 0); section = 'lineinfo'; continue; }

    if (section === 'functions') {
      if ((m = /^\s*(\d+): (\S+)/.exec(l))) model.functionsTable.push({ index: +m[1], name: m[2] });
      continue;
    }
    if (section === 'globals') {
      if ((m = /^\s*(\d+): (.*)$/.exec(l))) model.globals.push({ index: +m[1], name: m[2] });
      continue;
    }
    if (section === 'variables') {
      if ((m = /^\s*(\d+): (.*)$/.exec(l))) model.variables.push({ index: +m[1], decl: m[2] });
      continue;
    }
    if (section === 'strings') {
      if ((m = /^\s*(\d+): (.*)$/.exec(l))) model.strings.push({ index: +m[1], text: m[2] });
      continue;
    }
    if (section === 'disassembly') {
      if ((m = /^;; Function: (.*)$/.exec(l))) {
        flushPending(null, 0);
        const sig = m[1];
        const nm = (/(?:^|[ *])([A-Za-z_#][A-Za-z0-9_#]*)\s*\(/.exec(sig) || [])[1] || sig;
        curFn = { signature: sig, name: nm, instructions: [] };
        model.functions.push(curFn);
        continue;
      }
      if ((m = /^; (.+):(\d+)\s*$/.exec(l))) { flushPending(m[1], +m[2]); continue; }
      if ((m = /^([0-9a-f]{4,}): (.*)$/.exec(l))) {
        // "0006:  02 02 04 C0               F_PUSH        ; push string 4, local 0"
        const addr = m[1];
        const rest = m[2];
        let hex = '', mnemonic = rest, comment = '';
        const cm = rest.indexOf(';');
        const body = cm >= 0 ? rest.slice(0, cm) : rest;
        if (cm >= 0) comment = rest.slice(cm + 1).trim();
        const bm = /^(\s*(?:[0-9A-F]{2} )*)\s*(.*)$/.exec(body);
        if (bm) { hex = bm[1].trim(); mnemonic = bm[2].trim(); }
        const ins = { addr, hex, mnemonic, comment, srcFile: null, srcLine: 0 };
        // Branch comments carry a resolved target: "0007 (0012)".
        const tm = /\(([0-9a-f]{4,})\)/.exec(comment);
        if (tm) ins.target = tm[1];
        if (curFn) { curFn.instructions.push(ins); pending.push(ins); }
        continue;
      }
      continue; // "*** zero opcode ***" and other oddities: keep raw-only
    }
    if (section === 'lineinfo') {
      if ((m = /^([0-9a-f]+)-([0-9a-f]+): (\d+)$/.exec(l))) {
        model.addressLines.push({ from: m[1], to: m[2], absLine: +m[3] });
      }
      continue;
    }
  }
  flushPending(null, 0);
  return model;
}

// --- preprocessed stage ----------------------------------------------------------

// -E output is the token-reconstructed source; strip boot/tracer noise by
// dropping known-noise lines from the head and tail. There is no marker, so
// this uses the heuristic that noise lines match well-known prefixes.
const NOISE_RE = new RegExp(
  '^(Processing config file:|maximum |New Debug log|Execution root:|Initializing internal|' +
  'Event backend|Loading (simul_efun|master) file|\\*Warning:|Trace duration:|\\[thread |' +
  '\\s*\\d+ \\| |\\s*\\| |\\s*\\^|  note: )|: (warning|error): ');

function stripNoise(raw) {
  return String(raw).split(/\r?\n/).filter((l) => !NOISE_RE.test(l)).join('\n')
    .replace(/^\n+/, '').replace(/\n+$/, '\n');
}

// --- outline (tokenizer-driven, no lpcc needed) -----------------------------------
//
// A structural outline from the bundled grammar tokenizer: top-level
// functions, global variables, inherits, #defines. Used for document
// symbols/breadcrumbs and to anchor AST/bytecode function nodes to source
// (dump_tree carries no positions; functions appear in definition order).
//
// tokens: output of lib/tokenizer.mjs tokenize(src) -- {kind, text, line,
// col, start, end}, kinds: keyword/type/modifier/identifier/punctuation/...
function outline(tokens) {
  const out = { functions: [], variables: [], inherits: [], defines: [] };
  const sig = tokens.filter((t) => t.kind !== 'whitespace' && t.kind !== 'comment');
  let depth = 0;
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    if (t.kind === 'directive') {
      const dm = /^#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(t.text);
      if (dm) out.defines.push({ name: dm[1], line: t.line, col: t.col, start: t.start, end: t.end });
      continue;
    }
    if (t.kind === 'punctuation' || t.kind === 'operator') {
      if (t.text === '{') depth++;
      else if (t.text === '}') depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;

    if (t.kind === 'keyword' && t.text === 'inherit') {
      const s = sig[i + 1];
      if (s && s.kind === 'string') {
        out.inherits.push({ name: s.text.replace(/^"|"$/g, ''), line: t.line, col: t.col, start: t.start, end: s.end });
      }
      continue;
    }

    // Declaration head: [modifier|type|'*']* identifier ...
    if (t.kind === 'modifier' || t.kind === 'type') {
      let j = i;
      while (j < sig.length && (sig[j].kind === 'modifier' || sig[j].kind === 'type' ||
             (sig[j].kind === 'operator' && sig[j].text === '*'))) j++;
      const id = sig[j];
      if (!id || id.kind !== 'identifier') continue;
      const after = sig[j + 1];
      if (after && after.kind === 'punctuation' && after.text === '(') {
        // function: skip params to matching ')', then require '{' (a body)
        let k = j + 1, pd = 0;
        for (; k < sig.length; k++) {
          if (sig[k].text === '(') pd++;
          else if (sig[k].text === ')') { pd--; if (pd === 0) break; }
        }
        const brace = sig[k + 1];
        if (brace && brace.text === '{') {
          let bd = 0, e = k + 1;
          for (; e < sig.length; e++) {
            if (sig[e].text === '{') bd++;
            else if (sig[e].text === '}') { bd--; if (bd === 0) break; }
          }
          out.functions.push({
            name: id.text, line: id.line, col: id.col,
            start: t.start, end: (sig[e] || sig[sig.length - 1]).end,
            selStart: id.start, selEnd: id.end,
          });
          // Resume at the params' closing ')': the parameter list is never
          // scanned as declarations, and the body '{' still gets counted by
          // the depth tracker on the next iteration.
          i = k;
          continue;
        }
      }
      // variable(s): identifier [= ...] (, identifier)* ';'
      let k = j;
      while (k < sig.length && sig[k].text !== ';' && sig[k].text !== '{') {
        if (sig[k].kind === 'identifier' &&
            (k === j || (sig[k - 1] && (sig[k - 1].text === ',' || sig[k - 1].kind === 'type' ||
                                        sig[k - 1].kind === 'modifier' || sig[k - 1].text === '*')))) {
          out.variables.push({
            name: sig[k].text, line: sig[k].line, col: sig[k].col,
            start: sig[k].start, end: sig[k].end, selStart: sig[k].start, selEnd: sig[k].end,
          });
        }
        k++;
      }
      // Stop BEFORE the terminator so the depth tracker still sees a '{'
      // (an unparenthesized declaration can run into a block open).
      i = k - 1;
    }
  }
  return out;
}

module.exports = {
  STAGE_FLAGS,
  DIAG_RE,
  runStage,
  parseEnvelopes,
  tokensFromJson,
  astFromJson,
  parseDiagnostics,
  parseTokens,
  parseAst,
  parseSexprs,
  parseBytecode,
  stripNoise,
  outline,
};
