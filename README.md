# fluffos-vscode — LPC (FluffOS) extension for VS Code

The **LPC (FluffOS)** VS Code extension: syntax highlighting, structural
diagnostics as you type, Format Document / format-on-save, and optional
real compiler errors via the FluffOS `lpcc` front-end.

**The extension source lives here** (`extension/`). Its language engine is
an **output of the [fluffos](https://github.com/fluffos/fluffos) driver
repository**, pinned via the `fluffos/` git submodule: the grammar-driven
tokenizer/formatter/linter and grammar contract
(`fluffos/tools/lpc-syntax/`) are synced into `extension/lib/` and
`extension/syntaxes/` at build time. The engine is generated from the
compiler's own grammar, so the extension can never drift from what the
driver actually accepts — and every release is traceable to an exact
driver commit.

The extension also ships a **Compiler Explorer** (`LPC: Open Compiler
Explorer`, or the circuit-board icon on any LPC editor): per-file Source /
Tokens / AST / Bytecode / Preprocessed views of the real compile pipeline,
with breadcrumbs, an AST graph, and click-through links back to the source.
Source and Tokens work out of the box (bundled grammar tokenizer); the
compiler stages need the `lpc.lpcc.path` + `lpc.lpcc.configFile` settings.
With an lpcc that supports `--json` (fluffos ≥ 2026-07), tokens carry
grammar names and every AST node is click-to-source; older lpcc falls back
to parsing the human-readable dumps.

Planned next: build `lpcc` to WebAssembly upstream (it is native-only in
the fluffos CMake today) and ship it as a consumed artifact here, so the
Explorer's compiler stages and save-time diagnostics work with zero native
setup — and keep the extension web-compatible.

## Install

* Download the `.vsix` from the [latest release](https://github.com/fluffos/fluffos-vscode/releases)
  and run:

  ```bash
  code --install-extension fluffos-lpc-<version>.vsix
  ```

* Or, once published, install **LPC (FluffOS)** from the VS Code Marketplace
  / Open VSX.

Features and settings are documented in
[`extension/README.md`](extension/README.md) (the packaged extension
README).

## Repository layout

| Path | What |
|---|---|
| `extension/` | The extension source: `extension.js`, manifest, language configuration, packaged README. |
| `extension/lib/`, `extension/syntaxes/` | **Generated, gitignored** — synced from the submodule by the build; never edit, never commit. |
| `fluffos/` | Git submodule — the pinned fluffos commit the language engine is taken from. |
| `scripts/build.mjs` | Syncs the engine from the pin, stages `extension/` into `out/extension/`, patches version + `fluffos.commit` metadata, packages the `.vsix` with `@vscode/vsce`. |
| `scripts/test.mjs` | Extension-local checks (manifest, `extension.js` wiring, synced-engine smoke test). |
| `.github/workflows/ci.yml` | Push/PR: upstream tooling tests + extension tests + packaging dry run; uploads the `.vsix` artifact. |
| `.github/workflows/release.yml` | Tag `vX.Y.Z` or manual dispatch: GitHub Release with the `.vsix`; optional Marketplace / Open VSX publish. |
| `.github/workflows/bump-fluffos.yml` | Weekly + manual: bumps the submodule to latest fluffos master, tests, opens a PR. |

## Language server (LSP)

The extension ships a full **LPC language server** (`extension/server/`,
built on the official `vscode-languageserver` library) and uses it by
default (`lpc.useLanguageServer`): diagnostics (structural lint as you
type + real lpcc compiler errors on save, including in `#include`d
files), outline/breadcrumbs, formatting, hover, go-to-definition
(functions/globals/defines, `#include` and `inherit` targets via the
driver config's include dirs), completion, and custom `lpc/*` requests
(`lpc/model`, `lpc/tokens`, `lpc/ast`, `lpc/bytecode`) that serve the
Compiler Explorer's data — the webview is a pure renderer over LSP.
Other editors can run it standalone: `node extension/server/main.js
--stdio` (after `npm install` in `extension/`), configured via
`initializationOptions.settings` / `workspace/didChangeConfiguration`
with the same `lpc.*` shape as the VS Code settings.

## Zero-setup compiler (bundled wasm lpcc)

When the vsix is built with a wasm `lpcc` (`LPCC_WASM_DIR=<dir> node
scripts/build.mjs`, or a `build-wasm/` build inside the submodule), the
extension needs **no settings at all**: with `lpc.lpcc.path` unset it runs
the bundled `bin/lpcc.js` through node, and with `lpc.lpcc.configFile`
unset it uses `<workspace>/.lpc/config` if present. Run **"LPC:
Initialize compiler config"** once in a mudlib workspace to scaffold that
config (a minimal `name`/`mudlib`/`master`/`include` template plus a tiny
master object under `.lpc/` — never overwrites existing files), and
save-time compiler diagnostics plus every Compiler Explorer view light up.
Point the two `lpc.lpcc.*` settings at a real driver build and config to
override.

## Build & develop locally

Requires Node ≥ 18 and git; no npm install (`@vscode/vsce` is fetched by
`npx` at package time).

```bash
git clone --recurse-submodules https://github.com/fluffos/fluffos-vscode
cd fluffos-vscode
node scripts/test.mjs      # sync + all local checks (offline-friendly)
node scripts/build.mjs     # out/fluffos-lpc-<version>.vsix
```

For extension development: run `node scripts/build.mjs --no-package` once
(populates `extension/lib/` and `extension/syntaxes/`), then open
`extension/` in VS Code and press F5 (Run Extension).

## Cutting a release

1. Make sure `main` is green and the submodule points where you want it
   (merge the latest "Bump fluffos pin" PR if one is open).
2. Either push a tag:

   ```bash
   git tag v0.1.0 && git push origin v0.1.0
   ```

   or run the **Release** workflow from the Actions tab with the version as
   input (it creates the tag for you).

The workflow re-runs the tests, packages `fluffos-lpc-<version>.vsix`, and
creates a GitHub Release with the pinned fluffos commit noted. If the
`VSCE_PAT` (VS Code Marketplace) and/or `OVSX_PAT` (Open VSX) repository
secrets are configured, it also publishes there; otherwise those steps are
skipped.

## Updating the fluffos pin

The **Bump fluffos pin** workflow does this weekly (and on demand from the
Actions tab). By hand:

```bash
git -C fluffos fetch origin master
git -C fluffos checkout origin/master
node scripts/test.mjs && node scripts/build.mjs
git add fluffos && git commit -m "Bump fluffos submodule to $(git -C fluffos rev-parse --short HEAD)"
```

## What to change where

* **Extension behavior** (activation, diagnostics plumbing, settings,
  manifest, lpcc integration): here, under `extension/`.
* **The language engine** (tokenizer, formatter, linter, grammar contract,
  TextMate grammar): upstream in fluffos `tools/lpc-syntax/` — it is
  generated from the compiler's grammar and tested there. Change it there,
  then bump the pin here. Never edit `extension/lib/` or
  `extension/syntaxes/`; the build overwrites them.

## Licensing

This repository is licensed under [GPL-3.0](LICENSE). The extension
package declares MIT (`extension/package.json`), and the packaged `.vsix`
ships the MIT license text accordingly.
