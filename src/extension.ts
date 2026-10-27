import { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerCodeActionProvider } from './codeActions';
import { registerRunLenses } from './codeLens';
import { afterTyping, DecorationController, registerDecorationLifecycle, showResultCommand } from './decorations';
import { DiagnosticHighlighter, polishDiagnostic } from './diagnostics';
import { StrictLanguage } from './language';
import { refreshStatusCommand, registerLanguageStatus } from './languageStatus';
import {
	checkIssues, crashLine, crashText, dependents, isOnDemand, lineCounts, lineValues, LineValue, runStrict, StrictRun, startProcess, stopProcess, testResults
} from './nativeCompiler';
import {
	compilerFile, findStrictRoot, normalizeFsPath, projectFolder, resolveIn, rootArgument, strictNotFound, strictPath, strictRoots
} from './paths';
import { cachedInputs, failedInputs, isStrictBinaryPath } from './scrunchCache';
import { discoverStrictTests, isSlowHeader } from './scrunchDiscover';
import { registerScrunch, ScrunchController, ScrunchTester, testErrorSource } from './scrunch';
import { detectedTasks, nativeGame, runTargets, StrictTask, taskCommand } from './tasks';

const notFound = `${strictNotFound} (restart VS Code after changing PATH), or set strict.root`;
const parallelRuns = Math.max(1, Math.floor(os.cpus().length / 2));
let output: vscode.OutputChannel;
let extensionPath: string;
const builds = new Map<vscode.TaskExecution, () => void>();

export function activate(context: vscode.ExtensionContext): void {
	output = vscode.window.createOutputChannel('Strict');
	extensionPath = context.extensionPath;
	const decorations = new DecorationController(context.extensionPath);
	registerDecorationLifecycle(context, decorations);
	const tester = new NativeTester(() => scrunch, context.workspaceState);
	const scrunch = registerScrunch(decorations, tester, context.workspaceState);
	if (!strictRoot()) {
		output.appendLine(notFound);
		void vscode.window.showWarningMessage(notFound);
	}
	context.subscriptions.push(output, tester, scrunch, new DiagnosticHighlighter(), registerCodeActionProvider(),
		new StrictLanguage(strictRoot, projectOf),
		vscode.window.registerFileDecorationProvider({
			provideFileDecoration: (uri) => isStrictBinaryPath(uri.fsPath)
				? { color: new vscode.ThemeColor('gitDecoration.ignoredResourceForeground'), tooltip: 'Cached compiled bytecode' }
				: undefined
		}),
		vscode.tasks.registerTaskProvider('strict', {
			provideTasks: () => strictRoot() ? (vscode.workspace.workspaceFolders ?? []).flatMap((folder) =>
				detectedTasks(folder.uri.fsPath, vscode.window.activeTextEditor?.document.fileName).flatMap((definition) =>
					runTask(definition, folder) ?? [])) : [],
			resolveTask: (task) => runTask(task.definition, task.scope)
		}),
		vscode.commands.registerCommand('strict-vscode-client.runFile', (uri?: vscode.Uri) => runFile(uri, [])),
		vscode.commands.registerCommand('strict-vscode-client.run', async (uri?: vscode.Uri) => {
			const text = await vscode.window.showInputBox({ prompt: 'Arguments passed to Run', placeHolder: 'e.g. 5 10' });
			if (text !== undefined) {
				await runFile(uri, text.split(/\s+/).filter(Boolean));
			}
		}),
		vscode.commands.registerCommand('strict-vscode-client.scrunch.focus', () => scrunch.showInTesting()),
		vscode.commands.registerCommand('strict-vscode-client.scrunch.showLineTests', () => scrunch.showLineTests()),
		vscode.commands.registerCommand('strict-vscode-client.scrunch.slowestTests', () => scrunch.showSlowestTests()),
		vscode.commands.registerCommand('strict-vscode-client.scrunch.timeAll', () => tester.timeAll()),
		vscode.commands.registerCommand(showResultCommand, (uri: string, lineNumber: number) =>
			scrunch.showResult(uri, lineNumber)),
		vscode.window.onDidChangeVisibleTextEditors(() => tester.showValues()),
		vscode.tasks.onDidStartTask((event) => {
			if (event.execution.task.definition.command === 'build') { builds.set(event.execution, tester.hold()); }
		}),
		vscode.tasks.onDidEndTask((event) => {
			builds.get(event.execution)?.();
			builds.delete(event.execution);
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('strict.root')) {
				void scrunch.discoverWorkspace();
			} else if (event.affectsConfiguration('strict.slowTestMilliseconds')) {
				scrunch.republish();
			}
		}),
		vscode.commands.registerCommand('strict-vscode-client.buildPlatform', async (uri?: vscode.Uri) => {
			const platforms = [{ label: 'Web', args: ['web'] }, { label: 'Android', args: ['android'] },
				...(process.platform === 'win32' ? [{ label: 'Windows', args: ['windows'] },
					{ label: 'Windows + Linux', args: [] }] : [{ label: process.platform === 'darwin' ? 'macOS' : 'Linux', args: [] }])];
			const selected = await vscode.window.showQuickPick(platforms, { title: 'Build for platform' });
			if (selected) { await runFile(uri, selected.args, 'build'); }
		}),
		vscode.commands.registerCommand('strict-vscode-client.buildNative', (uri?: vscode.Uri) => runFile(uri, [], 'build')),
		vscode.commands.registerCommand('strict-vscode-client.updatePackages', (uri?: vscode.Uri) => updatePackages(uri)),
		vscode.commands.registerCommand('strict-vscode-client.getStarted', () =>
			vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#start`, false)),
		registerRunLenses(),
		registerLanguageStatus(strictRoot, () => strictRoots(...rootSearch()), (line) => output.appendLine(line))
	);
}

