# Strict Language for VS Code

Edit and run [Strict](https://strict-lang.org/) (`.strict`) files in Visual Studio Code.

## Features

- **Syntax highlighting** for `.strict` files
- **Language Server** integration (diagnostics, autocomplete, document highlight, quick fixes)
- **Readable diagnostics** — error codes are humanized, exception **messages and extra details** are shown (not just the type name)
- **Quick fixes** — lightbulb / **Alt+Enter** (or **Ctrl+.**) for common issues such as empty lines and bad whitespace
- **SCrunch** — runs next to normal analytics. Parse errors, violations, and failing tests are all blockers. Tests run when a file is opened or saved; a fresh sibling `.strictbinary` means last run parsed, built, and passed — folder load reuses that cache until you edit.
- **Inline test dots** — green/red gutter marks on every covered line; hover lists the tests that called that line. Click a test to see just that result (no rerun). Duration is in microseconds.
- **Testing view** — type → methods that have tests. Green if all good, red if anything needs fixing. **SCrunch: Show in Testing** focuses that tree.
- **Inline variable values** after evaluation notifications
- **Strict: Run File** — runs the current file through the Strict CLI in a terminal
- **Strict: Run Method...** — asks for a method/expression and executes it through the language server
- **Strict: Restart Language Server** — reloads the LSP after runtime rebuilds

## Requirements

Built [Strict](https://github.com/strict-lang/Strict) runtime next to this extension (recommended layout):

```text
strict-lang/
  Strict/                 # runtime + language server
  strict-vscode-client/   # this extension
```

Build the language server with the strict CLI:

```powershell
strict LanguageServer
```

The extension auto-detects:

- `../Strict/LanguageServer/LanguageServer.strictbinary`
- `../Strict/strict.strictbinary`

You can override paths in settings if your layout differs.

## Extension Settings

| Setting | Meaning |
| --- | --- |
| `strict.languageServer.path` | Path to `Strict.LanguageServer.dll`, exe, or project. Empty = auto-detect |
| `strict.cli.path` | Path to `Strict.dll` or exe for **Run File**. Empty = auto-detect |
| `strict.dotnetPath` | `dotnet` host used to launch DLL builds (default `dotnet`), older builds of Strict, should not longer be required |

## Commands

| Command | Default keybinding | Description |
| --- | --- | --- |
| `Strict: Run File` | `Ctrl+Shift+R` / `Cmd+Shift+R` | Save and run current `.strict` file via CLI |
| `Strict: Run Method...` | — | Prompt for expression and run through LSP |
| `Strict: Restart Language Server` | — | Stop/start LSP process |
| `SCrunch: Show in Testing` | — | Focus the Testing view (SCrunch tree) |
| `SCrunch: Show Tests for Line` | — | List tests that covered the current line and show that result |

Also available from the editor title play icon and the editor context menu on `.strict` files.

## Development

```powershell
npm install
npm run compile
npm run test:unit
```

Press **F5** in VS Code (`Run Extension`) to launch an Extension Development Host.

Useful scripts:

- `npm run watch` — compile on change
- `npm run lint` — ESLint
- `npm run package` — create a `.vsix` (requires `@vscode/vsce`)

## How the language server connects

`Strict.LanguageServer` listens on the Windows named pipe `Strict.LanguageServer`. On activation the extension:

1. Resolves the server binary (setting → sibling repo build → PATH)
2. Starts the process
3. Connects over the named pipe with retries
4. Speaks standard LSP plus Strict notifications:
   - `testRunnerNotification` — gutter + SCrunch Test Explorer (expression, method, duration, stack)
   - `valueEvaluationNotification` — inline values

Logs appear in the **Strict** output channel.

## SCrunch MCP (no IDE)

The language server also speaks MCP over stdio so an LLM can verify `.strict` changes without VS Code:

```powershell
dotnet ../Strict/Strict.LanguageServer/bin/Debug/net10.0/Strict.LanguageServer.dll --mcp
```

This repo ships `.mcp.json` and `.grok/config.toml` that start that process. Tools:

| Tool | What it does |
| --- | --- |
| `check` | Parse + diagnostics + SCrunch tests for a file or folder. Fresh `.strictbinary` counts as pass unless `force` is true. `ok: true` means nothing to fix. |
| `status` | Cache freshness only (no re-run) |

After editing Strict files, call `scrunch__check` with the file or folder path. If `ok` is false, fix the `problems` list (same class of error as in the editor: parse, violation, or failing test).

## Known limitations

- Named-pipe transport matches the current language server (Windows-focused)
- Semantic features depend on a working Strict language server build
- Run Method uses the LSP command `strict-vscode-client.run` implemented server-side

## Release Notes

### 0.1.0

- Auto-start Strict language server from sibling repo / settings
- Run File terminal integration and Run Method prompt
- Local gutter icons for test results
- Settings, menus, keybinding, and real README
