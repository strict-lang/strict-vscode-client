# Strict Language for VS Code

Edit, test and run [Strict](https://strict-lang.org/) (`.strict`) files in Visual Studio Code. Everything runs through
the native Strict compiler `strict.exe`, which is written in Strict and compiled by itself.

## Features

- **Get Started** — the welcome page (opens after installing, **Strict: Get Started**) shows strict-lang.org in VS Code
  and walks through Hello World, tests and native builds.
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
  operators between them. Every suggestion passed all tests of the method on the Strict VM (`strict test <file> -`
  with the code on standard input, the file stays as it is, about 40 ms each).
- **No reinvented wheels** — a method that an existing method already does is an error (`MethodAlreadyExists`):
  `strict check` reports a body copied from another method, the extension a call of an existing method (its copy with
  other names, the same name or the same test values) that passes all its tests, e.g. writing `Clamped` on a type with
  `has celsius Number` next to `Number.Clamp`. The quick fix replaces the implementation with that call, the related
  information links the existing method.
- **SCrunch** — every `.strict` file in the workspace is tested when the folder opens (`strict test`, the
  inline tests on the Strict VM). Saving a file (also outside VS Code) re-tests it first, then every file that mentions
  its type, directly or through other types. Strict itself skips a type whose `.strictbinary` is up to date (no file
  it read changed) and reports it as passed, the Testing view shows `cached` then. Only the lines Strict reports are
  tests: a line it did not print is no test (also not a passed one). The status bar shows the passed, failed and slow
  tests and spins while Strict runs, errors of `strict test` (parse errors, unknown types) mark the type as errored.
- **Inline test marks** — ✓/✗ in the gutter on test lines, green/red dots on covered implementation lines, `expected … got …`
  after a failing `is` test, `✓ 20us` after each method header.
- **Test timings** — every test shows how long it took (Strict prints it, `(0.02 ms)`): in the hover and in the Testing
  view, which sums methods and types (`…` > Sort by Duration, View as List). Tests and methods from
  `strict.slowTestMilliseconds` (10 ms) on show `slow: 238ms` after the line and get the `slow` tag (filter the Testing
  view with `@strict.scrunch:slow`), a test over twice as slow as its last run shows `slow: 238ms (was 12ms)`. The last
  times are remembered, cached types show them. A type whose whole `strict test` (start, compile, tests, exit) takes 1 s
  or more shows `strict test 65.6s` in the Testing view and in the Strict output, most take 30-250 ms.
  **SCrunch: Show Slowest Tests** lists those types and the slowest tests and opens one,
  Run in the Testing view (also the gutter, Run Test at Cursor, Rerun Failed) tests the type again without its cache
  to time it, **SCrunch: Time All Tests** does that for every type.
- **Coverage and slow lines** — **Run with Coverage** (Testing view, gutter, **Test: Run All Tests with Coverage**)
  builds the tests of a type natively and counts every line (`strict test <file> lines`, 0.5-20 s): the Test Coverage
  view and the coverage gutter show how often each implementation line ran, lines that never ran lose their green mark,
  and lines taking `strict.slowTestMilliseconds` or more show `slow: 25ms (self 2.0ms, 340 times)` (the time includes
  the methods the line calls, self does not). The counts stay until the type is tested again. Native times are faster
  than usual, they are not remembered for `slow: … (was …)`, a failed native build keeps the last results.
- **Testing view** — package folder → type → methods with tests. Refresh re-tests the whole workspace. `Run` methods
  without tests are run on request (Run Manual profile) and show their output. Test Results groups methods by type, only
  types whose results changed are published again (VS Code shows the type and package of each method in grey, durations
  are in the Testing view), stack frames in the output are clickable `file:line` links.
- **Generated files hidden** — `files.exclude` defaults hide `.strictbinary`, and `.test`, `.exe`, `.mlir`, `.ll` next
  to their `.strict` file. Builds without extension (Linux) nest under it with `explorer.fileNesting.enabled`.
- **Validator diagnostics** — `strict check` runs over the folder of every tested file (unused members,
  parameters and variables, line and method limits, tab indentation). Errors Strict reports while testing a file
  (`ParsingFailed`, `TypeNotFound`, ...) are shown on the line it names, crashes on the first line. Unused code is faded,
  the rule name links to the line of Strict's `Validators` reporting it (without a Strict repository to the rules section
  of the Strict README).
