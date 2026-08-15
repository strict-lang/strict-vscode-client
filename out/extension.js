"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const node_1 = require("vscode-languageclient/node");
const codeActions_1 = require("./codeActions");
const decorations_1 = require("./decorations");
const diagnostics_1 = require("./diagnostics");
const paths_1 = require("./paths");
const scrunchCache_1 = require("./scrunchCache");
const scrunch_1 = require("./scrunch");
const server_1 = require("./server");
const runMethodCommand = 'strict-vscode-client.run';
const runFileCommand = 'strict-vscode-client.runFile';
const restartServerCommand = 'strict-vscode-client.restartServer';
let client;
let serverHandles;
let output;
let decorations;
let scrunch;
let diagnosticHighlighter;
let clientCodeActions;
async function activate(context) {
    output = vscode.window.createOutputChannel('Strict');
    decorations = new decorations_1.DecorationController(context.extensionPath);
    scrunch = (0, scrunch_1.registerScrunch)(decorations);
    diagnosticHighlighter = new diagnostics_1.DiagnosticHighlighter();
    (0, decorations_1.registerDecorationLifecycle)(context, decorations);
    context.subscriptions.push(output, diagnosticHighlighter, scrunch);
    context.subscriptions.push(vscode.window.registerFileDecorationProvider({
        provideFileDecoration(uri) {
            if (!(0, scrunchCache_1.isStrictBinaryPath)(uri.fsPath)) {
                return undefined;
            }
            return {
                color: new vscode.ThemeColor('gitDecoration.ignoredResourceForeground'),
                tooltip: 'Cached compiled bytecode'
            };
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand(runFileCommand, () => runCurrentFile(context)), vscode.commands.registerCommand(restartServerCommand, () => restartServer(context)), vscode.commands.registerCommand('strict-vscode-client.scrunch.focus', () => scrunch.showInTesting()), vscode.commands.registerCommand('strict-vscode-client.scrunch.showLineTests', () => scrunch.showLineTests()), vscode.commands.registerCommand(decorations_1.showResultCommand, (uri, lineNumber) => scrunch.showResult(uri, lineNumber)), vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('strict')) {
            void restartServer(context);
        }
    }));
    await startServer(context);
}
async function deactivate() {
    await stopServer();
}
async function startServer(context) {
    const config = vscode.workspace.getConfiguration('strict');
    const workspaceFolders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
    const launch = (0, paths_1.resolveLanguageServerLaunch)({
        configuredPath: config.get('languageServer.path'),
        dotnetPath: config.get('dotnetPath'),
        workspaceFolders,
        extensionPath: context.extensionPath
    });
    if (!launch) {
        const message = 'Strict language server not found. Build Strict.LanguageServer or set strict.languageServer.path';
        output.appendLine(message);
        void vscode.window.showWarningMessage(message);
        return;
    }
    const clientOptions = {
        documentSelector: [
            { language: 'strict' },
            { pattern: '**/*.strict' }
        ],
        progressOnInitialization: true,
        outputChannel: output,
        connectionOptions: {
            maxRestartCount: 3,
            cancellationStrategy: node_1.CancellationStrategy.Message
        },
        middleware: {
            handleDiagnostics: (uri, diagnostics, next) => {
                const polished = diagnostics.map((item) => (0, diagnostics_1.polishDiagnostic)(item, uri));
                next(uri, polished);
            },
            executeCommand: async (command, args, next) => {
                if (command !== runMethodCommand) {
                    return next(command, args);
                }
                const methodCall = await promptForMethodCall();
                if (!methodCall) {
                    return undefined;
                }
                const documentUri = vscode.window.activeTextEditor?.document.uri.toString();
                if (!documentUri) {
                    void vscode.window.showErrorMessage('Open a .strict file before running a method.');
                    return undefined;
                }
                return next(command, [{ label: methodCall }, documentUri]);
            }
        }
    };
    try {
        serverHandles = await (0, server_1.startLanguageClient)(launch, clientOptions, output);
        client = serverHandles.client;
        client.onNotification('testRunnerNotification', (message) => {
            scrunch.applyResult(message);
        });
        client.onNotification('valueEvaluationNotification', (message) => {
            decorations.applyValues(message);
        });
        registerClientCodeActionsIfNeeded(context);
        output.appendLine(`Strict language server started via ${launch.displayName}`);
        scrunch.onLanguageServerReady();
    }
    catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        output.appendLine(`Failed to start language server: ${text}`);
        void vscode.window.showErrorMessage(`Failed to start Strict language server: ${text}`);
        // Still offer local quick fixes even if the server failed to start
        ensureClientCodeActions(context);
        await stopServer();
    }
}
function registerClientCodeActionsIfNeeded(context) {
    const capabilities = client?.initializeResult?.capabilities;
    const serverHasCodeActions = Boolean(capabilities?.codeActionProvider);
    if (serverHasCodeActions) {
        output.appendLine('Using language server code actions (quick fixes)');
        disposeClientCodeActions();
        return;
    }
    output.appendLine('Language server has no code actions; enabling client-side quick fixes');
    ensureClientCodeActions(context);
}
function ensureClientCodeActions(context) {
    if (clientCodeActions) {
        return;
    }
    clientCodeActions = (0, codeActions_1.registerCodeActionProvider)();
    context.subscriptions.push(clientCodeActions);
}
function disposeClientCodeActions() {
    clientCodeActions?.dispose();
    clientCodeActions = undefined;
}
async function stopServer() {
    if (serverHandles) {
        await serverHandles.stop();
        serverHandles = undefined;
        client = undefined;
    }
}
async function restartServer(context) {
    output.appendLine('Restarting Strict language server...');
    await stopServer();
    await startServer(context);
}
async function promptForMethodCall() {
    const quickPick = vscode.window.createQuickPick();
    quickPick.title = 'Strict method call';
    quickPick.placeholder = 'e.g. Run or (1, 2, 3).Length';
    quickPick.items = [{ label: 'Run' }];
    quickPick.ignoreFocusOut = true;
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) {
                return;
            }
            settled = true;
            quickPick.hide();
            quickPick.dispose();
            resolve(value);
        };
        quickPick.onDidChangeValue(() => {
            const value = quickPick.value.trim();
            if (value.length === 0) {
                quickPick.items = [{ label: 'Run' }];
                return;
            }
            quickPick.items = [{ label: value }, { label: 'Run' }];
        });
        quickPick.onDidAccept(() => {
            const selected = quickPick.selectedItems[0]?.label ?? quickPick.value.trim();
            finish(selected.length > 0 ? selected : undefined);
        });
        quickPick.onDidHide(() => finish(undefined));
        quickPick.show();
    });
}
async function runCurrentFile(context) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'strict') {
        void vscode.window.showErrorMessage('Open a .strict file to run.');
        return;
    }
    if (editor.document.isDirty) {
        const saved = await editor.document.save();
        if (!saved) {
            return;
        }
    }
    const config = vscode.workspace.getConfiguration('strict');
    const workspaceFolders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
    const launch = (0, paths_1.resolveStrictCliLaunch)({
        configuredPath: config.get('cli.path'),
        dotnetPath: config.get('dotnetPath'),
        workspaceFolders,
        extensionPath: context.extensionPath
    });
    if (!launch) {
        void vscode.window.showErrorMessage('Strict CLI not found. Build the Strict project or set strict.cli.path');
        return;
    }
    const filePath = editor.document.uri.fsPath;
    const { command, args } = (0, paths_1.buildRunFileArgs)(launch, filePath);
    const terminal = vscode.window.terminals.find((item) => item.name === 'Strict')
        ?? vscode.window.createTerminal({ name: 'Strict' });
    terminal.show();
    const commandLine = formatCommand(command, args);
    output.appendLine(`Running: ${commandLine}`);
    terminal.sendText(commandLine, true);
}
function formatCommand(command, args) {
    return [command, ...args].map(quoteIfNeeded).join(' ');
}
function quoteIfNeeded(value) {
    if (value.length === 0) {
        return '""';
    }
    if (!/[\s"]/g.test(value)) {
        return value;
    }
    return `"${value.replace(/"/g, '\\"')}"`;
}
//# sourceMappingURL=extension.js.map