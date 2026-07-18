# fluffos-vscode — LPC (FluffOS) extension for VS Code

Packaging and release home for the **LPC (FluffOS)** VS Code extension:
syntax highlighting, structural diagnostics as you type, Format Document /
format-on-save, and optional real compiler errors via the FluffOS `lpcc`
front-end.

The extension's **source of record is the [fluffos](https://github.com/fluffos/fluffos)
repository** (`tools/lpc-syntax/vscode/`), where it is generated from and
tested against the driver compiler's own grammar contract. This repo pins a
fluffos commit via the `fluffos/` git submodule and builds, tests, and
releases the extension from that pin — so every release is traceable to an
exact driver commit and can never drift from what the compiler accepts.

## Install

* Download the `.vsix` from the [latest release](https://github.com/fluffos/fluffos-vscode/releases)
  and run:

  ```bash
  code --install-extension fluffos-lpc-<version>.vsix
  ```

* Or, once published, install **LPC (FluffOS)** from the VS Code Marketplace
  / Open VSX.

Features, settings (`lpc.lint.*`, `lpc.format.*`, `lpc.lpcc.*`), and usage
are documented in the extension's own
[README](https://github.com/fluffos/fluffos/tree/master/tools/lpc-syntax/vscode).

## Repository layout

| Path | What |
|---|---|
| `fluffos/` | Git submodule — the pinned fluffos commit the extension is built from. |
| `scripts/build.mjs` | Stages `fluffos/tools/lpc-syntax/vscode/` into `out/extension/`, patches the version and repository metadata, records the pinned commit, and packages the `.vsix` with `@vscode/vsce`. |
| `.github/workflows/ci.yml` | Push/PR: grammar tests + packaging dry run; uploads the `.vsix` artifact. |
| `.github/workflows/release.yml` | Tag `vX.Y.Z` or manual dispatch: GitHub Release with the `.vsix`; optional Marketplace / Open VSX publish. |
| `.github/workflows/bump-fluffos.yml` | Weekly + manual: bumps the submodule to latest fluffos master, tests, opens a PR. |

## Build locally

Requires Node ≥ 18 and git; no npm install (`@vscode/vsce` is fetched by
`npx` at package time).

```bash
git clone --recurse-submodules https://github.com/fluffos/fluffos-vscode
cd fluffos-vscode
node fluffos/tools/lpc-syntax/test.mjs   # the test gate CI runs
node scripts/build.mjs                   # out/fluffos-lpc-<version>.vsix
```

`node scripts/build.mjs --no-package` stages without packaging (no network
needed).

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
node fluffos/tools/lpc-syntax/test.mjs && node scripts/build.mjs
git add fluffos && git commit -m "Bump fluffos submodule to $(git -C fluffos rev-parse --short HEAD)"
```

## Changing the extension itself

Don't — not here. Extension code, the grammar contract, and the generated
assets all live in the fluffos repo (`tools/lpc-syntax/`); change them
there (see that repo's AGENTS.md and `tools/lpc-syntax/README.md`), then
bump the submodule pin here. This repo intentionally contains only
packaging and release machinery.

## Licensing

This packaging repository is licensed under [GPL-3.0](LICENSE). The
extension code itself is declared MIT by its upstream
`package.json` in the fluffos repository, and the packaged `.vsix` ships
the MIT license text accordingly.