function strictRoot(): string | undefined {
	return findStrictRoot(...rootSearch());
}

/** Where findStrictRoot and strictRoots look: strict.root, the workspace folders and this extension. */
function rootSearch(): [string | undefined, string[], string] {
	return [vscode.workspace.getConfiguration('strict').get<string>('root'),
		vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [], extensionPath];
}

/** Folder strict runs in for a file or folder, see projectFolder. */
function projectOf(target: string): string {
	return projectFolder(target, rootSearch()[1]);
}

/** Runs the Run method of uri (or the current file) with args, or command (build) on it. */
async function runFile(uri: vscode.Uri | undefined, args: string[], command?: string): Promise<void> {
	const editor = vscode.window.activeTextEditor?.document;
	const target = uri?.fsPath ?? (editor?.languageId === 'strict' ? editor.uri.fsPath :
		vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
	const files = target ? runTargets(target) : [];
	const selected = files.length > 1 ? await vscode.window.showQuickPick(files.map((file) =>
		({ label: path.basename(file), description: vscode.workspace.asRelativePath(file), file })), { title: 'Choose Strict program' }) : undefined;
	if (files.length > 1 && !selected) { return; }
	const file = selected?.file ?? files[0];
	const document = file ? await vscode.workspace.openTextDocument(vscode.Uri.file(file)) : undefined;
	if (!document || document.languageId !== 'strict') {
		void vscode.window.showErrorMessage('Open a .strict file to run.');
		return;
	}
	if (document.isDirty && !(await document.save())) {
		return;
	}
	await execute({ type: 'strict', file: document.uri.fsPath, args, ...(command ? { command } : {}) },
		vscode.workspace.getWorkspaceFolder(document.uri));
}

/** `strict update` on the folder (else the workspace folder of the current file or the first one). */
async function updatePackages(uri?: vscode.Uri): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	const folder = uri ?? (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri) ??
		vscode.workspace.workspaceFolders?.[0]?.uri;
	if (folder) {
		await execute({ type: 'strict', command: 'update', file: folder.fsPath }, vscode.workspace.getWorkspaceFolder(folder));
	}
}

async function execute(definition: StrictTask, scope?: vscode.WorkspaceFolder): Promise<void> {
	const task = runTask(definition, scope);
	if (task) {
		await vscode.tasks.executeTask(task);
	}
}

/** `strict` task, also usable in tasks.json: { "type": "strict", "file": "Examples/FizzBuzz.strict", "args": [] }, with
 * "command": "test", "check", "build" or "update" strict runs that on the file or folder instead of its Run method. Problems
 * ($strict) only when strict runs in the workspace folder they are read relative to, terminal links in any folder of the window. */
