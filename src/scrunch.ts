import {
	CancellationToken,
	commands,
	Diagnostic,
	Disposable,
	FileCoverage,
	FileSystemWatcher,
	languages,
	Location,
	MarkdownString,
	Memento,
	Position,
	QuickPickItem,
	Range,
	StatementCoverage,
	StatusBarAlignment,
	StatusBarItem,
	TestController,
	TestItem,
	TestMessage,
	TestMessageStackFrame,
	TestRun,
	TestRunProfileKind,
	TestRunRequest,
	TestTag,
	tests,
	TextEditorSelectionChangeKind,
	Uri,
	window,
	workspace
} from 'vscode';
import * as path from 'path';
import { afterTyping, DecorationController, slowTestMilliseconds } from './decorations';
import { gitIgnored, LineCount, LineValue } from './nativeCompiler';
import { isIgnoredBy, normalizeFsPath } from './paths';
import { discoverStrictTests, DiscoveredMethod, typeNameFromPath } from './scrunchDiscover';
import {
	enrichNotification,
	groupByMethod,
	isManualMethod,
	lineBelongsTo,
	lineCoverageMarks,
	methodForLine,
	methodOf,
	MethodSummary,
	remember,
	shouldExecuteManual,
	manualResults,
	slowestTests,
	TimingHistory,
	visibleMethods
} from './scrunchModel';
import {
	formatDuration,
	formatErrorSummary,
	formatMethodOutput,
	MethodOutput,
	methodLine,
	parseDiscrepancy,
	parseStackFrames,
	TestRunnerNotification,
	unprintedOutput
} from './testResults';

const excludeGlob = '{**/bin/**,**/obj/**,**/node_modules/**,**/.git/**}';
const timingsKey = 'strict.scrunch.timings';
/** A type whose `strict test` (start, compile, tests, exit) takes this long is shown as slow, most take 30-250 ms. */
const slowProcessMs = 1000;
/** Source of the errors `strict test` reports (ParsingFailed, TypeNotFound, crashes), the only errors failing tests. */
export const testErrorSource = 'strict test';

export type ScrunchTester = {
	testAll(files: string[]): void;
	retest(files: string[], signal?: AbortSignal, withLines?: boolean): Promise<void>;
	run(uri: Uri, methodName: string, signal?: AbortSignal): Promise<void>;
	changed(file: string): void;
	deleted(file: string): void;
	frameFile(printed: string, file: string): string;
};

export class ScrunchController implements Disposable {
	private readonly controller: TestController;
	private readonly watchers: FileSystemWatcher[] = [];
	private readonly results = new Map<string, Map<number, TestRunnerNotification>>();
	private readonly methods = new Map<string, DiscoveredMethod[]>();
	private publishTimer: ReturnType<typeof setTimeout> | undefined;
	/** Fingerprints of the results each file was last published with, only changed files are published again. */
	private readonly published = new Map<string, string>();
	/** What git ignores per workspace folder (uri), a file counts for the innermost folder holding it. */
	private ignored = new Map<string, Set<string>>();
	private userRunDepth = 0;
	private readonly manualTag = new TestTag('scrunch.manual');
	private readonly slowTag = new TestTag('slow');
	private readonly disposables: Disposable[] = [];
	private readonly timings: TimingHistory;
	private readonly status: StatusBarItem;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private busyFiles = 0;
	private readonly processTimes = new Map<string, { file: string; processMs: number; testsMs: number }>();
	private readonly lineCounts = new Map<string, Map<number, LineCount>>();
	private readonly values = new Map<string, Map<number, LineValue>>();
	private readonly coverageDetails = new WeakMap<FileCoverage, StatementCoverage[]>();

	constructor(private readonly decorations: DecorationController, private readonly tester: ScrunchTester,
		private readonly memento: Memento) {
		this.timings = memento.get<TimingHistory>(timingsKey, {});
		this.status = window.createStatusBarItem('strict.scrunch', StatusBarAlignment.Left);
		this.status.name = 'SCrunch';
		this.status.command = 'workbench.view.testing.focus';
		this.disposables.push(this.status);
		this.controller = tests.createTestController('strict.scrunch', 'Types');
		this.controller.refreshHandler = () => this.discoverWorkspace();
		this.controller.createRunProfile('Run', TestRunProfileKind.Run,
			(request, token) => this.onRunRequest(request, token), true);
		this.controller.createRunProfile('Run Manual', TestRunProfileKind.Run,
			(request, token) => this.onRunRequest(request, token), false, this.manualTag);
		this.controller.createRunProfile('Coverage', TestRunProfileKind.Coverage,
			(request, token) => this.onRunRequest(request, token), true).loadDetailedCoverage = async (_run, coverage) =>
			this.coverageDetails.get(coverage) ?? [];
		this.disposables.push(this.controller);
		this.watchers.push(workspace.createFileSystemWatcher('**/*.strict'));
		for (const watcher of this.watchers) {
			this.disposables.push(watcher);
			watcher.onDidCreate((uri) => void this.onDiskChange(uri));
			watcher.onDidChange((uri) => void this.onDiskChange(uri));
			watcher.onDidDelete((uri) => this.onDiskDelete(uri));
		}
		this.disposables.push(workspace.onDidChangeTextDocument((event) => {
			const fileItem = event.document.languageId === 'strict' && event.document.isDirty
				? this.findFileItem(event.document.uri) : undefined;
			if (fileItem) {
				this.controller.invalidateTestResults(fileItem);
			}
		}));
		this.disposables.push(languages.onDidChangeDiagnostics((event) => {
			for (const uri of event.uris) {
				if (uri.fsPath.toLowerCase().endsWith('.strict')) {
					this.applyDiagnostics(uri, languages.getDiagnostics(uri));
				}
			}
		}));
		this.disposables.push(window.onDidChangeTextEditorSelection((event) => {
			if (event.kind === TextEditorSelectionChangeKind.Command) {
				void this.onRevealedFromTesting(event.textEditor.document.uri,
					event.selections[0]?.active.line);
			}
		}));
		void this.discoverWorkspace();
	}

