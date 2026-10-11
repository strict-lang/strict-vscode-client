import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerCodeActionProvider } from './codeActions';
import { DecorationController, registerDecorationLifecycle, showResultCommand } from './decorations';
import { DiagnosticHighlighter, polishDiagnostic } from './diagnostics';
import { checkIssues, crashText, dependents, issueLine, runStrict, StrictRun, testResults } from './nativeCompiler';
import { compilerFile, findStrictRoot, normalizeFsPath } from './paths';
import { hasFreshBinary, isStrictBinaryPath } from './scrunchCache';
import { discoverStrictTests } from './scrunchDiscover';
import { registerScrunch, ScrunchTester } from './scrunch';
import { TestRunnerNotification } from './testResults';

const notFound = `Strict not found: build ${compilerFile} in the Strict repository next to this extension or set strict.root`;
const parallelRuns = Math.max(1, os.cpus().length - 1);
const cachedPass: StrictRun = { exitCode: 0, output: 'All tests passed in the cached .strictbinary', durationMs: 0 };
let output: vscode.OutputChannel;
let extensionPath: string;

export function activate(context: vscode.ExtensionContext): void {
	output = vscode.window.createOutputChannel('Strict');
	extensionPath = context.extensionPath;
	const decorations = new DecorationController(context.extensionPath);
	registerDecorationLifecycle(context, decorations);
	const tester = new NativeTester((result) => scrunch.applyResult(result));
	const scrunch = registerScrunch(decorations, tester);
	if (!strictRoot()) {
		output.appendLine(notFound);
		void vscode.window.showWarningMessage(notFound);
	}
	context.subscriptions.push(output, tester, scrunch, new DiagnosticHighlighter(), registerCodeActionProvider(),
		vscode.window.registerFileDecorationProvider({
			provideFileDecoration: (uri) => isStrictBinaryPath(uri.fsPath)
				? { color: new vscode.ThemeColor('gitDecoration.ignoredResourceForeground'), tooltip: 'Cached compiled bytecode' }
				: undefined
		}),
		vscode.tasks.registerTaskProvider('strict', {
			provideTasks: () => [],
			resolveTask: (task) => runTask(task.definition, task.scope)
		}),
		vscode.commands.registerCommand('strict-vscode-client.runFile', () => runCurrentFile([])),
		vscode.commands.registerCommand('strict-vscode-client.run', async () => {
			const text = await vscode.window.showInputBox({ prompt: 'Arguments passed to Run', placeHolder: 'e.g. 5 10' });
			if (text !== undefined) {
				await runCurrentFile(text.split(/\s+/).filter(Boolean));
			}
		}),
		vscode.commands.registerCommand('strict-vscode-client.scrunch.focus', () => scrunch.showInTesting()),
		vscode.commands.registerCommand('strict-vscode-client.scrunch.showLineTests', () => scrunch.showLineTests()),
		vscode.commands.registerCommand(showResultCommand, (uri: string, lineNumber: number) =>
			scrunch.showResult(uri, lineNumber)),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('strict')) {
				void scrunch.discoverWorkspace();
			}
		})
	);
}

function strictRoot(): string | undefined {
	return findStrictRoot(vscode.workspace.getConfiguration('strict').get<string>('root'),
		vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [], extensionPath);
}

async function runCurrentFile(args: string[]): Promise<void> {
	const document = vscode.window.activeTextEditor?.document;
	if (!document || document.languageId !== 'strict') {
		void vscode.window.showErrorMessage('Open a .strict file to run.');
		return;
	}
	if (document.isDirty && !(await document.save())) {
		return;
	}
	const task = runTask({ type: 'strict', file: document.uri.fsPath, args },
		vscode.workspace.getWorkspaceFolder(document.uri));
	if (task) {
		await vscode.tasks.executeTask(task);
	}
}

/** `strict` task, also usable in tasks.json: { "type": "strict", "file": "Examples/FizzBuzz.strict", "args": [] } */
function runTask(definition: vscode.TaskDefinition, scope?: vscode.WorkspaceFolder | vscode.TaskScope): vscode.Task | undefined {
	const root = strictRoot();
	if (!root) {
		void vscode.window.showErrorMessage(notFound);
		return undefined;
	}
	const folder = typeof scope === 'object' ? scope.uri.fsPath : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const file = path.resolve(folder ?? root, String(definition.file));
	return new vscode.Task(definition, scope ?? vscode.TaskScope.Workspace, `Run ${path.basename(file, '.strict')}`, 'Strict',
		new vscode.ProcessExecution(path.join(root, compilerFile), [path.relative(root, file), '.', ...(definition.args ?? [])], { cwd: root }));
}

