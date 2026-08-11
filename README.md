# Strict Language for VS Code

Edit and run [Strict](https://strict-lang.org/) (`.strict`) files in Visual Studio Code.

## Features

- **Syntax highlighting** for `.strict` files
- **Language Server** integration (diagnostics, autocomplete, document highlight, quick fixes)
- **Readable diagnostics** — error codes are humanized (e.g. `EmptyLineIsNotAllowed` → “Empty line is not allowed”), with whole-line highlight
- **Quick fixes** — lightbulb / **Alt+Enter** (or **Ctrl+.**) for common issues such as empty lines and bad whitespace
- **Inline test results** in the gutter (green/red) from the language server test runner
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
   - `testRunnerNotification` — gutter test pass/fail
   - `valueEvaluationNotification` — inline values

Logs appear in the **Strict** output channel.

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