function runTask(definition: vscode.TaskDefinition, scope?: vscode.WorkspaceFolder | vscode.TaskScope): vscode.Task | undefined {
	const root = strictRoot();
	if (!root) {
		void vscode.window.showErrorMessage(notFound);
		return undefined;
	}
	const folder = typeof scope === 'object' ? scope.uri.fsPath : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const { name, args, cwd } = taskCommand(definition as StrictTask, folder ?? root, rootSearch()[1], root);
	const strict = path.join(root, compilerFile);
	const source = path.resolve(folder ?? root, definition.file as string);
	const isDebug = !definition.command || (definition.args as string[] | undefined)?.includes('debug');
	const game = !definition.command ? nativeGame(source, isDebug) : undefined;
	const buildArgs = ['build', strictPath(cwd, source), ...(isDebug ? ['debug'] : [])];
	const execution = game ? new vscode.CustomExecution(async () => processTerminal(strict,
		buildArgs, cwd, { ...game, args: definition.args as string[] ?? [] }))
		: vscode.workspace.workspaceFolders?.length ? new vscode.ProcessExecution(strict, args, { cwd, env: androidEnvironment() })
			: new vscode.CustomExecution(async () => processTerminal(strict, args, cwd, undefined, androidEnvironment()));
	const task = new vscode.Task(definition, scope ?? vscode.TaskScope.Workspace, name, 'strict', execution,
		folder && normalizeFsPath(folder) === normalizeFsPath(cwd) ? '$strict' : []);
	task.group = definition.command === 'test' ? vscode.TaskGroup.Test
		: definition.command === 'build' ? vscode.TaskGroup.Build : undefined;
	return task;
}

/** strict.androidNdkPath and strict.androidSdkPath as the variables the Android build reads, when set. */
function androidEnvironment(): Record<string, string> {
	const settings = vscode.workspace.getConfiguration('strict');
	const ndk = settings.get<string>('androidNdkPath');
	const sdk = settings.get<string>('androidSdkPath');
	return { ...(ndk ? { ANDROID_NDK_ROOT: ndk, ANDROID_NDK_HOME: ndk } : {}),
		...(sdk ? { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk } : {}) };
}

// Folderless windows need a pseudoterminal. Only Ctrl+C input is supported; file links are unresolved.
/** Terminal showing what file prints when run with args in cwd, it closes with the exit code, closing it stops file. */
function processTerminal(file: string, args: string[], cwd: string,
	next?: { file: string; args: string[]; cwd: string }, env?: Record<string, string>): vscode.Pseudoterminal {
	const write = new vscode.EventEmitter<string>();
	const close = new vscode.EventEmitter<number>();
	let child: ChildProcess | undefined;
	let stopped = false;
	const stop = () => { stopped = true; if (child) { stopProcess(child); } };
	const launch = (program: string, arguments_: string[], directory: string, follow?: typeof next) => {
		child = startProcess(program, arguments_, directory, follow ? undefined : env);
		const show = (text: string) => write.fire(text.replace(/\r?\n/g, '\r\n'));
		child.stdout?.setEncoding('utf8').on('data', show);
		child.stderr?.setEncoding('utf8').on('data', show);
		child.on('error', (error) => show(`${error.message}\n`));
		child.on('close', (code) => !stopped && code === 0 && follow
			? launch(follow.file, follow.args, follow.cwd) : close.fire(code ?? 1));
	};
	return {
		onDidWrite: write.event, onDidClose: close.event, close: stop, handleInput: (data) => data.includes('\x03') && stop(),
		open: () => launch(file, args, cwd, next)
	};
}