	public dispose(): void {
		if (this.publishTimer) {
			clearTimeout(this.publishTimer);
		}
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			void this.memento.update(timingsKey, this.timings);
		}
		for (const item of this.disposables) {
			item.dispose();
		}
	}

	public setBusy(file: string, isBusy: boolean): void {
		const fileItem = this.findFileItem(Uri.file(file));
		if (fileItem) {
			fileItem.busy = isBusy;
		}
		this.busyFiles = Math.max(0, this.busyFiles + (isBusy ? 1 : -1));
		this.updateStatus();
		if (this.busyFiles === 0) {
			// once idle all types go into the newest result: the Testing summary counts only it, VS Code keeps only 128
			this.published.clear();
			this.queuePublish();
		}
	}

	/** Time of the whole `strict test` of file next to its tests, start, compile and exit over 0.1 s show in its output. */
	public setProcessTime(file: string, processMs: number, testsMs: number): void {
		this.processTimes.set(keyOf(Uri.file(file)), { file, processMs, testsMs });
	}

	/** Passed, failed and slow tests of the last runs in the status bar, spinning while Strict runs. */
	private updateStatus(): void {
		const all = [...this.results.values()].flatMap((byLine) => [...byLine.values()]).filter((result) => result.expression);
		const failed = all.filter((result) => result.state === 0).length;
		const slow = all.filter((result) => (result.durationMs ?? 0) >= slowTestMilliseconds()).length;
		this.status.text = `${this.busyFiles > 0 ? '$(sync~spin)' : '$(beaker)'} ${all.length - failed}` +
			`${failed > 0 ? ` $(error) ${failed}` : ''}${slow > 0 ? ` $(watch) ${slow}` : ''}`;
		this.status.tooltip = new MarkdownString(`SCrunch: ${all.length - failed} tests passed, ${failed} failed, ${slow} slow ` +
			`(from ${slowTestMilliseconds()} ms on)${this.busyFiles > 0 ? `, testing ${this.busyFiles} types` : ''}\n\n` +
			'[Show Testing view](command:workbench.view.testing.focus) · ' +
			'[Show slowest tests](command:strict-vscode-client.scrunch.slowestTests)');
		this.status.tooltip.isTrusted = { enabledCommands: ['workbench.view.testing.focus', 'strict-vscode-client.scrunch.slowestTests'] };
		if (this.methods.size > 0) {
			this.status.show();
		}
	}

	/** Publishes everything again, for example after strict.slowTestMilliseconds changed. */
	public republish(): void {
		this.published.clear();
		this.queuePublish();
	}

	/** Results of one `strict test` of file replace its earlier test results (results of Run programs stay), the remembered
	 * times of tests it no longer has are dropped, so are the line counts of its last coverage run without new counts. */
	public applyResults(file: string, results: TestRunnerNotification[], counts?: LineCount[]): void {
		const uri = Uri.file(file);
		const key = keyOf(uri);
		this.lineCounts.set(key, new Map((counts ?? []).filter((count) => normalizeFsPath(count.file) === key).map((count) =>
			[count.line, count])));
		this.results.set(key, manualResults(this.results.get(key) ?? new Map(), this.methodsFor(uri)));
		const current = new Set(results.map((result) => `${key}|${result.expression}`));
		Object.keys(this.timings).filter((name) => name.startsWith(`${key}|`) && !current.has(name) &&
			!results.some((result) => result.cached)).forEach((name) => delete this.timings[name]);
		results.forEach((result) => this.applyResult(counts ? { ...result, native: true } : result));
		this.refreshCoverage(uri);
	}

	/** Hit counts and assigned values of the lines of file from `strict test <file> <root> values`, shown after them. */
	public applyValues(file: string, values: LineValue[]): void {
		const uri = Uri.file(file);
		const key = keyOf(uri);
		this.values.set(key, new Map(values.filter((value) => normalizeFsPath(value.file) === key).map((value) =>
			[value.line, value])));
		this.refreshCoverage(uri);
	}

	public applyResult(message: TestRunnerNotification): void {
		const uri = this.parseUri(message.uri) ?? window.activeTextEditor?.document.uri;
		if (!uri) {
			return;
		}
		if (!this.methods.has(keyOf(uri))) {
			void this.discoverFile(uri).then(() => this.storeResult(uri, message));
			return;
		}
		this.storeResult(uri, message);
	}

	private storeResult(uri: Uri, message: TestRunnerNotification): void {
		const key = keyOf(uri);
		const enriched = enrichNotification(message, this.methods.get(key) ?? [],
			typeNameFromPath(uri.fsPath));
		const method = methodOf(this.methodsFor(uri), enriched);
		if (!method || (method.tests.length === 0 && !method.runnable)) {
			return;
		}
		let byLine = this.results.get(key);
		if (!byLine) {
			byLine = new Map();
			this.results.set(key, byLine);
		}
		const line = method.tests.length === 0 && (enriched.state !== 0 ||
			enriched.lineNumber === method.lineNumber)
			? enriched.lineNumber
			: method.tests.length === 0
				? method.lineNumber
				: enriched.lineNumber;
		const timed = remember(this.timings, `${key}|${enriched.expression ?? line}`, enriched, slowTestMilliseconds());
		this.saveTimer ??= setTimeout(() => {
			this.saveTimer = undefined;
			void this.memento.update(timingsKey, this.timings);
		}, 30000);
		byLine.set(line, { ...timed, lineNumber: line, uri: uri.toString() });
		this.ensureMethodItem(uri, method);
		if (this.userRunDepth === 0) {
			this.queuePublish();
		}
	}

	public async showInTesting(): Promise<void> {
		const editor = window.activeTextEditor;
		const item = editor ? this.itemAt(editor.document.uri, editor.selection.active.line) : undefined;
		if (item) {
			await commands.executeCommand('vscode.revealTestInExplorer', item);
		}
		await commands.executeCommand('workbench.view.testing.focus');
	}

	public async showLineTests(): Promise<void> {
		const editor = window.activeTextEditor;
		if (!editor || editor.document.languageId !== 'strict') {
			return;
		}
		await this.showTestsForLine(editor.document.uri, editor.selection.active.line);
	}

	/** Types whose whole `strict test` is slow, then the tests that took longest in their last run, picking one opens it. */
	public async showSlowestTests(): Promise<void> {
		const processes = [...this.processTimes.values()].filter((time) => time.processMs >= slowProcessMs)
			.sort((left, right) => right.processMs - left.processMs).map((time) => ({
				label: `${formatDuration(time.processMs)}  strict test ${typeNameFromPath(time.file)}`,
				description: `its tests ${formatDuration(time.testsMs)}`, detail: 'start, compile, tests and exit of strict',
				test: { lineNumber: 0, state: 1, uri: Uri.file(time.file).toString() } as TestRunnerNotification
			}));
		const slowest = slowestTests([...this.results.values()].flatMap((byLine) => [...byLine.values()]), 100);
		const picked = await window.showQuickPick([...processes, ...slowest.map((test) => ({
			label: `${formatDuration(test.durationMs)}  ${test.expression ?? `line ${test.lineNumber + 1}`}`,
			description: [test.typeName, test.methodName].filter(Boolean).join('.'),
			detail: test.state === 0 ? 'failed' : undefined,
			test
		}))], { title: 'Slowest tests', placeHolder: slowest.length > 0 ? 'Open test' : 'No timed tests yet, save a .strict file' });
		const uri = picked?.test.uri ? this.parseUri(picked.test.uri) : undefined;
		if (uri) {
			const line = picked!.test.lineNumber;
			await window.showTextDocument(uri, { selection: new Range(line, 0, line, 0) });
		}
	}

	public async showResult(uriText: string, lineNumber: number): Promise<void> {
		const uri = this.parseUri(uriText);
		if (!uri) {
			return;
		}
		const message = this.results.get(keyOf(uri))?.get(lineNumber);
		if (!message) {
			await this.showTestsForLine(uri, lineNumber);
			return;
		}
		await this.revealTest(uri, message.lineNumber);
	}

	private async showTestsForLine(uri: Uri, lineNumber: number): Promise<void> {
		const mark = this.decorations.marksFor(uri.toString(), lineNumber);
		const testsForLine = mark?.tests ?? [];
		if (testsForLine.length === 0) {
			await this.revealTest(uri, lineNumber);
			return;
		}
		if (testsForLine.length === 1) {
			await this.revealTest(uri, testsForLine[0].lineNumber);
			return;
		}
		const picked = await window.showQuickPick(testsForLine.map((test) => testPick(test)), {
			title: 'Tests for this line',
			placeHolder: 'Show test result'
		});
		if (picked) {
			await this.revealTest(uri, picked.test.lineNumber);
		}
	}

	/** Tests every .strict file of the workspace git does not ignore (copied packages, artifacts and worktrees are no types). */
	public async discoverWorkspace(): Promise<void> {
		this.ignored = new Map(await Promise.all((workspace.workspaceFolders ?? []).map(async (folder) =>
			[folder.uri.toString(), await gitIgnored(folder.uri.fsPath)] as const)));
		const files = (await workspace.findFiles('**/*.strict', excludeGlob)).filter((uri) => !this.isIgnored(uri));
		for (const uri of files) {
			await this.discoverFile(uri);
		}
		this.tester.testAll(files.map((uri) => uri.fsPath));
	}

	private async discoverFile(uri: Uri): Promise<void> {
		if (this.isIgnored(uri)) {
			return;
		}
		let text: string;
		try {
			const bytes = await workspace.fs.readFile(uri);
			text = Buffer.from(bytes).toString('utf8');
		} catch {
			return;
		}
		const discovered = discoverStrictTests(text);
		this.methods.set(keyOf(uri), discovered);
		const known = this.results.get(keyOf(uri));
		const live = known && [...known.values()].some((item) => !item.cached);
		if (live) {
			this.refreshCoverage(uri);
			return;
		}
		const visible = visibleMethods(discovered);
		if (visible.length === 0) {
			this.removeFileIfEmpty(uri);
			this.refreshCoverage(uri);
			return;
		}
		const fileItem = this.ensureFileItem(uri);
		fileItem.children.replace([]);
		for (const method of visible) {
			this.ensureMethodItem(uri, method);
		}
		this.refreshCoverage(uri);
	}

	// Concurrent new files share one git ignore check and may miss folders ignored after it starts.
	/** Tests a changed file, asks git again for a new one, it can be in a folder ignored since (a worktree, new artifacts). */
	private async onDiskChange(uri: Uri): Promise<void> {
		const folder = workspace.getWorkspaceFolder(uri);
		if (folder && !this.methods.has(keyOf(uri)) && !this.isIgnored(uri)) {
			this.ignored.set(folder.uri.toString(), await gitIgnored(folder.uri.fsPath));
		}
		if (this.isIgnored(uri)) {
			return;
		}
		this.invalidate(uri);
		await this.discoverFile(uri);
		this.tester.changed(uri.fsPath);
	}

	private onDiskDelete(uri: Uri): void {
		this.removeFile(uri);
		this.tester.deleted(uri.fsPath);
	}

	private invalidate(uri: Uri): void {
		this.published.delete(keyOf(uri));
		this.results.delete(keyOf(uri));
		this.values.delete(keyOf(uri));
		const fileItem = this.findFileItem(uri);
		if (fileItem) {
			fileItem.description = undefined;
			fileItem.error = undefined;
			fileItem.children.forEach((child) => {
				child.description = undefined;
				child.error = undefined;
			});
		}
	}

	/** Errors of `strict test` mark the type as errored (its tests already failed with them), lint stays in Problems. */
	public applyDiagnostics(uri: Uri, diagnostics: readonly Diagnostic[]): void {
		const errors = testErrors(diagnostics);
		const fileItem = this.findFileItem(uri) ?? (errors.length > 0 ? this.ensureFileItem(uri) : undefined);
		if (fileItem) {
			const line = errors[0]?.range.start.line ?? 0;
			fileItem.error = errors.length > 0 ? errors.map((item) => item.message).join('\n') : undefined;
			fileItem.range = new Range(line, 0, line, 0);
		}
		this.refreshCoverage(uri);
		this.queuePublish();
	}

	private removeFile(uri: Uri): void {
		this.results.delete(keyOf(uri));
		this.methods.delete(keyOf(uri));
		const packageItem = this.controller.items.get(packageId(uri));
		packageItem?.children.delete(fileId(uri));
		if (packageItem?.children.size === 0) {
			this.controller.items.delete(packageItem.id);
		}
	}

	private removeFileIfEmpty(uri: Uri): void {
		const fileItem = this.findFileItem(uri);
		if (!fileItem || fileItem.error) {
			return;
		}
		if (fileItem.children.size === 0) {
			this.removeFile(uri);
		}
	}

	// VS Code retains only 128 test results. Publish at most every 3 s while testing, then immediately when idle.
	private queuePublish(): void {
		if (this.publishTimer && this.busyFiles > 0) {
			return;
		}
		clearTimeout(this.publishTimer);
		this.publishTimer = setTimeout(() => afterTyping('publish', () => this.publishAll()), this.busyFiles > 0 ? 3000 : 40);
	}

	private publishAll(): void {
		this.publishTimer = undefined;
		this.updateStatus();
		for (const key of this.methods.keys()) {
			this.refreshCoverage(Uri.file(key));
		}
		const request = new TestRunRequest(undefined, undefined, undefined, false, true);
		// One run: VS Code gives every item of a result a state per run, a run per type made each full publish cost 250 MB
		let run: TestRun | undefined;
		const printed = new Set<string>();
		for (const key of this.methods.keys()) {
			const fileItem = this.findFileItem(Uri.file(key));
			const fingerprint = this.fingerprint(key);
			if (!fileItem?.uri || !this.results.get(key)?.size || this.published.get(key) === fingerprint) {
				continue;
			}
			this.published.set(key, fingerprint);
			const uri = fileItem.uri;
			run ??= this.controller.createTestRun(request, 'SCrunch', false);
			this.dropUnknownMethods(uri, fileItem);
			const byLine = this.results.get(key) ?? new Map();
			const discovered = this.methods.get(key) ?? [];
			const visible = visibleMethods(discovered);
			const grouped = groupByMethod(byLine, discovered);
			for (const method of visible) {
				const summary = grouped.get(method.header);
				if (summary) {
					this.publishMethod(run, uri, this.ensureMethodItem(uri, method), method, summary, printed);
				}
			}
			const time = this.processTimes.get(key);
			if (time && time.processMs - time.testsMs >= 100) {
				run.appendOutput(`${fileItem.label}: strict test took ${formatDuration(time.processMs)}, its tests ${formatDuration(time.testsMs)}\r\n`);
			}
		}
		run?.end();
	}

	private fingerprint(key: string): string {
		return publishFingerprint(this.results.get(key)) + (this.findFileItem(Uri.file(key))?.error ?? '');
	}

	/** Publishes the result of method, its output unless printed has it, see unprintedOutput. */
	private publishMethod(
		run: TestRun,
		uri: Uri,
		methodItem: TestItem,
		method: DiscoveredMethod,
		summary: MethodSummary,
		printed: Set<string>
	): void {
		methodItem.description = summary.failed
			? formatErrorSummary(summary.messages.find((item) => item.state === 0)?.message)
			: summary.cached ? 'cached' : undefined;
		const durationMs = summary.hasDuration ? summary.duration : undefined;
		this.appendMethodOutput(run, methodItem, summary,
			unprintedOutput(methodOutput(summary), keyOf(uri), printed, this.where(uri)));
		methodItem.tags = isManualMethod(method) ? [this.manualTag] : (durationMs ?? 0) >= slowTestMilliseconds()
			? [this.slowTag] : [];
		if (summary.failed) {
			run.failed(methodItem, summary.messages.filter((item) => item.state === 0).map((item) => this.toMessage(uri, item)),
				durationMs);
			return;
		}
		run.passed(methodItem, durationMs);
	}

	/** methodLine of item before its output, none without (each output costs VS Code memory in every result), the method
	 * header shows the time with the decorations, the Testing view next to the method. */
	private appendMethodOutput(run: TestRun, item: TestItem, summary: MethodSummary, output: string | undefined): void {
		if (!output) {
			return;
		}
		const text = [methodLine(summary.failed, summary.hasDuration ? summary.duration : undefined), output]
			.filter(Boolean).join('\n');
		run.appendOutput(text.replace(/\n/g, '\r\n') + '\r\n', undefined, item);
	}

	/** Marks of the last results, kept while typing (the editor moves them with their lines), the next test replaces them. */
	private refreshCoverage(uri: Uri): void {
		const results = this.results.get(keyOf(uri)) ?? new Map();
		const errorLines = new Set(testErrors(languages.getDiagnostics(uri)).map((item) => item.range.start.line));
		const values = this.values.get(keyOf(uri));
		this.decorations.applyCoverage(uri.toString(), lineCoverageMarks(this.methodsFor(uri), results, errorLines,
			this.lineCounts.get(keyOf(uri)), values));
	}

	private toMessage(uri: Uri, message: TestRunnerNotification): TestMessage {
		const discrepancy = message.expected && message.actual
			? { expected: message.expected, actual: message.actual }
			: parseDiscrepancy(message.details);
		const text = discrepancy
			? `Expected: ${discrepancy.expected}\nActual: ${discrepancy.actual}`
			: (message.message || message.details || 'failed');
		const testMessage = discrepancy
			? TestMessage.diff(text, discrepancy.expected, discrepancy.actual)
			: new TestMessage(text);
		testMessage.location = new Location(uri, new Position(message.lineNumber, 0));
		const stackText = message.stackTrace || message.message;
		const frames = parseStackFrames(stackText);
		if (frames.length > 0) {
			testMessage.stackTrace = frames.map((frame) =>
				new TestMessageStackFrame(
					frame.label,
					this.fileUri(frame.file, uri),
					new Position(Math.max(0, frame.line - 1), 0)
				)
			);
		}
		return testMessage;
	}

	private ensureMethodItem(uri: Uri, method: DiscoveredMethod): TestItem {
		const fileItem = this.ensureFileItem(uri);
		const isOverloaded = this.methodsFor(uri).filter((other) => other.name === method.name).length > 1;
		const methodItem = this.ensureChild(fileItem, methodId(uri, method.header), isOverloaded ? method.header : method.name, uri);
		methodItem.range = new Range(method.lineNumber, 0, method.lineNumber, 0);
		methodItem.tags = isManualMethod(method) ? [this.manualTag] : [];
		methodItem.children.replace([]);
		return methodItem;
	}

	private ensureFileItem(uri: Uri): TestItem {
		let packageItem = this.controller.items.get(packageId(uri));
		if (!packageItem) {
			const folder = path.dirname(workspace.asRelativePath(uri, false));
			packageItem = this.controller.createTestItem(packageId(uri), folder === '.'
				? workspace.getWorkspaceFolder(uri)?.name ?? folder : folder);
			this.controller.items.add(packageItem);
		}
		const fileItem = this.ensureChild(packageItem, fileId(uri), typeNameFromPath(uri.fsPath), uri);
		fileItem.sortText = fileItem.label;
		fileItem.range = new Range(0, 0, 0, 0);
		return fileItem;
	}

	private findFileItem(uri: Uri): TestItem | undefined {
		return this.controller.items.get(packageId(uri))?.children.get(fileId(uri));
	}

	private dropUnknownMethods(uri: Uri, fileItem: TestItem): void {
		const visible = new Set(visibleMethods(this.methodsFor(uri)).map((method) => method.header));
		const stale: string[] = [];
		fileItem.children.forEach((child) => {
			if (!visible.has(methodKeyFromItem(child))) {
				stale.push(child.id);
			}
		});
		for (const id of stale) {
			fileItem.children.delete(id);
		}
	}

	private async revealTest(uri: Uri, lineNumber: number): Promise<void> {
		const item = this.itemAt(uri, lineNumber);
		if (item) {
			await commands.executeCommand('vscode.revealTestInExplorer', item);
		}
		await commands.executeCommand('workbench.view.testing.focus');
		await commands.executeCommand('workbench.panel.testResults.view.focus');
	}

	/** Tests the files of the requested items again without cache (to time them) in one run, with line counts
	 * for the Coverage profile, the Stop button kills Strict. */
	private async onRunRequest(request: TestRunRequest, token: CancellationToken): Promise<void> {
		const items = itemsIn(request, this.controller);
		const run = this.controller.createTestRun(request, 'SCrunch', true);
		const abort = new AbortController();
		const cancelled = token.onCancellationRequested(() => abort.abort());
		this.userRunDepth += 1;
		try {
			const tested = items.filter((item) => this.methodOfItem(item)?.tests.length);
			tested.forEach((item) => run.started(item));
			const files = [...new Set(tested.map((item) => item.uri!.fsPath))];
			const isCoverage = request.profile?.kind === TestRunProfileKind.Coverage;
			await this.tester.retest(files, abort.signal, isCoverage);
			for (const item of items) {
				if (token.isCancellationRequested) {
					run.skipped(item);
				} else {
					await this.runOne(run, request, item, abort.signal);
				}
			}
			if (isCoverage && !token.isCancellationRequested) {
				files.forEach((file) => this.addCoverage(run, Uri.file(file)));
			}
			files.forEach((file) => this.published.set(keyOf(Uri.file(file)), this.fingerprint(keyOf(Uri.file(file)))));
		} finally {
			cancelled.dispose();
			this.userRunDepth -= 1;
			run.end();
			this.queuePublish();
		}
		const first = items.find((item) => item.uri);
		if (first?.uri) {
			await this.revealTest(first.uri, first.range?.start.line ?? 0);
		}
	}

	/** Implementation lines of uri with how often its last coverage run executed them, test lines are timed tests already. */
	private addCoverage(run: TestRun, uri: Uri): void {
		const tests = new Set(this.methodsFor(uri).flatMap((method) => method.tests.map((test) => test.lineNumber)));
		const details = [...this.lineCounts.get(keyOf(uri))?.values() ?? []].filter((count) => !tests.has(count.line)).map((count) =>
			new StatementCoverage(count.executions, new Position(count.line, 0)));
		if (details.length > 0) {
			const coverage = FileCoverage.fromDetails(uri, details);
			this.coverageDetails.set(coverage, details);
			run.addCoverage(coverage);
		}
	}

	private async runOne(run: TestRun, request: TestRunRequest, item: TestItem, signal: AbortSignal): Promise<void> {
		const uri = item.uri;
		if (!uri) {
			run.skipped(item);
			return;
		}
		const method = this.methodOfItem(item);
		if (!method) {
			run.skipped(item);
			return;
		}
		if (method.tests.length > 0) {
			this.reportItem(run, uri, item, method);
			return;
		}
		const explicit = request.include?.some((included) => included.id === item.id) ?? false;
		if (!shouldExecuteManual(method, explicit)) {
			run.skipped(item);
			return;
		}
		const blocking = blockingErrors(uri);
		if (blocking.length > 0) {
			const text = blocking.map((item) => item.message).join('\n');
			run.appendOutput(text.replace(/\n/g, '\r\n') + '\r\n',
				new Location(uri, new Position(0, 0)), item);
			run.failed(item, new TestMessage('Fix errors before running.\n' + text));
			return;
		}
		run.started(item);
		try {
			await this.tester.run(uri, method.name, signal);
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			run.failed(item, new TestMessage(text));
			return;
		}
		const result = await this.waitForResult(uri, method);
		if (!result) {
			run.failed(item, new TestMessage('Strict did not return a result for ' + method.name));
			return;
		}
		this.reportStored(run, uri, item, method, result);
	}

	private async waitForResult(uri: Uri, method: DiscoveredMethod): Promise<TestRunnerNotification | undefined> {
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline) {
			const found = this.resultFor(uri, method);
			if (found && !found.cached) {
				return found;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		return this.resultFor(uri, method);
	}

	private resultFor(uri: Uri, method: DiscoveredMethod): TestRunnerNotification | undefined {
		const byLine = this.results.get(keyOf(uri));
		if (!byLine) {
			return undefined;
		}
		const atMethod = byLine.get(method.lineNumber);
		if (atMethod) {
			return atMethod;
		}
		return [...byLine.values()].find((item) => item.methodName === method.name);
	}

	private reportItem(run: TestRun, uri: Uri, item: TestItem, method: DiscoveredMethod): void {
		const byLine = this.results.get(keyOf(uri)) ?? new Map();
		const messages = method.tests.length > 0
			? method.tests.map((test) => byLine.get(test.lineNumber)).filter(Boolean) as TestRunnerNotification[]
			: [byLine.get(method.lineNumber)].filter(Boolean) as TestRunnerNotification[];
		if (messages.length === 0) {
			run.skipped(item);
			return;
		}
		this.reportStored(run, uri, item, method, messages[0], messages);
	}

	private reportStored(
		run: TestRun,
		uri: Uri,
		item: TestItem,
		method: DiscoveredMethod,
		primary: TestRunnerNotification,
		all = [primary]
	): void {
		const summary: MethodSummary = {
			duration: all.reduce((total, message) => total + (message.durationMs ?? 0), 0),
			hasDuration: all.some((message) => message.durationMs !== undefined),
			failed: all.some((message) => message.state === 0),
			cached: all.every((message) => Boolean(message.cached)),
			messages: all
		};
		item.description = summary.failed
			? formatErrorSummary(primary.message)
			: undefined;
		this.appendMethodOutput(run, item, summary, formatMethodOutput(methodOutput(summary), this.where(uri)));
		const durationMs = summary.hasDuration ? summary.duration : undefined;
		if (summary.failed) {
			const failed = all.filter((message) => message.state === 0);
			run.failed(item, failed.map((message) => this.toMessage(uri, message)), durationMs);
			return;
		}
		run.passed(item, durationMs);
	}

	private async onRevealedFromTesting(uri: Uri, lineNumber: number | undefined): Promise<void> {
		if (lineNumber === undefined || !uri.fsPath.toLowerCase().endsWith('.strict')) {
			return;
		}
		const method = methodForLine(this.methodsFor(uri), lineNumber);
		if (!method) {
			return;
		}
		const onMethodOrTest = lineNumber === method.lineNumber ||
			method.tests.some((test) => test.lineNumber === lineNumber);
		if (!onMethodOrTest) {
			return;
		}
		await commands.executeCommand('workbench.panel.testResults.view.focus');
	}

	private itemAt(uri: Uri, lineNumber: number): TestItem | undefined {
		const fileItem = this.findFileItem(uri);
		if (!fileItem) {
			return undefined;
		}
		let match: TestItem | undefined;
		fileItem.children.forEach((child) => {
			const method = this.methodOfItem(child);
			if (method && lineBelongsTo(method, lineNumber)) {
				match = child;
			}
		});
		return match ?? fileItem;
	}

	private methodOfItem(item: TestItem): DiscoveredMethod | undefined {
		return item.uri && this.methodsFor(item.uri).find((method) => method.header === methodKeyFromItem(item));
	}

	private methodsFor(uri: Uri): DiscoveredMethod[] {
		return this.methods.get(keyOf(uri)) ?? [];
	}

	private ensureChild(parent: TestItem, id: string, label: string, uri: Uri): TestItem {
		let item = parent.children.get(id);
		if (!item) {
			item = this.controller.createTestItem(id, label, uri);
			parent.children.add(item);
		} else {
			item.label = label;
		}
		return item;
	}

	private parseUri(value: string | undefined): Uri | undefined {
		if (!value) {
			return undefined;
		}
		try {
			return Uri.parse(value);
		} catch {
			return undefined;
		}
	}

	/** Stack frame files printed by Strict as full paths, the test output links them. */
	private where(uri: Uri): (file: string) => string {
		return (file) => this.fileUri(file, uri).fsPath;
	}

	private fileUri(filePath: string, uri: Uri): Uri {
		return Uri.file(this.tester.frameFile(filePath, uri.fsPath));
	}

	private isIgnored(uri: Uri): boolean {
		const normalized = uri.fsPath.replace(/\\/g, '/');
		const folder = workspace.getWorkspaceFolder(uri);
		return /\/(bin|obj|node_modules|\.git)\//i.test(`/${normalized}/`) ||
			isIgnoredBy(uri.fsPath, (folder && this.ignored.get(folder.uri.toString())) ?? new Set());
	}
}

