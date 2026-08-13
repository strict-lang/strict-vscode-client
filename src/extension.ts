import * as vscode from 'vscode';
import {
	CancellationStrategy,
	LanguageClient,
	LanguageClientOptions
} from 'vscode-languageclient/node';
import { registerCodeActionProvider } from './codeActions';
import {
	DecorationController,
	registerDecorationLifecycle,
	TestRunnerNotification,
	ValueEvaluationNotification
} from './decorations';
import { DiagnosticHighlighter, polishDiagnostic } from './diagnostics';
import {
	buildRunFileArgs,
	resolveLanguageServerLaunch,
	resolveStrictCliLaunch
} from './paths';
import { registerScrunch, ScrunchController } from './scrunch';
import { ServerHandles, startLanguageClient } from './server';

const runMethodCommand = 'strict-vscode-client.run';
const runFileCommand = 'strict-vscode-client.runFile';
const restartServerCommand = 'strict-vscode-client.restartServer';

let client: LanguageClient | undefined;
let serverHandles: ServerHandles | undefined;
let output: vscode.OutputChannel;
let decorations: DecorationController;
let scrunch: ScrunchController;
let diagnosticHighlighter: DiagnosticHighlighter | undefined;
let clientCodeActions: vscode.Disposable | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	output = vscode.window.createOutputChannel('Strict');
	decorations = new DecorationController(context.extensionPath);
	scrunch = registerScrunch();
	diagnosticHighlighter = new DiagnosticHighlighter();
	registerDecorationLifecycle(context, decorations);
	context.subscriptions.push(output, diagnosticHighlighter, scrunch);
	context.subscriptions.push(
		vscode.commands.registerCommand(runFileCommand, () => runCurrentFile(context)),
		vscode.commands.registerCommand(restartServerCommand, () => restartServer(context)),
		vscode.commands.registerCommand('strict-vscode-client.scrunch.focus', () =>
			vscode.commands.executeCommand('workbench.view.testing.focus')),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('strict')) {
				void restartServer(context);
			}
		})
	);
	await startServer(context);
}

export async function deactivate(): Promise<void> {
	await stopServer();
}

async function startServer(context: vscode.ExtensionContext): Promise<void> {
	const config = vscode.workspace.getConfiguration('strict');
	const workspaceFolders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
	const launch = resolveLanguageServerLaunch({
		configuredPath: config.get<string>('languageServer.path'),
		dotnetPath: config.get<string>('dotnetPath'),
		workspaceFolders,
		extensionPath: context.extensionPath
	});
	if (!launch) {
		const message = 'Strict language server not found. Build Strict.LanguageServer or set strict.languageServer.path';
		output.appendLine(message);
		void vscode.window.showWarningMessage(message);
		return;
	}
	const clientOptions: LanguageClientOptions = {
		documentSelector: [
			{ language: 'strict' },
			{ pattern: '**/*.strict' }
		],
		progressOnInitialization: true,
		outputChannel: output,
		connectionOptions: {
			maxRestartCount: 3,
			cancellationStrategy: CancellationStrategy.Message
		},
		middleware: {
			handleDiagnostics: (uri, diagnostics, next) => {
				const polished = diagnostics.map((item) => polishDiagnostic(item, uri));
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
		serverHandles = await startLanguageClient(launch, clientOptions, output);
		client = serverHandles.client;
		client.onNotification('testRunnerNotification', (message: TestRunnerNotification) => {
			decorations.applyTestResult(message);
			scrunch.applyResult(message);
		});
		client.onNotification('valueEvaluationNotification', (message: ValueEvaluationNotification) => {
			decorations.applyValues(message);
		});
		registerClientCodeActionsIfNeeded(context);
		output.appendLine(`Strict language server started via ${launch.displayName}`);
		scrunch.onLanguageServerReady();
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		output.appendLine(`Failed to start language server: ${text}`);
		void vscode.window.showErrorMessage(`Failed to start Strict language server: ${text}`);
		// Still offer local quick fixes even if the server failed to start
		ensureClientCodeActions(context);
		await stopServer();
	}
}

function registerClientCodeActionsIfNeeded(context: vscode.ExtensionContext): void {
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

function ensureClientCodeActions(context: vscode.ExtensionContext): void {
	if (clientCodeActions) {
		return;
	}
	clientCodeActions = registerCodeActionProvider();
	context.subscriptions.push(clientCodeActions);
}

function disposeClientCodeActions(): void {
	clientCodeActions?.dispose();
	clientCodeActions = undefined;
}

async function stopServer(): Promise<void> {
	if (serverHandles) {
		await serverHandles.stop();
		serverHandles = undefined;
		client = undefined;
	}
}

async function restartServer(context: vscode.ExtensionContext): Promise<void> {
	output.appendLine('Restarting Strict language server...');
	await stopServer();
	await startServer(context);
}

async function promptForMethodCall(): Promise<string | undefined> {
	const quickPick = vscode.window.createQuickPick();
	quickPick.title = 'Strict method call';
	quickPick.placeholder = 'e.g. Run or (1, 2, 3).Length';
	quickPick.items = [{ label: 'Run' }];
	quickPick.ignoreFocusOut = true;
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: string | undefined) => {
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

async function runCurrentFile(context: vscode.ExtensionContext): Promise<void> {
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
	const launch = resolveStrictCliLaunch({
		configuredPath: config.get<string>('cli.path'),
		dotnetPath: config.get<string>('dotnetPath'),
		workspaceFolders,
		extensionPath: context.extensionPath
	});
	if (!launch) {
		void vscode.window.showErrorMessage('Strict CLI not found. Build the Strict project or set strict.cli.path');
		return;
	}
	const filePath = editor.document.uri.fsPath;
	const { command, args } = buildRunFileArgs(launch, filePath);
	const terminal = vscode.window.terminals.find((item) => item.name === 'Strict')
		?? vscode.window.createTerminal({ name: 'Strict' });
	terminal.show();
	const commandLine = formatCommand(command, args);
	output.appendLine(`Running: ${commandLine}`);
	terminal.sendText(commandLine, true);
}

function formatCommand(command: string, args: string[]): string {
	return [command, ...args].map(quoteIfNeeded).join(' ');
}

function quoteIfNeeded(value: string): string {
	if (value.length === 0) {
		return '""';
	}
	if (!/[\s"]/g.test(value)) {
		return value;
	}
	return `"${value.replace(/"/g, '\\"')}"`;
}