- **Quick fixes** — lightbulb / **Alt+Enter** for the rules `strict check` reports: `let` or `has` becomes `constant`
  (`UseConstantHere`), a never changed `mutable` becomes `let`, spaces become tabs, unused variables and members are
  removed, an unused parameter too when no call passes a value for it, `listNumbers List(Number)` becomes `numbers`
  everywhere it is used, names hiding a member or using a keyword start a rename, `MethodAlreadyExists` calls the existing
  method instead. `TypeNotFound`, `NameNotFound` and `MethodNotFound` offer **Change to** the 3 closest types, names in
  scope or methods of the value's type.
- **Fix All** (`source.fixAll.strict`) applies the fixes that never change what code does (`let` becomes `constant`, a never
  changed `mutable` becomes `let`) to the whole file at once, e.g.
  on every save: `"[strict]": { "editor.codeActionsOnSave": { "source.fixAll.strict": "explicit" } }`.
- **Strict: Run File** (`Ctrl+Shift+R`, play button in the editor title) runs the file's `Run` method in a terminal.
  **Strict: Run File with Arguments...** passes arguments to `Run(numbers)` style methods.
- **Find All References** (`Shift+F12`), **Rename** (`F2`), **Go to Type Definition**, **Go to Implementation**
  (`Ctrl+F12`) and **Call Hierarchy** (`Shift+Alt+H`) — members and methods are found where the value before the dot has
  their type (like completion), parameters and locals inside their method, types also as plural (`Vector2s`), in
  `List(Type)`, `Package/Type` and members or parameters named after them (`has logger`), tests included. Renaming a type
  renames its file and those members, an implicitly typed member or parameter keeps its type (`has logger` renamed to
  output is `has output Logger`); keywords, `value`, `index` and base types of Strict keep their names. Go to
  Implementation on a trait (methods without bodies like `Iterator`) lists the types having it or their method, Call
  Hierarchy shows the calling methods (tests marked) and the methods an implementation calls.
- **Build and update** — **Strict: Build Native Executable** runs the tests of a file, then builds `Name.exe`
  (`strict build`), **Strict: Update Packages** refreshes the packages copied into a folder (`strict update`). Run File,
  Build and Update are also in the Explorer context menu of `.strict` files and folders.
- **CodeLens** — `Run | Run with Arguments… | Build Native` above every `Run` method without tests (`Run` only when it
  needs no arguments, a `Run` with tests is a normal method).
- **Tasks** — **Tasks: Run Task** → **strict** lists `test` (test group) and `check` of each workspace folder, `build` of
  the current file (build group) and `Run <Type>` for every type whose `Run` needs no arguments. The `$strict` problem
  matcher puts check issues, failed tests, errors like `ParsingFailed` and stack frames of their output into Problems
  when the task runs in its workspace folder (the repository root, see Known limitations).
- **Snippets** — `method` (header with its first test), `run` (`Run` with `has logger`), `for`, `if`, `then`, `has`,
  `constant`, `mutable` and `let`. A new `.strict` file can start from the **New type** template, named like its file.
- **Language status** — `{}` in the status bar of a `.strict` file shows `strict <version>` and the Strict folder in use,
  an error when there is none. **Strict: Select Strict Folder** picks another one (with its version) for `strict.root`.
- **Ruler** at 120 characters, the line limit of Strict.
- **Strict: Evaluate** (`Shift+Enter` on a selection) shows the value of the selected expression after its line
  (`= 212`, also in its hover) until the selection changes, or the error Strict reports. The expression runs as the first
  test of its method, the edited code goes to `strict test <file> -` on standard input.