export function registerScrunch(decorations: DecorationController, tester: ScrunchTester, memento: Memento): ScrunchController {
	return new ScrunchController(decorations, tester, memento);
}

function keyOf(uri: Uri): string {
	return normalizeFsPath(uri.fsPath);
}

function fileId(uri: Uri): string {
	return `file:${keyOf(uri)}`;
}

/** The folder of uri, the package holding its type in the Testing view. */
function packageId(uri: Uri): string {
	return `package:${path.dirname(keyOf(uri))}`;
}

function methodId(uri: Uri, header: string): string {
	return `method:${keyOf(uri)}#${header}`;
}

/** The header of a method item, it tells overloads apart. */
function methodKeyFromItem(item: TestItem): string {
	const separator = item.id.lastIndexOf('#');
	return separator >= 0 ? item.id.slice(separator + 1) : item.label;
}

function methodOutput(summary: MethodSummary): MethodOutput {
	const failed = summary.messages.find((item) => item.state === 0);
	const consoleOutput = uniqueText(summary.messages.map((item) => item.consoleOutput));
	const discrepancy = failed
		? (failed.expected && failed.actual
			? { expected: failed.expected, actual: failed.actual }
			: parseDiscrepancy(failed.details))
		: undefined;
	return {
		consoleOutput,
		details: failed?.details,
		expected: discrepancy?.expected,
		actual: discrepancy?.actual,
		stackTrace: failed?.stackTrace,
		message: failed?.message,
		failed: summary.failed
	};
}