/** Runs inline tests (`test`) and validators (`check`) with the newest strict compiler, several processes at once. */
class NativeTester implements ScrunchTester, vscode.Disposable {
	private readonly checks = vscode.languages.createDiagnosticCollection('strict');
	private readonly crashes = vscode.languages.createDiagnosticCollection('strict tests');
	private readonly files = new Set<string>();
	private readonly queue = new Set<string>();
	private readonly aborts = new Map<string, AbortController>();
	private readonly waiting = new Map<string, Array<() => void>>();
	private readonly withLines = new Set<string>();
	/** Files whose values were asked for since their last test. */
	private readonly valued = new Set<string>();
	private running = 0;
	private holds = 0;
	private revision = 0;
	private readonly failedStamps = new Map<string, string>();
	private readonly cache: Record<string, { stamp: string; run: StrictRun; values?: LineValue[] }>;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly scrunch: () => ScrunchController, private readonly memento: vscode.Memento) {
		this.cache = memento.get('strict.testResults', {});
	}
	private failedStamp(root: string, project: string): string {
		let stamp = this.failedStamps.get(project);
		if (!stamp) { stamp = failedInputs(project, root); this.failedStamps.set(project, stamp); }
		return stamp;
	}
	private saveCache(): void {
		if (this.saveTimer) { clearTimeout(this.saveTimer); }
		this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.memento.update('strict.testResults', this.cache); }, 500);
	}

	public dispose(): void {
		this.aborts.forEach((abort) => abort.abort());
		if (this.saveTimer) { clearTimeout(this.saveTimer); void this.memento.update('strict.testResults', this.cache); }
		this.checks.dispose();
		this.crashes.dispose();
	}

// On-demand files run at startup only when their bytecode is newer than their source. Dependencies can invalidate it.
	public testAll(files: string[]): void {
		files.forEach((file) => this.files.add(file));
		const automatic = files.filter((file) => !this.isOnDemand(file) || isNewer(file.replace(/\.strict$/, '.strictbinary'), file));
		const root = strictRoot();
		const stale = automatic.filter((file) => {
			if (!root) { return true; }
			let saved = this.cache[file];
			const stamp = cachedInputs(file, projectOf(file), path.join(root, compilerFile));
			if (stamp && (!saved || saved.stamp !== stamp)) {
				saved = this.cache[file] = { stamp, run: { exitCode: 0, output: `All tests passed in ${file}\n`, durationMs: 0 } };
				this.saveCache();
			}
			if (!saved || saved.stamp !== (saved.run.exitCode === 0 ? stamp : this.failedStamp(root, projectOf(file)))) { return true; }
			const results = testResults(readText(file), vscode.Uri.file(file).toString(), saved.run).map((result) => ({ ...result, cached: true }));
			this.scrunch().applyResults(file, results);
			this.valued.add(file);
			if (saved.values) { this.scrunch().applyValues(file, saved.values); }
			return false;
		});
		this.enqueue([...new Set(stale.map((file) => path.dirname(file))), ...stale]);
	}

	private isOnDemand(file: string): boolean {
		return isOnDemand(vscode.workspace.asRelativePath(file, false),
			vscode.workspace.getConfiguration('strict').get<string[]>('onDemandFolders', []));
	}

	/** Runs every test again to time it. */
	public timeAll(): Promise<void> {
		return this.retest([...this.files]);
	}

	/** Tests files first, without their .strictbinary cache (Strict writes it again when all tests pass), withLines natively
	 * counting each line (`strict test <file> lines`), resolves when the runs started for them finished. Aborting stops the
	 * runs started for this call, a file still queued is tested later like any other change. */
	public async retest(files: string[], signal?: AbortSignal, withLines = false): Promise<void> {
		if (!strictRoot()) {
			return;
		}
		const finished = new Set<string>();
		const own = new Map<string, () => void>();
		const done = Promise.all(files.map((file) => new Promise<void>((resolve) => {
			own.set(file, () => {
				finished.add(file);
				resolve();
			});
			this.waiting.set(file, [...this.waiting.get(file) ?? [], own.get(file)!]);
		})));
		const stop = () => own.forEach((resolve, file) => {
			const waiting = this.waiting.get(file) ?? [];
			if (waiting.includes(resolve)) {
				this.waiting.set(file, waiting.filter((other) => other !== resolve));
				this.withLines.delete(file);
			} else if (!finished.has(file)) {
				this.aborts.get(file)?.abort();
			}
			resolve();
		});
		signal?.addEventListener('abort', stop, { once: true });
		files.forEach((file) => {
			this.files.add(file);
			if (withLines) {
				this.withLines.add(file);
			}
			fs.rmSync(file.replace(/\.strict$/, '.strictbinary'), { force: true });
		});
		this.enqueue(files, true);
		await done;
		signal?.removeEventListener('abort', stop);
	}

	public changed(file: string): void {
		this.revision++; this.failedStamps.clear();
		this.files.add(file);
		const sources = new Map([...this.files].map((known) => [known, readText(known)]));
		this.enqueue([file, path.dirname(file), ...dependents(file, sources).filter((other) => !this.isOnDemand(other))], true);
	}

	public deleted(file: string): void {
		this.revision++; this.failedStamps.clear();
		this.files.delete(file);
		delete this.cache[file]; this.saveCache();
		this.checks.delete(vscode.Uri.file(file));
		this.crashes.delete(vscode.Uri.file(file));
	}

