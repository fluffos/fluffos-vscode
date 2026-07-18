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
  bytecodeJson: ['--json'],
  bytecodeO0Json: ['--json', '-O0'],
};

// One diagnostic line: /path/file.lpc:12:5: error: message
// The column is optional: lexer-class errors (e.g. "Cannot #include x")
// print file:line: only.
const DIAG_RE = /^\/?(.+?):(\d+)(?::(\d+))?: (error|warning): (.*)$/;

// Parse clang-style diagnostics out of mixed lpcc output.
// Returns [{file, line, col, severity, message}] (file mudlib-relative,
// no leading slash; positions 1-based).
function parseDiagnostics(text) {
  const out = [];
  for (const l of String(text).split(/\r?\n/)) {
    const m = DIAG_RE.exec(l);
    if (m) {
      out.push({ file: m[1], line: +m[2], col: m[3] ? +m[3] : 1, severity: m[4], message: m[5] });
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

// Where the driver's debug log lives for a config (compile diagnostics land
// THERE, not on stderr, when the mudlib's master has no log_error apply).
function debugLogPath(opts) {
  let logDir = 'log', logFile = 'debug.log';
  try {
    const cfg = require('fs').readFileSync(opts.configFile, 'utf8');
    const d = /^log directory\s*:\s*(.+)$/m.exec(cfg);
    const f = /^debug log file\s*:\s*(.+)$/m.exec(cfg);
    if (d) logDir = d[1].trim();
    if (f) logFile = f[1].trim();
  } catch (_e) { /* unreadable config: defaults */ }
  const path = require('path');
  const dir = path.isAbsolute(logDir) ? logDir : path.join(opts.mudlibRoot, logDir);
  return path.join(dir, logFile);
}

// runStage + a debug-log fallback: when the compile failed but produced no
// stderr/stdout diagnostics, parse whatever the driver APPENDED to the debug
// log during this run (byte-offset bracketed, so stale entries from earlier
// runs can never republish).
async function runStageWithLog(opts, relPath, stage) {
  const fs = require('fs');
  const log = debugLogPath(opts);
  let before = 0;
  try { before = fs.statSync(log).size; } catch (_e) { /* no log yet */ }
  const r = await runStage(opts, relPath, stage);
  if (!r.ok && r.diagnostics.length === 0) {
    try {
      const fd = fs.openSync(log, 'r');
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.max(0, size - before));
      fs.readSync(fd, buf, 0, buf.length, before);
      fs.closeSync(fd);
      r.diagnostics = parseDiagnostics(buf.toString('utf8'));
    } catch (_e) { /* no log: keep empty */ }
  }
  return r;
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

// bytecode envelope -> the same model shape parseBytecode() produces, but
// with instruction file:line native to each row (no trailing-annotation
// reconstruction) and structured switch tables preserved under row.cases.
function bytecodeFromJson(envelopes) {
  const env = envelopes.find((e) => e.stage === 'bytecode');
  if (!env) return null;
  const P = env.program;
  const toHex = (a) => a.toString(16).padStart(4, '0');
  const conv = (p) => ({
    file: p.file,
    globals: (p.globals || []).map((g) => ({ index: g.i, name: g.name })),
    variables: (p.variables || []).map((v) => ({ index: v.i, decl: v.decl })),
    strings: (p.strings || []).map((s) => ({ index: s.i, text: s.text })),
    functions: (p.functions || []).map((f) => ({
      signature: f.sig,
      name: f.name,
      instructions: (f.instructions || []).map((r) => {
        const ins = {
          addr: toHex(r.a),
          hex: (r.x || '').trim(),
          mnemonic: r.m,
          comment: r.o || '',
          srcFile: r.f || null,
          srcLine: r.l || 0,
        };
        if (r.cases) {
          ins.switchCases = r.cases;
          ins.comment = 'table ' + toHex(r.tstart) + '-' + toHex(r.tend) +
            ' default ' + toHex(r.deflt) + ' (' + r.cases.length + ' cases)';
        }
        const tm = /\(([0-9a-f]{4,})\)/.exec(ins.comment);
        if (tm) ins.target = tm[1];
        return ins;
      }),
    })),
    addressLines: (p.line_ranges || []).map((r) => ({
      from: toHex(r.from), to: toHex(r.to), absLine: r.line,
    })),
  });
  const model = {
    name: P.name,
    optimized: env.optimized,
    functionsTable: (P.functions_table || []).map((f) => ({ index: f.i, name: f.name })),
    programs: (P.programs || []).map(conv),
  };
  const top = model.programs[0] || conv({});
  model.globals = top.globals;
  model.variables = top.variables;
  model.strings = top.strings;
  model.functions = top.functions;
  model.addressLines = top.addressLines;
  return model;
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
  const newProgram = (file) => ({
    file, globals: [], variables: [], strings: [], functions: [], addressLines: [],
  });
  const model = {
    name: null,
    functionsTable: [],   // {index, name} (top program, runtime-indexed)
    programs: [],         // one per ';;; <file>' section: top program first,
                          // then each inherited program's dump
  };
  let prog = null;        // current ';;; <file>' program section

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

    // ';;; <file>' opens a per-program section (top program, then each
    // inherited program's dump). NOT the ';;;  *** Line Number Info ***'
    // banner, which stays within the current program.
    if ((m = /^;;; ([^*\s].*)$/.exec(l))) {
      flushPending(null, 0);
      prog = newProgram(m[1].trim());
      model.programs.push(prog);
      curFn = null;
      section = null;
      continue;
    }
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
      if (prog && (m = /^\s*(\d+): (.*)$/.exec(l))) prog.globals.push({ index: +m[1], name: m[2] });
      continue;
    }
    if (section === 'variables') {
      if (prog && (m = /^\s*(\d+): (.*)$/.exec(l))) prog.variables.push({ index: +m[1], decl: m[2] });
      continue;
    }
    if (section === 'strings') {
      if (prog && (m = /^\s*(\d+): (.*)$/.exec(l))) prog.strings.push({ index: +m[1], text: m[2] });
      continue;
    }
    if (section === 'disassembly') {
      if ((m = /^;; Function: (.*)$/.exec(l))) {
        flushPending(null, 0);
        const sig = m[1];
        const nm = (/(?:^|[ *])([A-Za-z_#][A-Za-z0-9_#]*)\s*\(/.exec(sig) || [])[1] || sig;
        curFn = { signature: sig, name: nm, instructions: [] };
        if (prog) prog.functions.push(curFn);
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
        if (prog) prog.addressLines.push({ from: m[1], to: m[2], absLine: +m[3] });
      }
      continue;
    }
  }
  flushPending(null, 0);
  // Compatibility aliases: the top program's tables and functions.
  const top = model.programs[0] || newProgram(null);
  model.globals = top.globals;
  model.variables = top.variables;
  model.strings = top.strings;
  model.functions = top.functions;
  model.addressLines = top.addressLines;
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

// Pure: the scaffold file set for a mudlib root (absolute path).
// Returned paths are relative to the mudlib root.
function makeScaffoldFiles(mudlibAbs) {
  return {
    '.lpc/config': [
      'name : lpc-explorer',
      `mudlib directory : ${mudlibAbs}`,
      'log directory : .lpc/log',
      'master file : /.lpc/master',
      'include directories : /include:/.lpc/include',
      'global include file : <globals.h>',
      '',
    ].join('\n'),
    '.lpc/master.lpc': [
      '// Minimal master object scaffolded by the LPC extension: just enough',
      '// applies for lpcc (compile-only) use. Point lpc.lpcc.configFile at',
      '// your real driver config instead once you have one.',
      'string get_root_uid() { return "root"; }',
      'string get_bb_uid() { return "backbone"; }',
      'string creator_file(string file) { return "root"; }',
      'string domain_file(string file) { return "domain"; }',
      'string author_file(string file) { return "author"; }',
      '',
    ].join('\n'),
    '.lpc/include/globals.h':
      '// Global include (every LPC file sees this first). Add shared defines here.\n',
    '.lpc/log/.gitkeep': '',
  };
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
  runStageWithLog,
  debugLogPath,
  parseEnvelopes,
  tokensFromJson,
  astFromJson,
  bytecodeFromJson,
  parseDiagnostics,
  parseTokens,
  parseAst,
  parseSexprs,
  parseBytecode,
  stripNoise,
  outline,
  makeScaffoldFiles,
};
