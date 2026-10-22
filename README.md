# Strict Language for VS Code

Edit, test, run and build [Strict](https://strict-lang.org/) programs through native `strict.exe`, written in Strict.

## Start

Open folder with `.strict` files. **Strict: Get Started** walks through Hello World, tests and native builds.
Use `run` snippet for a program, or write a method header followed by its tests and implementation.

| Action | Shortcut or command |
| --- | --- |
| Run current file | **F5**, **Ctrl+Shift+R** (macOS **Cmd+Shift+R**) or editor play button |
| Run with arguments | **Strict: Run File with Arguments...** |
| Build executable after testing | **Strict: Build Native Executable** or **Build Native** CodeLens |
| Build for a platform | **Strict: Build for Platform...** (Windows, Windows + Linux, Web; native Linux/macOS on those hosts) |
| Evaluate selection | **Shift+Enter** |
| Quick fix | **Alt+Enter** or **Ctrl+.** |
| Format document | **Shift+Alt+F** |
| Show method in Testing | Editor beaker or **SCrunch: Show in Testing window** |
| Refresh copied packages | **Strict: Update Packages** |

Right-click a game folder or `.strict` file in Explorer for **Run File**, **Build Native Executable**, or **Build for Platform...**. Folders prefer their same-named program (e.g. `WebWars/WebWars.strict`); folders with several programs show a picker. F5 runs the current file without starting a debugger. Only `Run` methods can launch programs.

SCrunch restores successful test results from valid `.strictbinary` source/data manifests and persists results and visible values across window reloads. Changed dependencies invalidate affected successful results. Failed results are also persisted; without a native success cache, their input check conservatively covers the project. **Time All Tests (without cache)** and explicit test runs still force a retest.

## Editing

- Syntax and semantic highlighting, snippets, completion, hover, signature help, outline and workspace symbols.
  Completion follows types through members, parameters, locals, loops and method returns; matching return types rank first.
- Go to Definition (**F12**), Type Definition, Implementation (**Ctrl+F12**), References (**Shift+F12**),
  Rename (**F2**) and Call Hierarchy (**Shift+Alt+H**). Renaming a type also renames its file.
- Inlay hints show local types and parameter names for literal arguments. Method tests appear in hover and completion.
- Implementation suggestions appear after a method's tests: **Tab** accepts, **Alt+]** cycles. Each passes those tests.
  `MethodAlreadyExists` identifies duplicate method bodies; quick fixes reuse the existing method.
- Validator errors appear in Problems. Quick fixes address constants, unused declarations, indentation, list names,
  unnecessary `is true`, misspelled names and missing types or methods. **Create from usage**, **Extract to let** and
  **Inline** are available where applicable.
- Formatting fixes whitespace, then uses `strict format` when its output preserves code meaning.
  Selection formatting fixes whitespace only. Enable `editor.formatOnSave` to format on save.
- **Shift+Enter** evaluates a selection inline. A test ending in `is` or `is ?` offers **Fill expected value**.
- Generated binaries and intermediate files are hidden by default. Editor uses tabs and a 120-character ruler.

For safe fixes on save:

```json
"[strict]": {
  "editor.codeActionsOnSave": { "source.fixAll.strict": "explicit" }
}
```

## SCrunch tests

Strict files save automatically after edits. Tests run when a workspace opens and after changes to a type or its
dependencies. Gutter results update first; diagnostics, inline failures and Testing view follow when editing pauses.
Testing view supports run and coverage. Coverage shows line counts and timings; failures link to Strict source.

Slow tests get a `slow` tag. **SCrunch: Show Slowest Tests** lists timings, **Show Tests for Line** finds covering tests,
and **Time All Tests (without cache)** clears test caches before rerunning. Compiler, Bytecode and Runtime folders
run on demand by default.

## Compiler

Clone Strict beside this extension during development:

```text
strict-lang/
  Strict/                 # strict.exe and base types
  strict-vscode-client/
```

Every test, check and run selects newest `strict.exe` from discovered Strict repositories. Without a repository,
selection falls back to PATH, then compiler bundled in installed extension. Base types come from same folder.
Rebuild compiler and next operation uses it. **Strict: Select Strict Folder** sets an explicit location;
Strict output channel shows selected path and version.

| Setting | Default | Meaning |
| --- | --- | --- |
| `strict.root` | Empty | Explicit compiler and base-types folder; empty selects automatically |
| `strict.timeoutSeconds` | `60` | Per-type test timeout |
| `strict.slowTestMilliseconds` | `20` | Threshold for slow tests and coverage lines |
| `strict.onDemandFolders` | Compiler, Bytecode, Runtime | Folders tested on save or explicit run rather than dependency changes |
| `strict.suggestImplementations` | `true` | Suggest implementations verified against method tests |
| `strict.checkExistingMethods` | `true` | Report methods already covered by existing methods |

## Tasks and CLI

**Tasks: Run Task → strict** lists workspace tests and checks, current-file builds and programs with argument-free `Run`.
Saved tasks can pass arguments:

```json
{
  "version": "2.0.0",
  "tasks": [{ "type": "strict", "file": "Examples/Sum.strict", "args": ["5", "10"], "label": "Sum" }]
}
```

Set `"command"` to `"test"`, `"check"`, `"build"` or `"update"` to run that command on `file` instead.
`$strict` problem matcher reads test failures, validation issues and errors relative to workspace folder.

Extension runs commands in file's git repository, else workspace folder, else file's folder. Paths use `/`.
You can reproduce checks directly: `strict test <file>`, `strict check <folder>`, `strict build <file>`.
`strict test <file> -` reads edited source from stdin; coverage adds `lines`. Program arguments follow base-types root:
`strict <file> <root> <arguments>`. Package updates run as `strict update .` in target folder.

## Limits

Type information and navigation use a local source index until Strict provides a language server. Unknown receivers,
operators and ambiguous type names can reduce precision. Rename only edits workspace files. Quick fixes generally
edit one file, so review uses elsewhere after removing a parameter or renaming a member.

Evaluation uses member and parameter defaults; implementation locals are unavailable. Coverage builds tested types
natively and shows only their own lines. Testing summary duration measures publication, rather than test execution.
Task problem links can miss files outside task's workspace folder; terminal links resolve more locations.
Suggestions try up to 32 one-level calls and operators for the selected unfinished method using `strict test`.
Weak tests can accept wrong behavior; add distinguishing cases. Normal checks report duplicate bodies without searching
for replacements by running tests. Compilers providing `strict suggest` reuse compiled dependencies for the selected
method; older compilers use separate `strict test` processes.

## Development

Install [Bun](https://bun.sh/) and build sibling [Strict repository](https://github.com/strict-lang/Strict#command-line), then:

```powershell
bun install
bun run test       # TypeScript, unit tests and ESLint
bun run watch      # Compile on change
bun run package    # Platform-specific VSIX with compiler and base types
```

**F5** opens sibling Strict repository in Extension Development Host. `STRICT_ROOT` overrides compiler for packaging.
