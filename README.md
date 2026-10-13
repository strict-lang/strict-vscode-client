# Strict Language for VS Code

Edit, test and run [Strict](https://strict-lang.org/) (`.strict`) files in Visual Studio Code. Everything runs through
the native Strict compiler `strict.exe`, which is written in Strict and compiled by itself.

## Features

- **Syntax highlighting** for `.strict` files, tabs, trimmed lines and indentation after method headers, `if`, `else`
  and `for` set up for `.strict` files.
- **Completion** — after a dot the members and methods of the value's type (`vector.Normalize.`, `"hi".`, `numbers(0).`,
  types of members, parameters, locals, loop variables and return types are followed), otherwise parameters, locals,
  members, keywords and every type of the workspace and the Strict folder (`has ` offers `logger`, `number`, ...).
  Methods insert their required arguments and show their header and tests: the tests are the documentation.
- **Hover**, **Go to Definition** (`F12`), **Signature Help** (`(` and `,`), **Outline** and **Go to Symbol in
  Workspace** (`Ctrl+T`) over all `.strict` types, including `Math`, `NeuralNetworks` and the base types.
- **Implementation from tests** — write a method header and its tests, press Enter after the last test: the empty line
  shows an implementation as ghost text (`Tab` accepts, `Alt+]` shows the next). Calls of existing methods with the same
  name or the same test values come first, then calls on parameters and members returning the right type and
  operators between them. Every suggestion passed all tests of the method on the Strict VM (`strict test` on a
  temporary copy, about 40 ms each).
- **No reinvented wheels** — a method that an existing method of another type already does is an error
  (`MethodAlreadyExists`): either its body copies one (same code with other names), or a call of an existing method with
  the same name or the same test values passes all its tests, e.g. writing `Clamped` on a type with `has celsius Number`
  next to `Number.Clamp`. The quick fix replaces the implementation with that call, the related information links the
  existing method.
- **SCrunch** — every `.strict` file in the workspace is tested when the folder opens (`strict test`, the
  inline tests on the Strict VM). Saving a file (also outside VS Code) re-tests it first, then every file that mentions
  its type, directly or through other types. A file whose `.strictbinary` is not older than its source counts as
  passed without running anything: Strict only writes it when all tests passed.
- **Inline test dots** — green/red gutter marks on tests and covered lines, `expected … got …` after a failing `is` test.
- **Test timings** — every test shows how long it took (hover, Testing view, method and type totals). Tests and methods
  from `strict.slowTestMilliseconds` (10 ms) on show `slow: 238ms` after the line, **SCrunch: Show Slowest Tests** lists
  the slowest of the last runs and opens one. **SCrunch: Time All Tests** removes the `.strictbinary` caches and runs
  everything again, so all tests are timed once.
- **Testing view** — type → methods with tests. Refresh re-tests the whole workspace. `Run` methods without tests are
  run on request (Run Manual profile) and show their output.
- **Validator diagnostics** — `strict check` runs over the folder of every tested file (unused members,
  parameters and variables, line and method limits, tab indentation). Errors Strict reports while testing a file
  (`ParsingFailed`, `TypeNotFound`, ...) are shown on the line it names, crashes on the first line.
- **Quick fixes** — lightbulb / **Alt+Enter** for `ExtraWhitespacesFoundAtBeginningOfLine`, `MethodAlreadyExists` and
  similar.
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

Without a Strict repository the first `strict` on PATH is used (its folder needs the base types too), then the copy of
`strict.exe` and the base types in the `.vsix` (`bun run package`), so the installed extension works on its own. Set
`strict.root` to force one folder. The **Strict** output channel logs which compiler is used
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
| `strict.slowTestMilliseconds` | Tests and methods taking at least this long are marked slow (default 10) |

## Commands

| Command | Default keybinding | Description |
| --- | --- | --- |
| `Strict: Run File` | `Ctrl+Shift+R` / `Cmd+Shift+R` | Save and run the current file's `Run` method |
| `Strict: Run File with Arguments...` | — | Same, asks for arguments passed to `Run` |
| `Show in Testing window` | — | Focus the Testing view (SCrunch tree) |
| `SCrunch: Show Tests for Line` | — | List tests that covered the current line and show that result |
| `SCrunch: Show Slowest Tests` | — | List the slowest tests of the last runs, open the picked one |
| `SCrunch: Time All Tests (without cache)` | — | Remove the `.strictbinary` caches and run every test again to time it |

## What the extension calls

All commands run with the Strict folder as working directory, so its root argument is `.`:

| Purpose | Command |
| --- | --- |
| Inline tests of a file | `strict test <file> .` |
| Validators of a folder | `strict check <folder> .` |
| Run a program | `strict <file> . [arguments]` |
| Verify a suggested or existing implementation | `strict test <temporary copy of the file> .` |

Agents can use the same commands to verify `.strict` changes without VS Code.

## Known limitations

- Completion, hover and go to definition read the method headers and members of the `.strict` files themselves until
  Strict has its own language server: types are followed through members, parameters, locals and return types only,
  an unknown receiver lists the methods of all types.
- Suggestions and `MethodAlreadyExists` try one level of calls and operators (32 at most, one `strict` process each),
  weak tests let a wrong call pass: add a test that tells them apart.
- `strict test` parses every `.strict` file of the folder, one file that does not parse fails the others too. A method
  with only test lines makes `strict` exit with 127 without output, it is shown as a crash on the first line.
- Only `Run` methods can be executed.
- Test durations are the gaps between the streamed `Test passed` lines until Strict prints them itself: the first test
  of a file has none (its gap includes compiling), tests of a file with an up-to-date `.strictbinary` are not run, so not
  timed (**Time All Tests** runs them).

## Development

Uses [bun](https://bun.sh/) for installing and running scripts (tsc and ESLint still run on node, they are faster
there). Strict itself is needed too, preferably cloned next to this repository (see the
[Strict README](https://github.com/strict-lang/Strict) for bootstrapping `strict.exe`), or any `strict` folder on PATH:

```powershell
git clone https://github.com/strict-lang/Strict ../Strict   # then build strict.exe as its README explains
bun install
bun run test         # tsc (prints which strict is used or how to get one), unit tests, ESLint
```

Press **F5** (`Run Extension`) to open the sibling Strict repository in an Extension Development Host.

- `bun run watch` — compile on change (the F5 build task)
- `bun run package` — create a platform specific `.vsix` with a copy of the same `strict.exe` and its base types
  (`STRICT_ROOT` overrides the folder)

## Release Notes

### 0.1.0

- Native Strict only: SCrunch tests, validator diagnostics and Run File through `strict` executable
- Run File as a `strict` task, also usable in tasks.json
- Local gutter icons for test results, quick fixes