// Filename-only stack frames cannot resolve types in other folders without a project-relative path.
	/** File of a stack frame Strict printed for the test of file: next to file, in its project or in the base types. */
	public frameFile(printed: string, file: string): string {
		const root = strictRoot();
		return resolveIn(printed, [path.dirname(file), projectOf(file), ...root ? [root] : []]);
	}

	public async run(uri: vscode.Uri, methodName: string, signal?: AbortSignal): Promise<void> {
		const root = strictRoot();
		const source = readText(uri.fsPath);
		const method = discoverStrictTests(source).find((item) => item.name === methodName);
		if (!root || !method || methodName !== 'Run' && !isSlowHeader(method.header)) {
			throw new Error(root ? 'Select one Run or Slow method' : notFound);
		}
		const project = projectOf(uri.fsPath);
		const file = strictPath(project, uri.fsPath);
		const args = methodName === 'Run' ? [file] : ['test', file, rootArgument(project, root), methodName];
		const result = await runStrict(root, args, { signal, cwd: project, timeoutMs: 0 });
		for (const notification of testResults(source, uri.toString(), result)) {
			this.scrunch().applyResult(notification);
		}
		this.scrunch().applyResult({
			lineNumber: method.lineNumber, state: result.exitCode === 0 ? 1 : 0, uri: uri.toString(), methodName,
			consoleOutput: result.output, durationMs: result.durationMs,
			message: result.exitCode === 0 ? undefined : `Exit code ${result.exitCode}`
		});
	}

	/** Stops running tests and starts none until the returned function is called (a build replaces files tests use, which
	 * crashed them with exit code 127 and slowed both down). Interrupted files are tested again afterwards. */
	public hold(): () => void {
		const interrupted = [...this.aborts.keys()];
		this.holds++;
		this.aborts.forEach((abort) => abort.abort());
		let released = false;
		return () => {
			if (released) { return; }
			released = true;
			this.holds--;
			this.enqueue(interrupted);
			this.showValues();
		};
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
		void vscode.commands.executeCommand(refreshStatusCommand);
		while (root && !this.holds && this.running < parallelRuns && this.queue.size > 0) {
			const entry = this.queue.values().next().value as string;
			this.queue.delete(entry);
			this.running++;
			const waiters = this.waiting.get(entry) ?? [];
			this.waiting.delete(entry);
			const abort = new AbortController();
			this.aborts.get(entry)?.abort();
			this.aborts.set(entry, abort);
			void (entry.endsWith('.strict') ? this.test(root, entry, abort.signal) : this.check(root, entry)).finally(() => {
				if (this.aborts.get(entry) === abort) {
					this.aborts.delete(entry);
				}
				waiters.forEach((resolve) => resolve());
				this.running--;
				this.next();
			});
		}
	}

	private async test(root: string, file: string, signal?: AbortSignal): Promise<void> {
		this.scrunch().setBusy(file, true);
		const withLines = this.withLines.delete(file);
		const revision = this.revision;
		const project = projectOf(file);
		const lines = withLines ? [rootArgument(project, root), 'lines'] : [];
		const result = await runStrict(root, ['test', strictPath(project, file), ...lines, 'unit'], { signal, cwd: project,
			timeoutMs: vscode.workspace.getConfiguration('strict').get<number>('timeoutSeconds', 60) * 1000 });
		this.scrunch().setBusy(file, false);
		if (!this.files.has(file) || signal?.aborted) {
			return;
		}
		const counts = withLines ? lineCounts(result.output, project) : undefined;
		if (counts?.length === 0) {
			output.appendLine(`${file}: coverage needs a native build of its tests, it failed:\n${result.output}`);
			void vscode.window.showErrorMessage(`Coverage of ${path.basename(file)} failed: ${result.output.trim().split(/\r?\n/)[0] ||
				`exit code ${result.exitCode}`}`);
			return;
		}
		const uri = vscode.Uri.file(file);
		const source = readText(file);
		const crash = crashText(result);
		const diagnostic = crash && new vscode.Diagnostic(lineRange(source, crashLine(result.output, file, project) ?? 0), crash,
			vscode.DiagnosticSeverity.Error);
		if (diagnostic) {
			diagnostic.source = testErrorSource;
			diagnostic.code = /^(\w+): /.exec(diagnostic.message)?.[1];
		}
		afterTyping(`crashes ${file}`, () => this.crashes.set(uri, diagnostic ? [diagnostic] : []));
		if (crash) {
			output.appendLine(`${file}: ${crash}`);
		}
		const notifications = testResults(source, uri.toString(), result);
		if (!withLines) {
			const testsMs = notifications.reduce((total, notification) => total + (notification.durationMs ?? 0), 0);
			if (result.durationMs >= 1000) {
				output.appendLine(`${file}: strict test took ${(result.durationMs / 1000).toFixed(1)} s, its tests ${testsMs.toFixed(2)} ms`);
			}
			this.scrunch().setProcessTime(file, result.durationMs, testsMs);
		}
		this.scrunch().applyResults(file, notifications, counts);
		const stamp = result.exitCode === 0 ? cachedInputs(file, project, path.join(root, compilerFile))
			: revision === this.revision && result.exitCode > 0 && !crash ? this.failedStamp(root, project) : undefined;
		if (stamp) { this.cache[file] = { stamp, run: result }; this.saveCache(); } else { delete this.cache[file]; this.saveCache(); }
		this.valued.delete(file);
		this.showValues();
	}

	/** Hit counts and assigned values of the lines of each visible tested file, once per test of it. */
	public showValues(): void {
		const root = strictRoot();
		for (const file of new Set(vscode.window.visibleTextEditors.map((editor) => editor.document.uri.fsPath))) {
			if (root && !this.holds && this.files.has(file) && !this.valued.has(file)) {
				this.valued.add(file);
				void this.values(root, file);
			}
		}
	}

