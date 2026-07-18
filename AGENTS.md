# fluffos-vscode Agent Guide (AGENTS.md)

This repository is the **home of the LPC (FluffOS) VS Code extension**:
the extension source lives here under `extension/`, and its language
engine is consumed as an **output of the
[fluffos](https://github.com/fluffos/fluffos) driver repository**, pinned
via the `fluffos/` git submodule.

## 1. The boundary that matters

Two kinds of code exist here, with opposite rules:

* **Extension source (`extension/`)** — `extension.js`, `package.json`,
  `language-configuration.json`, the packaged `README.md`. Developed HERE.
  Behavior changes (activation, diagnostics plumbing, settings, lpcc
  integration, manifest) belong in this repo.
* **The language engine (`extension/lib/`, `extension/syntaxes/`)** —
  tokenizer/formatter/linter, the grammar contract JSON, and the TextMate
  grammar. These are **generated build inputs synced from the submodule**
  (gitignored; `scripts/build.mjs` deletes and recreates them on every
  run). Never edit them, never commit them, never add files to those two
  directories. The engine is developed and tested upstream in fluffos
  `tools/lpc-syntax/` (generated from the compiler's own grammar — see
  that repo's AGENTS.md §11); change it there, then bump the pin here.

Planned: the fluffos WebAssembly driver build will be consumed the same
way (as a pinned output) to provide in-editor compiler diagnostics
without a native `lpcc` binary. (`lpcc` is native-only in fluffos CMake
today — the wasm target needs adding upstream, NODERAWFS-style, before
this repo can consume it.)

## 1b. The Compiler Explorer / phase-2 LSP layering

`extension/lpcc.js` is the lpcc pipeline service: it runs lpcc stage
outputs and parses them into plain-data models (tokens, AST, bytecode,
diagnostics, outline). It NEVER imports `vscode` — 1-based positions,
mudlib-relative paths, plain objects — because the planned phase-2 LSP
server lifts it unchanged and serves the same models over custom LSP
requests. Keep acquisition/parsing there; rendering in `explorer.js`
(the webview); editor plumbing in `extension.js`/`symbols.js`.

lpcc facts the service encodes (verified against a real build):
* stdout mixes driver boot noise around every payload — all parsers
  extract by markers, never line position.
* `--json --tokens` / `--json --ast` (fluffos ≥ 2026-07) emit one-line
  `{"fluffos_lpcc":1,...}` envelopes: token NAMES, AST source LINES, an
  `{"stage":"files"}` companion with the absolute-line segment table
  (AST lines are compilation-unit-absolute, includes inlined; a file's
  numbering continues across non-adjacent segments) and the string
  table for `(string N)` atoms. Prefer these; fall back to text parsing
  for older lpcc.
* Text AST S-expressions contain `(void)`-prefixed ATOM names
  (`(void)assign_local`) that must not be parsed as child lists.
* Bytecode `; file:line` annotations TRAIL the instruction run they
  describe. (The `loop_cond_number` operand-decode desync is fixed
  upstream; parsers still tolerate garbage rows for older pins.)
* `--ast` (text and `--json`) on a file that the driver already loaded
  during boot — the master, the simul_efun object, and everything they
  inherit (every `std/` file in the fluffos testsuite) — emitted
  NOTHING on older lpcc: parse trees only exist during a compile, and
  `find_object()` returned the boot-loaded object without recompiling.
  Fixed upstream (lpcc forces a recompile via the hot-reload path); on
  older pins, including the currently bundled wasm lpcc until the next
  pin bump, a missing ast envelope on an OK compile means "AST
  unavailable" and must degrade gracefully (empty AST view), never be
  treated as a parse error. Bytecode is unaffected (dumped post-hoc
  from the surviving program).
* Parser regressions are pinned by fixtures in `scripts/fixtures/`
  (REAL lpcc output, boot noise kept on purpose). If a stage format
  changes upstream, re-capture: build lpcc, run the stage flags against
  `testsuite/etc/config.test` with fixtures/sample.lpc placed at
  `testsuite/clone/explorer_sample.lpc`.

## 2. Layout & build flow

```
extension/                  # extension source (the part developed here)
extension/lib/              # SYNCED from fluffos/tools/lpc-syntax/ (gitignored)
extension/syntaxes/         # SYNCED TextMate grammar (gitignored)
fluffos/                    # submodule, pinned fluffos commit
scripts/build.mjs           # sync + stage + patch metadata + vsce package
scripts/test.mjs            # extension-local checks (runs the sync first)
out/extension/              # staged copy (generated, gitignored)
out/fluffos-lpc-<ver>.vsix  # the deliverable (generated, gitignored)
```

`scripts/build.mjs` (Node ≥ 18, dependency-free; `@vscode/vsce` fetched
via `npx` at package time):

* syncs `{tokenizer,format,lint}.mjs` + `lpc-grammar.json` from
  `fluffos/tools/lpc-syntax/` into `extension/lib/` (with a GENERATED
  banner recording the pin) and the TextMate grammar into
  `extension/syntaxes/` — it probes `tools/lpc-syntax/lpc.tmLanguage.json`
  first, then the pre-move `tools/lpc-syntax/vscode/syntaxes/` location,
  so both old and new pins build,
* stages `extension/` → `out/extension/`, patching the staged
  `package.json` — `--version X.Y.Z` (release builds) and a
  `fluffos.commit` field recording the pin,
* writes the MIT `LICENSE.txt` into the stage (the manifest declares
  `"license": "MIT"`; vsce wants the file),
* runs `npx @vscode/vsce package` (skip with `--no-package` — the only
  mode that works offline).

**vsce rejects semver prerelease/build suffixes** (`1.2.3-beta` fails);
`build.mjs` validates `--version` against plain `X.Y.Z` for that reason.
Don't "fix" that validation.

## 2b. Zero-setup compiler chain

`extension/config.js` resolves lpcc settings with defaults:
`lpc.lpcc.path` unset → bundled `bin/lpcc.js` (wasm, run via node);
`lpc.lpcc.configFile` unset → `<workspace>/.lpc/config`. The
`lpc.initConfig` command scaffolds that config from
`makeScaffoldFiles()` in lpcc.js (kept vscode-free so tests and the
phase-2 LSP can use it). Scaffold facts learned empirically against a
real driver: `name`, `mudlib directory`, `log directory`, `master file`,
and `include directories` are the mandatory config lines; the master
must define the uid applies (`get_root_uid` etc.) or boot aborts; and
`global include file` must name a REAL file — an empty value gets
quoted into `""` by the driver's config parser and then fails as an
#include, so the scaffold always ships `.lpc/include/globals.h`.
`scripts/test.mjs` validates the scaffold against a real lpcc when
`LPCC_BIN` is set (local only; CI skips). Bundling: `scripts/build.mjs`
copies `lpcc.js`/`lpcc.wasm` into `extension/bin/` (gitignored) from
`$LPCC_WASM_DIR` or `fluffos/build-wasm/src` when present.

## 2c. The language server

`extension/server/main.js` (official `vscode-languageserver` lib; deps
declared in extension/package.json, installed into the stage at package
time) is protocol plumbing ONLY — all language knowledge comes from
lpcc.js and the synced lib/. Facts that bite:

* Capabilities must advertise `textDocumentSync.save: true` (object
  form) or clients never send didSave and lpcc diagnostics never run.
* Compiler diagnostics land in the DRIVER DEBUG LOG, not stderr, when
  the mudlib's master lacks a log_error apply — `runStageWithLog()`
  brackets the log by byte offset around the compile and parses only
  the appended slice (stale entries can never republish). Lexer-class
  errors ("Cannot #include x") have NO column; DIAG_RE's column is
  optional.
* Tokenizer offsets are JS string indices == UTF-16 code units == LSP's
  default position encoding; positionAt/offsetAt align with no
  conversion.
* `scripts/test-nvim.lua` is the REAL-CLIENT gate: headless Neovim's
  built-in LSP client against a real fluffos testsuite checkout
  (`TESTSUITE=... LPCC_BIN=... nvim --headless -u NONE -l
  scripts/test-nvim.lua` from the repo root) -- catches anything
  VS-Code-specific leaking into the protocol. Verified: real compile
  warnings from /std/base64.lpc publish into nvim diagnostics on save;
  symbols/hover/definition/completion and lpc/model work on
  operators/switch.lpc.
* `scripts/test-lsp.mjs` is the gate: a protocol-level harness driving
  the REAL server over stdio (initialize → didOpen → diagnostics /
  symbols / formatting / hover / definition / completion, plus the
  lpcc-on-save and lpc/model paths when LPCC_BIN is set). Run via
  scripts/test.mjs. The hand-rolled JSON-RPC lives in the harness only;
  the server always uses the official library.
* The VS Code client (extension/client.js, vscode-languageclient, node
  IPC) is default-on via lpc.useLanguageServer; extension.js keeps the
  legacy in-process providers as the fallback path — don't delete them
  until the server has soaked.

## 3. Test & verify

```bash
git submodule update --init             # once, after clone
node fluffos/tools/lpc-syntax/test.mjs  # upstream engine suite (from the pin)
node scripts/test.mjs                   # extension-local checks (syncs first)
node scripts/build.mjs                  # packaging must also succeed

# whole-corpus gate (local only; needs a native lpcc build + the fluffos
# testsuite -- skips cleanly when the env vars are unset):
TESTSUITE=/path/to/fluffos/testsuite LPCC_BIN=/path/to/build/src/lpcc \
  node scripts/test-corpus.mjs          # [--limit N] for a quick smoke
```

`scripts/test-corpus.mjs` sweeps EVERY testsuite `.lpc`/`.c` file (761 at
last count, minus the two raw-byte bad_utf8 fixtures) through all three
layers: the synced engine (tokenize with an exact file-tiling invariant +
outline + lint), the lpcc JSON pipeline (compile everything; model
invariants on bytecode + AST; JSON-vs-text parity on a sample; a compile
failure without diagnostics or a failure banner is a hard FAIL), and the
real LSP server over stdio (didOpen + documentSymbol per file). Compile
failures themselves are expected — the `fail/` fixtures plus the
context-dependent `clone/`/crasher fixtures — and are only tallied. Run
it after touching lpcc.js parsers, the server, or when bumping the pin.

The engine's real test suite lives upstream and runs from the pin — do
not duplicate it here. `scripts/test.mjs` covers only what lives here:
manifest wiring, `extension.js` wiring, language configuration, and a
smoke test that the synced engine actually loads and runs.

For interactive testing: `node scripts/build.mjs --no-package`, then open
`extension/` in VS Code and press F5.

## 4. CI / CD map

| Workflow | Trigger | Does |
|---|---|---|
| `ci.yml` | push to `main`, PRs, manual | upstream engine tests + `scripts/test.mjs` + packaging dry run; uploads the `.vsix` as an artifact. |
| `release.yml` | tag `vX.Y.Z`, or manual dispatch with a `version` input (creates the tag) | tests, packages with `--version`, creates a GitHub Release with the `.vsix` and the pinned commit in the notes; then publishes to the VS Code Marketplace / Open VSX **only if** the `VSCE_PAT` / `OVSX_PAT` repo secrets exist (steps are `if: env.X != ''`-gated — absent secrets skip, never fail). |
| `bump-fluffos.yml` | weekly cron, manual | moves the submodule to latest fluffos master, runs all tests + packaging against the new pin, opens a PR. |

Facts that bite:

* **All jobs need `submodules: true` on `actions/checkout`** — without the
  submodule there is no language engine to sync. `fetch-depth: 1` is
  deliberate (fluffos is large); keep it shallow.
* **PRs opened by `bump-fluffos.yml` don't trigger `ci.yml`** — GitHub
  suppresses workflow runs for events caused by the built-in
  `GITHUB_TOKEN`. The bump workflow already ran the tests against the new
  pin; close/reopen the PR (or push to its branch) if the PR itself needs a
  green check. Switching the workflow to a PAT secret would remove the
  limitation.
* Release versions are **plain `X.Y.Z`** and the tag is `v` + version. The
  dispatch path passes `--target "$GITHUB_SHA"` so `gh release create` can
  mint the tag; the tag-push path must not (the tag already exists).
* The extension's user-facing version is `extension/package.json`'s
  `version` for CI artifacts, but releases override it via `--version`
  from the tag — there is nothing to bump in the manifest for a release.

## 5. Updating the fluffos pin

Prefer merging the automated bump PR. By hand:

```bash
git -C fluffos fetch --depth 1 origin master
git -C fluffos checkout --detach FETCH_HEAD
node scripts/test.mjs && node scripts/build.mjs
git add fluffos
git commit -m "Bump fluffos submodule to $(git -C fluffos rev-parse --short HEAD)"
```

Never point the pin at a commit that isn't on fluffos `master` (PR-branch
commits can be garbage-collected after merge, breaking every future clone
of this repo at that pin). The gitlink plus `.gitmodules` is the entire
contract — there is no version file to keep in sync.

## 6. Licensing split (intentional)

The repo `LICENSE` is GPL-3.0 (chosen at repo creation) and covers this
repo's own machinery. The extension package declares MIT
(`extension/package.json`), and the packaged `.vsix` ships MIT license
text (written by `scripts/build.mjs`). If either side changes, update
`scripts/build.mjs` (the embedded MIT text), `extension/package.json`,
and the README's Licensing section together.