/** Runs inline tests (`test`) and validators (`check`) with the newest strict compiler, several processes at once. */
class NativeTester implements ScrunchTester, vscode.Disposable {
	private readonly checks = vscode.languages.createDiagnosticCollection('strict');
	private readonly crashes = vscode.languages.createDiagnosticCollection('strict tests');
	private readonly files = new Set<string>();
	private readonly queue = new Set<string>();
	private running = 0;
	private usedBuild = '';

	constructor(private readonly report: (result: TestRunnerNotification) => void) {}

	public dispose(): void {
		this.checks.dispose();
		this.crashes.dispose();
	}

	public testAll(files: string[]): void {
		files.forEach((file) => this.files.add(file));
		this.enqueue([...new Set(files.map((file) => path.dirname(file))), ...files]);
	}

	public changed(file: string): void {
		this.files.add(file);
		const sources = new Map([...this.files].map((known) => [known, readText(known)]));
		this.enqueue([file, path.dirname(file), ...dependents(file, sources)], true);
	}

	public deleted(file: string): void {
		this.files.delete(file);
		this.checks.delete(vscode.Uri.file(file));
		this.crashes.delete(vscode.Uri.file(file));
	}

	public async run(uri: vscode.Uri, methodName: string): Promise<void> {
		const root = strictRoot();
		if (!root || methodName !== 'Run') {
			throw new Error(root ? 'strict only runs Run methods' : notFound);
		}
		const result = await runStrict(root, [path.relative(root, uri.fsPath), '.']);
		const method = discoverStrictTests(readText(uri.fsPath)).find((item) => item.name === methodName);
		this.report({
			lineNumber: method?.lineNumber ?? 0, state: result.exitCode === 0 ? 1 : 0, uri: uri.toString(), methodName,
			consoleOutput: result.output, durationMs: result.durationMs,
			message: result.exitCode === 0 ? undefined : `Exit code ${result.exitCode}`
		});
	}

	private enqueue(entries: string[], first = false): void {
		const waiting = first ? [...this.queue] : [];
		if (first) {
			this.queue.clear();
		}
		for (const entry of [...entries, ...waiting]) {
			this.queue.add(entry);
		}
		this.next();
	}

	private next(): void {
		const root = strictRoot();
		const compiler = root ? path.join(root, compilerFile) : '';
		const build = `${compiler} ${fs.statSync(compiler, { throwIfNoEntry: false })?.mtimeMs}`;
		if (root && build !== this.usedBuild) {
			this.usedBuild = build;
			void runStrict(root, ['version']).then((version) => output.appendLine(`Using ${compiler} ${version.output.trim()}`));
		}
		while (root && this.running < parallelRuns && this.queue.size > 0) {
			const entry = this.queue.values().next().value as string;
			this.queue.delete(entry);
			this.running++;
			void (entry.endsWith('.strict') ? this.test(root, entry) : this.check(root, entry)).finally(() => {
				this.running--;
				this.next();
			});
		}
	}

	private async test(root: string, file: string): Promise<void> {
		const result = hasFreshBinary(file) ? cachedPass : await runStrict(root, ['test', path.relative(root, file), '.']);
		if (!this.files.has(file)) {
			return;
		}
		const uri = vscode.Uri.file(file);
		const source = readText(file);
		const crash = crashText(result);
		this.crashes.set(uri, crash ? [new vscode.Diagnostic(lineRange(source, 0), crash, vscode.DiagnosticSeverity.Error)] : []);
		if (crash) {
			output.appendLine(`${file}: ${crash}`);
		}
		for (const notification of testResults(source, uri.toString(), result)) {
			this.report(notification);
		}
	}

	private async check(root: string, folder: string): Promise<void> {
		const relative = path.relative(root, folder);
		const result = await runStrict(root, ['check', relative.startsWith('..') || path.isAbsolute(relative) ? folder : relative || '.', '.']);
		if (!/^Validation issues: \d+$/m.test(result.output)) {
			output.appendLine(`Checking ${folder} failed with exit code ${result.exitCode}\n${result.output}`);
			return;
		}
		const issues = checkIssues(result.output, root);
		const files = new Map([...this.files].filter((file) => normalizeFsPath(path.dirname(file)) === normalizeFsPath(folder)).
			concat(issues.map((issue) => issue.file)).map((file) => [normalizeFsPath(file), file]));
		for (const [key, file] of files) {
			const source = readText(file);
			this.checks.set(vscode.Uri.file(file), issues.filter((issue) => normalizeFsPath(issue.file) === key).map((issue) => {
				const diagnostic = new vscode.Diagnostic(lineRange(source, issueLine(source, issue.target)), issue.target,
					vscode.DiagnosticSeverity.Error);
				diagnostic.code = issue.rule;
				return polishDiagnostic(diagnostic, vscode.Uri.file(file));
			}));
		}
	}
}

function readText(file: string): string {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return '';
	}
}

function lineRange(source: string, line: number): vscode.Range {
	return new vscode.Range(line, 0, line, source.split(/\r?\n/)[line]?.length ?? 0);
}