- **Fill expected value** — the quick fix on a test ending in `is` or `is ?` evaluates its left side the same way and
  completes the test with the value, e.g. `Celsius(100).Fahrenheit is` becomes `Celsius(100).Fahrenheit is 212`, an
  error value becomes `Error("InvalidSoundHandle")`.
- **Inlay hints** — `let`, `constant`, `mutable` and `for x in` variables show their type (`let doubled: Vector2 = ...`),
  literal arguments the parameter or member they are passed as (`Clamp(minimum: 0.5, maximum: 1.5)`,
  `Range(Start: 0, ExclusiveEnd: 3)`), variables passed as arguments show nothing. Hover shows the type of variables,
  `value` and `index`: inside `for numbers`, `for characters` or `for Range(0, 3)` `value` is the element, also around a
  nested `for x in list`, outside of loops the own type.
- **Semantic highlighting** — every name that resolves: types (`defaultLibrary` for the types of the Strict folder),
  methods, `has` members as properties, constants as enum members, parameters and variables (`readonly` for `let` and
  `constant`, `mutable` for `mutable` members and variables). Names on test lines get the `test` modifier, e.g.
  `"editor.semanticTokenColorCustomizations": { "rules": { "*.test:strict": { "italic": true } } }`.
- **Completion by type** — items of the type the cursor needs come first (the parameter of the call around it, the
  return type on the last line of a method), `true` and `false` are offered, `has ` completes on the space, types show
  their members and method headers and insert their constructor in methods (`Vector2(numbers)`).
- **Formatter** — **Format Document** (`Shift+Alt+F`) turns leading spaces into tabs, removes trailing whitespace and
  blank lines inside methods and at the end of the file, then `strict format` prints the code in its one canonical form
  (spaces around operators, no redundant brackets). A file Strict can't parse, or whose print changes more than
  whitespace and brackets, only gets the whitespace fixes, so does **Format Selection**. It runs on save only when you
  turn on `editor.formatOnSave`.
- **Refactorings** — lightbulb / `Ctrl+.` on an expression selected in a method body: **Extract to let** declares
  `let number = numbers(0)` above the line (`constant` when it only uses literals, constants and types) and puts the
  name in its place. On a `let` used once later in its method **Inline** puts the value there (in brackets inside other
  expressions) and removes the `let`.
- **Create from usage** — `Alt+Enter` on a `MethodNotFound`, `NameNotFound` or `TypeNotFound` error: **Create method**
  appends the missing method to the type it is called on, parameter types from the arguments, the return type from the
  expected value and the test line as its first test (`Counter(3).Scaled(2) is 6` gives
  `Scaled(number Number) Number`). **Create type** adds `Type.strict` next to the file with `has` members from the
  constructor arguments.

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

`"command": "test"` (or `check`, `build`, `update`) runs that `strict` command on `file` (a file or folder) instead of
its `Run` method. Without tasks.json **Tasks: Run Task** → **strict** already lists them (see Tasks above).

## Extension Settings

| Setting | Meaning |
| --- | --- |
| `strict.root` | Strict folder with `strict.exe` and the base types. Empty = newest found (see above) |
| `strict.slowTestMilliseconds` | Tests, methods and lines of coverage runs taking at least this long are marked slow (default 10) |
| `strict.timeoutSeconds` | SCrunch stops `strict test` of a type after this many seconds (default 60) |
| `strict.suggestImplementations` | Suggest implementations from the tests of a method (default true) |
| `strict.checkExistingMethods` | Report `MethodAlreadyExists` for methods an existing method already does (default true) |

## Commands

| Command | Default keybinding | Description |
| --- | --- | --- |
| `Strict: Run File` | `Ctrl+Shift+R` / `Cmd+Shift+R` | Save and run the current file's `Run` method |
| `Strict: Run File with Arguments...` | — | Same, asks for arguments passed to `Run` |
| `SCrunch: Show in Testing window` | — | Focus the Testing view (SCrunch tree) |
| `SCrunch: Show Tests for Line` | — | List tests that covered the current line and show that result |
| `SCrunch: Show Slowest Tests` | — | List the slowest tests of the last runs, open the picked one |
| `SCrunch: Time All Tests (without cache)` | — | Remove the `.strictbinary` caches and run every test again to time it |
| `Strict: Build Native Executable` | — | Save, run the file's tests, then build its native executable in a terminal |
| `Strict: Update Packages` | — | Refresh the packages copied into the folder (`.origin`) from their source |
| `Strict: Select Strict Folder` | — | Pick the Strict folder to use by its version, writes `strict.root` (or empties it) |
| `Strict: Evaluate` | `Shift+Enter` (with a selection) | Show the value of the selected expression after its line and in its hover |
| `Strict: Get Started` | — | Open the welcome page: strict-lang.org, Hello World, tests and native builds |