// Trace visible files separately with a 20 s timeout. Older runs can overwrite newer values.
	private async values(root: string, file: string): Promise<void> {
		const project = projectOf(file);
		const result = await runStrict(root, ['test', strictPath(project, file), rootArgument(project, root), 'values', 'unit'],
			{ cwd: project, timeoutMs: 20000 });
		if (this.valued.has(file)) {
			const values = lineValues(result.output, project);
			this.scrunch().applyValues(file, values);
			const saved = this.cache[file];
			if (saved && saved.stamp === cachedInputs(file, project, path.join(root, compilerFile)) && result.exitCode === 0) {
				saved.values = values; this.saveCache();
			}
		}
	}

	private async check(root: string, folder: string): Promise<void> {
		const project = projectOf(folder);
		const result = await runStrict(root, ['check', strictPath(project, folder)], { cwd: project });
		if (!/^Validation issues: \d+$/m.test(result.output)) {
			output.appendLine(`Checking ${folder} failed with exit code ${result.exitCode}\n${result.output}`);
			return;
		}
		const issues = checkIssues(result.output, project).filter((issue) => issue.rule !== 'MethodAlreadyExists' ||
			vscode.workspace.getConfiguration('strict').get<boolean>('checkExistingMethods', true));
		const files = new Map([...this.files].filter((file) => normalizeFsPath(path.dirname(file)) === normalizeFsPath(folder)).
			concat(issues.map((issue) => issue.file)).map((file) => [normalizeFsPath(file), file]));
		for (const [key, file] of files) {
			const source = readText(file);
			const diagnostics = issues.filter((issue) => normalizeFsPath(issue.file) === key).map((issue) => {
				const diagnostic = new vscode.Diagnostic(lineRange(source, issue.line), issue.target,
					vscode.DiagnosticSeverity.Error);
				diagnostic.code = issue.rule;
				return polishDiagnostic(diagnostic, vscode.Uri.file(file), root);
			});
			afterTyping(`checks ${file}`, () => this.checks.set(vscode.Uri.file(file), diagnostics));
		}
	}
}

function isNewer(file: string, than: string): boolean {
	try {
		return fs.statSync(file).mtimeMs >= fs.statSync(than).mtimeMs;
	} catch {
		return false;
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