function uniqueText(values: Array<string | undefined>): string | undefined {
	const parts = [...new Set(values.map((value) => value?.trim()).filter(Boolean))] as string[];
	return parts.length > 0 ? parts.join('\n') : undefined;
}

function testErrors(diagnostics: readonly Diagnostic[]): Diagnostic[] {
	return diagnostics.filter((item) => item.source === testErrorSource);
}

/** Errors of `strict test` in the folder of uri, a Run method is not started while there are any. */
function blockingErrors(uri: Uri): Diagnostic[] {
	const folder = normalizeFsPath(uri.fsPath).replace(/\/[^/]+$/, '');
	return [...new Map([uri, ...workspace.textDocuments.map((document) => document.uri).filter((other) =>
		normalizeFsPath(other.fsPath).replace(/\/[^/]+$/, '') === folder)].map((other) => [keyOf(other), other])).values()]
		.flatMap((other) => testErrors(languages.getDiagnostics(other)));
}

function publishFingerprint(byLine = new Map<number, TestRunnerNotification>()): string {
	return [...byLine].map(([line, message]) => [line, message.state, message.cached ? 1 : 0, message.durationMs ?? '',
		message.details ?? '', message.consoleOutput ?? '', message.expected ?? '', message.actual ?? ''].join(':')).sort().join('|');
}

function itemsIn(request: TestRunRequest, controller: TestController): TestItem[] {
	if (request.include && request.include.length > 0) {
		return expandItems(request.include, request.exclude ?? []);
	}
	const roots: TestItem[] = [];
	controller.items.forEach((item) => roots.push(item));
	return expandItems(roots, request.exclude ?? []);
}

function expandItems(items: readonly TestItem[], exclude: readonly TestItem[]): TestItem[] {
	const skip = new Set(exclude);
	const result: TestItem[] = [];
	const visit = (item: TestItem) => {
		if (skip.has(item)) {
			return;
		}
		if (item.children.size === 0) {
			result.push(item);
			return;
		}
		item.children.forEach(visit);
	};
	for (const item of items) {
		visit(item);
	}
	return result;
}

function testPick(test: TestRunnerNotification): QuickPickItem & { test: TestRunnerNotification } {
	const duration = `${formatDuration(test.durationMs) ?? ''}${test.cached ? ' cached' : ''}`.trim() || undefined;
	return {
		label: test.expression || `line ${test.lineNumber + 1}`,
		description: test.state === 0 ? 'failed' : 'passed',
		detail: duration,
		test
	};
}
