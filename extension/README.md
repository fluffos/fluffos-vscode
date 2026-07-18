# LPC (FluffOS)

LPC language support generated from the FluffOS compiler's own grammar
contract, so it cannot drift from what the driver actually accepts.

## Features

* **Syntax highlighting** for `.lpc` files — keywords, types, modifiers,
  operators, preprocessor directives, strings/templates/text blocks,
  `(: ... :)` functionals, `$N` parameters. Declarative TextMate grammar,
  generated from the grammar contract.
* **Structural diagnostics as you type** — illegal characters,
  unterminated strings/templates/block comments/text blocks, unbalanced
  brackets, mismatched `#if`/`#elif`/`#else`/`#endif`.
* **Format Document / format-on-save** — the same grammar-driven
  formatter engine the FluffOS testsuite corpus is formatted with:
  brace-depth reindentation, operator spacing, directives at column 0,
  comments/strings/text blocks left verbatim, and bracket/comma-aware
  line wrapping past `lpc.format.printWidth`. A formatting error never
  blocks a save; the document is just left unchanged.
* **Real compiler errors on save** (optional) — set the two `lpc.lpcc.*`
  settings and the file is compiled with the actual FluffOS front-end;
  its clang-style errors and warnings appear inline, including in
  `#include`d files.

## Settings

| Setting | Meaning |
|---|---|
| `lpc.lint.enabled` | Toggle the built-in structural lint (default on). |
| `lpc.format.enabled` | Toggle the built-in formatter for Format Document / format-on-save (default on). |
| `lpc.format.printWidth` | Preferred maximum line length before wrapping call/declaration argument lists and array/mapping literals one element per line (default 100). |
| `lpc.format.indentSize` | Number of spaces per indent level (default 2). |
| `lpc.lpcc.path` | Path to the `lpcc` binary (FluffOS build target `lpcc`). |
| `lpc.lpcc.configFile` | Driver config file passed to `lpcc`. |
| `lpc.mudlibRoot` | Mudlib root; files are compiled by their path relative to it (default: the workspace folder). |

Legacy mudlibs that name LPC files `.c` can map them per-workspace:

```json
"files.associations": { "*.c": "lpc" }
```

## How it's built

This extension is developed in
[fluffos/fluffos-vscode](https://github.com/fluffos/fluffos-vscode). The
language engine under `lib/` (tokenizer, formatter, linter, grammar
contract) and the TextMate grammar under `syntaxes/` are **generated
build inputs** taken from a pinned commit of the
[fluffos](https://github.com/fluffos/fluffos) driver repository — never
edited here. The pinned commit is recorded in this package's
`package.json` under the `fluffos.commit` key.