## What the extension calls

Commands run in the project folder of the file: its git repository, else its workspace folder (Strict looks up types in
it and its sub folders, then next to `strict`). Paths are relative to it with `/` (with `\` Strict finds no `native/`
code), `<root>` is the base types folder Strict would pick itself (`.` in the Strict repository, else the folder of
`strict`), given before arguments so a first one naming a folder is not taken for it:

| Purpose | Command |
| --- | --- |
| Inline tests of a file | `strict test <file>` |
| Coverage of a file | `strict test <file> <root> lines` |
| Validators of a folder | `strict check <folder>` |
| Run a program | `strict <file>`, `strict <file> <root> <arguments>` |
| Verify a suggested or existing implementation | `strict test <file> -` (code on standard input) |
| Build a native executable (tests first) | `strict build <file>` |
| Refresh the copied packages of a folder (run in that folder, Strict copies into it) | `strict update .` |
| Version in the language status and folder picker | `strict version` |
| Evaluate an expression, fill an expected value | `strict test <file> -` (code with `<expression> is 0` as first test) |

Agents can use the same commands to verify `.strict` changes without VS Code, e.g. in `DeltaEngine`:
`../Strict/strict test Fonts/TextWrapper.strict`.

## Known limitations

- Completion, hover and go to definition read the method headers and members of the `.strict` files themselves until
  Strict has its own language server: types are followed through members, parameters, locals and return types only,
  an unknown receiver lists the methods of all types.
- Suggestions and `MethodAlreadyExists` try one level of calls and operators (32 at most, one `strict` process each),
  weak tests let a wrong call pass: add a test that tells them apart.
- Only `Run` methods can be executed.
- Coverage builds every type on its own (a native build each), only lines of the tested type are shown, not those of
  the base types it calls.
- References, rename and call hierarchy follow types like completion does: after a value of unknown type only a member
  just one type has counts, types of the same name in other folders are not told apart (rename only edits files of the
  workspace, Strict folders outside of it are left alone).
- `strict` runs in the project folder of a file, Strict prints paths relative to it. Stack frames name a file next to
  the tested one, in the project or in the base types, SCrunch looks in all three. Tasks use the `$strict` problem
  matcher only when they run in their workspace folder (it reads paths relative to that), frames of types in sub folders
  and of base types point to a missing file there; terminal links of task output work in any folder. In a window
  without folders tasks run in a terminal that takes no input except Ctrl+C and links no files.
- **Evaluate** runs the selection as a test of its method: members and parameters have their default values (`0`, `""`),
  locals of the implementation are unknown (`NameNotFound`). Values are shown as Strict prints them after `got:`.
- Inlay hints, semantic highlighting and completion by type use the same index: operators (`a + b`) are not followed, such
  variables get no type hint, names that do not resolve keep the colors of the grammar.
- Quick fixes change one file: other files keep the old uses of a removed parameter or a renamed list member. The fix
  for a keyword used as a name renames it in its file only, also where it is used as a keyword.
- Format Selection only fixes whitespace, `strict format` formats whole files. Extracted values are named after their type
  when completion knows it, else `extracted`. Create from usage only sees the first error Strict reports, a method call
  not compared with an expected value gets no return type, unknown argument types become `Any`.

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

### 1.0

- Native Strict only: SCrunch tests, validator diagnostics and Run File through `strict` executable
- Run File as a `strict` task, also usable in tasks.json
- Local gutter icons for test results, quick fixes
