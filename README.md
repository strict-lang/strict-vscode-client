# Strict Language for VS Code

Edit, test and run [Strict](https://strict-lang.org/) (`.strict`) files in Visual Studio Code. Everything runs through
the native Strict compiler `strict.exe`, which is written in Strict and compiled by itself. No .NET,
no language server process.

## Features

- **Syntax highlighting** for `.strict` files
- **SCrunch** — every `.strict` file in the workspace is tested when the folder opens (`strict test`, the
  inline tests on the Strict VM). Saving a file (also outside VS Code) re-tests it first, then every file that mentions
  its type, directly or through other types. A file whose `.strictbinary` is not older than its source counts as
  passed without running anything: Strict only writes it when all tests passed.
- **Inline test dots** — green/red gutter marks on tests and covered lines, `expected … got …` after a failing `is` test.
- **Testing view** — type → methods with tests. Refresh re-tests the whole workspace. `Run` methods without tests are
  run on request (Run Manual profile) and show their output.
- **Validator diagnostics** — `strict check` runs over the folder of every tested file (unused members,
  parameters and variables, line and method limits, tab indentation). Crashes of Strict while testing a file (for now
  also parse errors) are shown on its first line.
- **Quick fixes** — lightbulb / **Alt+Enter** for `ExtraWhitespacesFoundAtBeginningOfLine` and similar.
- **Strict: Run File** (`Ctrl+Shift+R`, play button in the editor title) runs the file's `Run` method in a terminal.
  **Strict: Run File with Arguments...** passes arguments to `Run(numbers)` style methods.

## Always the newest Strict

Each test, check or run looks up `strict.exe` again and takes the newest one of the Strict
repositories found: the workspace folder (or its parent), a `Strict` folder next to the workspace or next to this
extension. That repository also provides the base types (`Number.strict`, `Text.strict`, ...), so everything stays in
sync with it: rebuild `strict.exe` there and the next save already uses it. Nothing is copied during
development, so check out both repositories next to each other:

```text
strict-lang/
  Strict/                 # strict.exe + base types
  strict-vscode-client/   # this extension
```

The `.vsix` (`bun run package`) contains a copy of `strict.exe` and the base types, used only when no Strict
repository is found. Set `strict.root` to force one folder. The **Strict** output channel logs which compiler is used
and its version (`strict version`, e.g. `1.0 2026-10-12 01:27`), again after every rebuild. `bun run compile` and
`bun run package` print it as well.

## Launching a program

Open any `.strict` file with a `Run` method (e.g. `Examples/FizzBuzz.strict`) and press `Ctrl+Shift+R`. For programs
you start often, add a `strict` task to `.vscode/tasks.json` and use **Tasks: Run Task** (or make it the build task):

```json
{
	"version": "2.0.0",
	"tasks": [{ "type": "strict", "file": "Examples/FizzBuzz.strict", "label": "FizzBuzz" }]
}
```

## Extension Settings

| Setting | Meaning |
| --- | --- |
| `strict.root` | Strict folder with `strict.exe` and the base types. Empty = newest found (see above) |

## Commands

| Command | Default keybinding | Description |
| --- | --- | --- |
| `Strict: Run File` | `Ctrl+Shift+R` / `Cmd+Shift+R` | Save and run the current file's `Run` method |
| `Strict: Run File with Arguments...` | — | Same, asks for arguments passed to `Run` |
| `Show in Testing window` | — | Focus the Testing view (SCrunch tree) |
| `SCrunch: Show Tests for Line` | — | List tests that covered the current line and show that result |

## What the extension calls

All commands run with the Strict folder as working directory, so its root argument is `.`:

| Purpose | Command |
| --- | --- |
| Inline tests of a file | `strict test <file> .` |
| Validators of a folder | `strict check <folder> .` |
| Run a program | `strict run <file> . [arguments]` |

Agents can use the same commands to verify `.strict` changes without VS Code.

## Known limitations

- No autocomplete, hover or go to definition until Strict has its own language server.
- Strict reports no line numbers for validator issues: a name is shown on the first line containing it.
- Parse errors currently crash `strict`, the crash diagnostic shows its exit code and output.
- Only `Run` methods can be executed, there are no per-test durations.

## Development

Uses [bun](https://bun.sh/) for installing and running scripts (tsc and ESLint still run on node, they are faster
there):

```powershell
bun install
bun run test         # tsc, unit tests, ESLint
```

Press **F5** (`Run Extension`) to open the sibling Strict repository in an Extension Development Host.

- `bun run watch` — compile on change (the F5 build task)
- `bun run package` — create a platform specific `.vsix` with a copy of `../Strict/strict.exe` and the
  base types (`STRICT_ROOT` overrides the folder)

## Release Notes

### 0.1.0

- Native Strict only: SCrunch tests, validator diagnostics and Run File through `strict.exe`, no .NET
- Run File as a `strict` task, also usable in tasks.json
- Local gutter icons for test results, quick fixes
