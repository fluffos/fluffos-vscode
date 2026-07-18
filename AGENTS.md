# fluffos-vscode Agent Guide (AGENTS.md)

This repository is the **packaging and release home** for the LPC (FluffOS)
VS Code extension. It deliberately contains almost no code of its own — the
extension, the grammar contract it is generated from, and their tests all
live in the [fluffos](https://github.com/fluffos/fluffos) repository under
`tools/lpc-syntax/`, pinned here as the `fluffos/` git submodule.

## 1. The one rule that matters

**Never edit extension code here.** There is no extension source in this
repo to edit — `out/` is a build product and the submodule is upstream's
tree. If a task asks for an extension behavior change (highlighting,
formatter, linter, lpcc integration, settings):

1. Make the change in the fluffos repo (`tools/lpc-syntax/`, see its
   AGENTS.md §11 and `tools/lpc-syntax/README.md` — generated assets under
   `vscode/lib/` and `vscode/syntaxes/` are emitted by `generate_ebnf.py`
   and must never be hand-edited).
2. After it merges upstream, bump the submodule pin here (see §4).

The only things developed in this repo: `scripts/build.mjs`, the workflows
under `.github/workflows/`, and the docs.

## 2. Layout & build flow

```
fluffos/                    # submodule, pinned fluffos commit (the ONLY input)
scripts/build.mjs           # stage + patch metadata + vsce package
out/extension/              # staged copy (generated, gitignored)
out/fluffos-lpc-<ver>.vsix  # the deliverable (generated, gitignored)
```

`scripts/build.mjs` (Node ≥ 18, dependency-free; `@vscode/vsce` is fetched
via `npx` at package time):

* copies `fluffos/tools/lpc-syntax/vscode/` → `out/extension/`,
* patches the staged `package.json` — `--version X.Y.Z` (release builds),
  `repository` → this repo, and a `fluffos.commit` field recording the pin,
* writes the MIT `LICENSE.txt` into the stage (upstream declares
  `"license": "MIT"` but ships no file; vsce wants one),
* runs `npx @vscode/vsce package` (skip with `--no-package` — the only mode
  that works offline).

**vsce rejects semver prerelease/build suffixes** (`1.2.3-beta` fails);
`build.mjs` validates `--version` against plain `X.Y.Z` for that reason.
Don't "fix" that validation.

## 3. Test & verify

```bash
git submodule update --init            # once, after clone
node fluffos/tools/lpc-syntax/test.mjs # THE test gate (dependency-free)
node scripts/build.mjs                 # packaging must also succeed
```

`test.mjs` comes from the pinned fluffos commit and asserts, among much
else, that the extension's generated assets (`vscode/lib/*`,
`vscode/syntaxes/lpc.tmLanguage.json`) are byte-identical to their
generators' output — so a broken or hand-edited pin fails loudly here.
There is no test content in this repo itself; do not add a parallel suite
that could drift from upstream's.

## 4. CI / CD map

| Workflow | Trigger | Does |
|---|---|---|
| `ci.yml` | push to `main`, PRs, manual | `test.mjs` + packaging dry run; uploads the `.vsix` as an artifact. |
| `release.yml` | tag `vX.Y.Z`, or manual dispatch with a `version` input (creates the tag) | tests, packages with `--version`, creates a GitHub Release with the `.vsix` and the pinned commit in the notes; then publishes to the VS Code Marketplace / Open VSX **only if** the `VSCE_PAT` / `OVSX_PAT` repo secrets exist (steps are `if: env.X != ''`-gated — absent secrets skip, never fail). |
| `bump-fluffos.yml` | weekly cron, manual | moves the submodule to latest fluffos master, runs tests + packaging against the new pin, opens a PR. |

Facts that bite:

* **All jobs need `submodules: true` on `actions/checkout`** — without the
  submodule there is nothing to build. `fetch-depth: 1` is deliberate
  (fluffos is large); keep it shallow.
* **PRs opened by `bump-fluffos.yml` don't trigger `ci.yml`** — GitHub
  suppresses workflow runs for events caused by the built-in
  `GITHUB_TOKEN`. The bump workflow already ran the tests against the new
  pin; close/reopen the PR (or push to its branch) if the PR itself needs a
  green check. Switching the workflow to a PAT secret would remove the
  limitation.
* Release versions are **plain `X.Y.Z`** and the tag is `v` + version. The
  dispatch path passes `--target "$GITHUB_SHA"` so `gh release create` can
  mint the tag; the tag-push path must not (the tag already exists).

## 5. Updating the fluffos pin

Prefer merging the automated bump PR. By hand:

```bash
git -C fluffos fetch --depth 1 origin master
git -C fluffos checkout --detach FETCH_HEAD
node fluffos/tools/lpc-syntax/test.mjs && node scripts/build.mjs
git add fluffos
git commit -m "Bump fluffos submodule to $(git -C fluffos rev-parse --short HEAD)"
```

Never point the pin at a commit that isn't on fluffos `master` (PR-branch
commits can be garbage-collected after merge, breaking every future clone
of this repo at that pin). The gitlink plus `.gitmodules` is the entire
contract — there is no version file to keep in sync.

## 6. Licensing split (intentional)

The repo `LICENSE` is GPL-3.0 (chosen at repo creation) and covers the
packaging machinery here. The packaged extension ships MIT license text,
matching the `"license": "MIT"` declaration in upstream's `package.json`.
If either side changes its license, update `scripts/build.mjs` (the
embedded MIT text) and the README's Licensing section together.
