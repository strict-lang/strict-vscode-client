import {
	commands,
	Diagnostic,
	Disposable,
	FileSystemWatcher,
	languages,
	Location,
	Position,
	QuickPickItem,
	Range,
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
import { DecorationController } from './decorations';
import { normalizeFsPath } from './paths';
import { isCacheFresh, siblingBinaryPath } from './scrunchCache';
import { discoverStrictTests, DiscoveredMethod, typeNameFromPath } from './scrunchDiscover';
import {
	enrichNotification,
	isManualMethod,
	lineBelongsTo,
	lineCoverageMarks,
	methodForLine,
	methodsWithTests,
	shouldExecuteManual,
	visibleMethods
} from './scrunchModel';
import {
	formatDuration,
	formatErrorSummary,
	formatMethodOutput,
	MethodOutput,
	parseDiscrepancy,
	parseStackFrames,
	TestRunnerNotification
} from './testResults';

const excludeGlob = '{**/bin/**,**/obj/**,**/node_modules/**,**/.git/**}';

export class ScrunchController implements Disposable {
	private readonly controller: TestController;
	private readonly watchers: FileSystemWatcher[] = [];
	private readonly results = new Map<string, Map<number, TestRunnerNotification>>();
	private readonly methods = new Map<string, DiscoveredMethod[]>();
	private publishTimer: ReturnType<typeof setTimeout> | undefined;
	private lastPublishKey = '';
	private userRunDepth = 0;
	private runMethod: ((uri: Uri, methodName: string) => Thenable<unknown>) | undefined;
	private readonly manualTag = new TestTag('scrunch.manual');
	private readonly disposables: Disposable[] = [];

	constructor(private readonly decorations: DecorationController) {
		this.controller = tests.createTestController('strict.scrunch', 'Types');
		this.controller.refreshHandler = () => this.discoverWorkspace();
		this.controller.createRunProfile('Run', TestRunProfileKind.Run,
			(request) => this.onRunRequest(request), true);
		this.controller.createRunProfile('Run Manual', TestRunProfileKind.Run,
			(request) => this.onRunRequest(request), false, this.manualTag);
		this.disposables.push(this.controller);
		this.watchers.push(workspace.createFileSystemWatcher('**/*.strict'));
		this.watchers.push(workspace.createFileSystemWatcher('**/*.strictbinary'));
		for (const watcher of this.watchers) {
			this.disposables.push(watcher);
			watcher.onDidCreate((uri) => void this.onDiskChange(uri));
			watcher.onDidChange((uri) => void this.onDiskChange(uri));
			watcher.onDidDelete((uri) => this.onDiskDelete(uri));
		}
		this.disposables.push(workspace.onDidChangeTextDocument((event) => {
			if (event.document.languageId === 'strict' && event.document.isDirty) {
				this.invalidate(event.document.uri);
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

	public onLanguageServerReady(): void {
		this.queuePublish();
	}

	public setRunner(runMethod: (uri: Uri, methodName: string) => Thenable<unknown>): void {
		this.runMethod = runMethod;
	}

	public dispose(): void {
		if (this.publishTimer) {
			clearTimeout(this.publishTimer);
		}
		for (const item of this.disposables) {
			item.dispose();
		}
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
		if (!enriched.methodName) {
			return;
		}
		const method = this.methodByName(uri, enriched.methodName);
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
		byLine.set(line, {
			...enriched, lineNumber: line, cached: false, uri: uri.toString(),
			lastRunAt: enriched.lastRunAt ?? new Date().toISOString()
		});
		this.ensureMethodItem(uri, enriched.methodName);
		this.refreshCoverage(uri);
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

	private async discoverWorkspace(): Promise<void> {
		const files = await workspace.findFiles('**/*.strict', excludeGlob);
		for (const uri of files) {
			await this.discoverFile(uri);
		}
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
			const methodItem = this.ensureChild(fileItem, methodId(uri, method.name), method.name, uri);
			methodItem.range = new Range(method.lineNumber, 0, method.lineNumber, 0);
			methodItem.tags = method.tests.length === 0 && method.runnable ? [this.manualTag] : [];
			methodItem.children.replace([]);
		}
		if (await this.hasFreshBinary(uri)) {
			if (methodsWithTests(discovered).length > 0) {
				this.applyCachedPass(uri);
			} else {
				this.refreshCoverage(uri);
			}
			return;
		}
		this.refreshCoverage(uri);
	}

	private async onDiskChange(uri: Uri): Promise<void> {
		if (uri.fsPath.toLowerCase().endsWith('.strictbinary')) {
			const source = Uri.file(uri.fsPath.replace(/\.strictbinary$/i, '.strict'));
			if (await this.hasFreshBinary(source)) {
				await this.discoverFile(source);
			}
			return;
		}
		this.invalidate(uri);
		await this.discoverFile(uri);
	}

	private onDiskDelete(uri: Uri): void {
		if (uri.fsPath.toLowerCase().endsWith('.strictbinary')) {
			const source = Uri.file(uri.fsPath.replace(/\.strictbinary$/i, '.strict'));
			this.invalidate(source);
			void this.discoverFile(source);
			return;
		}
		this.removeFile(uri);
	}

	private invalidate(uri: Uri): void {
		this.lastPublishKey = '';
		this.results.delete(keyOf(uri));
		const fileItem = this.findFileItem(uri);
		if (fileItem) {
			fileItem.label = typeNameFromPath(uri.fsPath);
			fileItem.description = undefined;
			fileItem.error = undefined;
			fileItem.children.forEach((child) => {
				child.label = methodNameFromItem(child);
				child.description = undefined;
				child.error = undefined;
			});
		}
	}

	private applyCachedPass(uri: Uri): void {
		const fileItem = this.findFileItem(uri);
		if (!fileItem) {
			return;
		}
		const discovered = this.methodsFor(uri);
		const byLine = new Map<number, TestRunnerNotification>();
		for (const [line, message] of this.results.get(keyOf(uri)) ?? []) {
			const method = discovered.find((item) => item.name === message.methodName);
			if (method && method.tests.length === 0 && method.runnable) {
				byLine.set(line, message);
			}
		}
		for (const method of methodsWithTests(discovered)) {
			const methodItem = fileItem.children.get(methodId(uri, method.name));
			if (methodItem) {
				methodItem.error = undefined;
			}
			for (const test of method.tests) {
				byLine.set(test.lineNumber, {
					lineNumber: test.lineNumber,
					state: 1,
					uri: uri.toString(),
					expression: test.expression,
					methodName: method.name,
					typeName: typeNameFromPath(uri.fsPath),
					cached: true
				});
			}
		}
		this.results.set(keyOf(uri), byLine);
		fileItem.error = undefined;
		this.queuePublish();
	}

	private async hasFreshBinary(uri: Uri): Promise<boolean> {
		const sourceTime = await this.mtime(uri);
		if (sourceTime === undefined) {
			return false;
		}
		return isCacheFresh(sourceTime, await this.mtime(Uri.file(siblingBinaryPath(uri.fsPath))));
	}

	private async mtime(uri: Uri): Promise<number | undefined> {
		try {
			return (await workspace.fs.stat(uri)).mtime;
		} catch {
			return undefined;
		}
	}

	public applyDiagnostics(uri: Uri, diagnostics: readonly Diagnostic[]): void {
		const errors = diagnostics.filter((item) => item.severity === 0);
		const fileItem = this.findFileItem(uri) ?? (errors.length > 0 ? this.ensureFileItem(uri) : undefined);
		if (!fileItem) {
			this.refreshCoverage(uri);
			return;
		}
		if (errors.length === 0) {
			fileItem.error = undefined;
			fileItem.range = new Range(0, 0, 0, 0);
			fileItem.children.forEach((child) => {
				child.error = undefined;
			});
			this.refreshCoverage(uri);
			this.queuePublish();
			return;
		}
		const errorText = errors.map((item) => item.message).join('\n');
		const errorLines = new Set(errors.map((item) => item.range.start.line));
		const firstErrorLine = errors[0].range.start.line;
		fileItem.error = undefined;
		fileItem.range = new Range(firstErrorLine, 0, firstErrorLine, 0);
		fileItem.children.forEach((methodItem) => {
			const method = this.methodByName(uri, methodNameFromItem(methodItem));
			if (!method || isManualMethod(method)) {
				methodItem.error = undefined;
				return;
			}
			const hitLine = [...errorLines].find((line) => lineBelongsTo(method, line));
			if (hitLine === undefined) {
				methodItem.error = undefined;
				return;
			}
			this.storeResult(uri, {
				lineNumber: hitLine,
				state: 0,
				uri: uri.toString(),
				methodName: method.name,
				typeName: typeNameFromPath(uri.fsPath),
				message: errorText
			});
		});
		this.refreshCoverage(uri);
		this.queuePublish();
	}

	private removeFile(uri: Uri): void {
		this.results.delete(keyOf(uri));
		this.methods.delete(keyOf(uri));
		this.controller.items.delete(fileId(uri));
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

	private queuePublish(): void {
		if (this.publishTimer) {
			clearTimeout(this.publishTimer);
		}
		this.publishTimer = setTimeout(() => this.publishAll(), 40);
	}

	private publishAll(): void {
		this.publishTimer = undefined;
		for (const key of this.methods.keys()) {
			this.refreshCoverage(Uri.file(key));
		}
		const fingerprint = publishFingerprint(this.results) + errorFingerprint();
		if (fingerprint === this.lastPublishKey) {
			return;
		}
		this.lastPublishKey = fingerprint;
		const run = this.controller.createTestRun(new TestRunRequest(undefined, undefined, undefined, false, true),
			'Types', false);
		for (const key of this.methods.keys()) {
			const uri = Uri.file(key);
			const fileItem = this.findFileItem(uri);
			if (!fileItem) {
				continue;
			}
			this.dropUnknownMethods(uri, fileItem);
			const byLine = this.results.get(key) ?? new Map();
			const discovered = this.methods.get(key) ?? [];
			const visible = visibleMethods(discovered);
			const grouped = groupByMethod(byLine);
			const reported = new Set<string>();
			for (const [methodName, summary] of grouped) {
				if (!visible.some((method) => method.name === methodName)) {
					continue;
				}
				const methodItem = this.ensureMethodItem(uri, methodName);
				this.publishMethod(run, uri, methodItem, methodName, summary, discovered);
				reported.add(methodName);
			}
			for (const method of visible) {
				if (reported.has(method.name)) {
					continue;
				}
				const methodItem = fileItem.children.get(methodId(uri, method.name));
				if (!methodItem?.error) {
					continue;
				}
				const message = new TestMessage(String(methodItem.error));
				message.location = new Location(uri, new Position(method.lineNumber, 0));
				run.appendOutput(String(methodItem.error).replace(/\n/g, '\r\n') + '\r\n',
					new Location(uri, new Position(method.lineNumber, 0)), methodItem);
				run.failed(methodItem, message);
			}
			this.updateTypeDuration(fileItem);
		}
		run.end();
	}

	private publishMethod(
		run: TestRun,
		uri: Uri,
		methodItem: TestItem,
		methodName: string,
		summary: MethodSummary,
		discovered: DiscoveredMethod[]
	): void {
		const duration = methodDescription(summary);
		methodItem.label = duration ? `${methodName}  ${duration}` : methodName;
		methodItem.description = summary.failed
			? formatErrorSummary(summary.messages.find((item) => item.state === 0)?.message)
			: undefined;
		const output = formatMethodOutput(methodOutput(summary, discovered));
		if (output) {
			run.appendOutput(output.replace(/\n/g, '\r\n') + '\r\n',
				new Location(uri, new Position(methodItem.range?.start.line ?? 0, 0)), methodItem);
		}
		const durationMs = summary.hasDuration ? summary.duration : undefined;
		if (summary.failed || methodItem.error) {
			const failed = summary.messages.filter((item) => item.state === 0);
			const messages = failed.length > 0
				? failed.map((item) => this.toMessage(uri, item))
				: [new TestMessage(String(methodItem.error))];
			run.failed(methodItem, messages, durationMs);
			return;
		}
		run.passed(methodItem, durationMs);
	}

	private refreshCoverage(uri: Uri): void {
		const discovered = this.methodsFor(uri);
		const results = this.results.get(keyOf(uri)) ?? new Map();
		const errorLines = new Set(
			languages.getDiagnostics(uri).filter((item) => item.severity === 0).map((item) => item.range.start.line)
		);
		this.decorations.applyCoverage(uri.toString(), lineCoverageMarks(discovered, results, errorLines));
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

	private ensureMethodItem(uri: Uri, methodName: string): TestItem {
		const fileItem = this.ensureFileItem(uri);
		const methodItem = this.ensureChild(fileItem, methodId(uri, methodName), methodName, uri);
		const method = this.methodByName(uri, methodName);
		if (method) {
			methodItem.range = new Range(method.lineNumber, 0, method.lineNumber, 0);
			methodItem.tags = method.tests.length === 0 && method.runnable ? [this.manualTag] : [];
		}
		methodItem.children.replace([]);
		return methodItem;
	}

	private ensureFileItem(uri: Uri): TestItem {
		const id = fileId(uri);
		let fileItem = this.controller.items.get(id);
		const label = typeNameFromPath(uri.fsPath);
		if (!fileItem) {
			fileItem = this.controller.createTestItem(id, label, uri);
			this.controller.items.add(fileItem);
		} else {
			fileItem.label = label;
		}
		fileItem.sortText = label;
		fileItem.range = new Range(0, 0, 0, 0);
		return fileItem;
	}

	private findFileItem(uri: Uri): TestItem | undefined {
		return this.controller.items.get(fileId(uri));
	}

	private dropUnknownMethods(uri: Uri, fileItem: TestItem): void {
		const visible = new Set(visibleMethods(this.methodsFor(uri)).
			map((method) => method.name));
		const stale: string[] = [];
		fileItem.children.forEach((child) => {
			if (!visible.has(methodNameFromItem(child))) {
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

	private async onRunRequest(request: TestRunRequest): Promise<void> {
		const items = itemsIn(request, this.controller);
		const run = this.controller.createTestRun(request, 'SCrunch', true);
		this.userRunDepth += 1;
		try {
			for (const item of items) {
				await this.runOne(run, request, item);
			}
		} finally {
			this.userRunDepth -= 1;
			run.end();
		}
		const first = items.find((item) => item.uri);
		if (first?.uri) {
			await this.revealTest(first.uri, first.range?.start.line ?? 0);
		}
	}

	private async runOne(run: TestRun, request: TestRunRequest, item: TestItem): Promise<void> {
		const uri = item.uri;
		if (!uri) {
			run.skipped(item);
			return;
		}
		const method = this.methodByName(uri, methodNameFromItem(item));
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
		if (!this.runMethod) {
			run.failed(item, new TestMessage('Language server is not ready to run this method.'));
			return;
		}
		run.started(item);
		try {
			await this.runMethod(uri, method.name);
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			run.failed(item, new TestMessage(text));
			return;
		}
		const result = await this.waitForResult(uri, method);
		if (!result) {
			run.failed(item, new TestMessage('Language server did not return a result for ' + method.name));
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
		const output = formatMethodOutput(methodOutput(summary, [method]));
		item.description = summary.failed
			? formatErrorSummary(primary.message)
			: undefined;
		if (output) {
			run.appendOutput(output.replace(/\n/g, '\r\n') + '\r\n',
				new Location(uri, new Position(method.lineNumber, 0)), item);
		}
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
			const method = this.methodByName(uri, methodNameFromItem(child));
			if (method && lineBelongsTo(method, lineNumber)) {
				match = child;
			}
		});
		return match ?? fileItem;
	}

	private methodByName(uri: Uri, name: string): DiscoveredMethod | undefined {
		return this.methodsFor(uri).find((method) => method.name === name);
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

	private updateTypeDuration(item: TestItem): void {
		const typeName = item.uri ? typeNameFromPath(item.uri.fsPath) : item.label;
		let total = 0;
		let counted = 0;
		let cached = 0;
		item.children.forEach((child) => {
			const duration = durationFromLabel(child.label);
			if (duration === 'cached') {
				cached += 1;
				return;
			}
			const ms = parseDurationMs(duration);
			if (ms !== undefined) {
				total += ms;
				counted += 1;
			}
		});
		item.description = undefined;
		if (counted > 0) {
			const text = formatDuration(total);
			item.label = text ? `${typeName}  ${text}` : typeName;
			return;
		}
		item.label = cached > 0 ? `${typeName}  cached` : typeName;
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

	private fileUri(filePath: string, fallback: Uri): Uri {
		try {
			return Uri.file(filePath);
		} catch {
			return fallback;
		}
	}

	private isIgnored(uri: Uri): boolean {
		const normalized = uri.fsPath.replace(/\\/g, '/');
		return /\/(bin|obj|node_modules|\.git)\//i.test(`/${normalized}/`);
	}
}

export function registerScrunch(decorations: DecorationController): ScrunchController {
	return new ScrunchController(decorations);
}

function keyOf(uri: Uri): string {
	return normalizeFsPath(uri.fsPath);
}

function fileId(uri: Uri): string {
	return `file:${keyOf(uri)}`;
}

function methodId(uri: Uri, methodName: string): string {
	return `method:${keyOf(uri)}#${methodName}`;
}

function methodNameFromItem(item: TestItem): string {
	const separator = item.id.lastIndexOf('#');
	return separator >= 0 ? item.id.slice(separator + 1) : item.label;
}

function durationFromLabel(label: string): string | undefined {
	const separator = label.lastIndexOf('  ');
	return separator >= 0 ? label.slice(separator + 2) : undefined;
}

type MethodSummary = {
	duration: number;
	hasDuration: boolean;
	failed: boolean;
	cached: boolean;
	messages: TestRunnerNotification[];
};

function groupByMethod(byLine: Map<number, TestRunnerNotification>): Map<string, MethodSummary> {
	const grouped = new Map<string, MethodSummary>();
	for (const message of byLine.values()) {
		if (!message.methodName) {
			continue;
		}
		const current = grouped.get(message.methodName);
		const hasDuration = message.durationMs !== undefined;
		if (!current) {
			grouped.set(message.methodName, {
				duration: hasDuration ? message.durationMs ?? 0 : 0,
				hasDuration,
				failed: message.state === 0,
				cached: Boolean(message.cached),
				messages: [message]
			});
			continue;
		}
		if (hasDuration) {
			current.duration += message.durationMs ?? 0;
			current.hasDuration = true;
		}
		current.failed = current.failed || message.state === 0;
		current.cached = current.cached && Boolean(message.cached);
		current.messages.push(message);
	}
	return grouped;
}

function methodDescription(summary: MethodSummary): string | undefined {
	if (summary.cached && !summary.failed) {
		return 'cached';
	}
	return formatDuration(summary.hasDuration ? summary.duration : undefined);
}

function methodOutput(summary: MethodSummary, methods: DiscoveredMethod[]): MethodOutput {
	const first = summary.messages[0];
	const failed = summary.messages.find((item) => item.state === 0);
	const method = methods.find((item) => item.name === first?.methodName);
	const callCount = summary.messages.length;
	const linesCalled = method
		? method.tests.length + method.implementation.length
		: undefined;
	const consoleOutput = uniqueText(summary.messages.map((item) => item.consoleOutput));
	const discrepancy = failed
		? (failed.expected && failed.actual
			? { expected: failed.expected, actual: failed.actual }
			: parseDiscrepancy(failed.details))
		: undefined;
	return {
		durationMs: summary.hasDuration ? summary.duration : first?.durationMs,
		lastRunAt: first?.lastRunAt,
		methodsCalled: first?.methodsCalled ?? (method ? 1 : undefined),
		linesCalled: first?.linesCalled ?? linesCalled,
		callCount: first?.callCount ?? (callCount > 1 ? callCount : undefined),
		consoleOutput,
		details: failed?.details,
		expected: discrepancy?.expected,
		actual: discrepancy?.actual,
		stackTrace: failed?.stackTrace,
		message: failed?.message,
		failed: summary.failed,
		cached: summary.cached
	};
}

function uniqueText(values: Array<string | undefined>): string | undefined {
	const parts = [...new Set(values.map((value) => value?.trim()).filter(Boolean))] as string[];
	return parts.length > 0 ? parts.join('\n') : undefined;
}

function blockingErrors(uri: Uri): Diagnostic[] {
	const folder = normalizeFsPath(uri.fsPath).replace(/\/[^/]+$/, '');
	const errors: Diagnostic[] = [];
	for (const document of workspace.textDocuments) {
		if (!document.uri.fsPath.toLowerCase().endsWith('.strict')) {
			continue;
		}
		if (normalizeFsPath(document.uri.fsPath).replace(/\/[^/]+$/, '') !== folder) {
			continue;
		}
		for (const diagnostic of languages.getDiagnostics(document.uri)) {
			if (diagnostic.severity === 0) {
				errors.push(diagnostic);
			}
		}
	}
	if (errors.length > 0) {
		return errors;
	}
	return languages.getDiagnostics(uri).filter((item) => item.severity === 0);
}

function errorFingerprint(): string {
	const parts: string[] = [];
	for (const document of workspace.textDocuments) {
		if (!document.uri.fsPath.toLowerCase().endsWith('.strict')) {
			continue;
		}
		for (const diagnostic of languages.getDiagnostics(document.uri)) {
			if (diagnostic.severity === 0) {
				parts.push(document.uri.fsPath + ':' + diagnostic.message);
			}
		}
	}
	return parts.sort().join('|');
}

function publishFingerprint(results: Map<string, Map<number, TestRunnerNotification>>): string {
	const parts: string[] = [];
	for (const [key, byLine] of results) {
		for (const [line, message] of byLine) {
			parts.push([
				key, line, message.state, message.cached ? 1 : 0,
				message.durationMs ?? '', message.details ?? '', message.consoleOutput ?? '',
				message.expected ?? '', message.actual ?? ''
			].join(':'));
		}
	}
	return parts.sort().join('|');
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
	const duration = test.cached ? 'cached' : formatDuration(test.durationMs);
	return {
		label: test.expression || `line ${test.lineNumber + 1}`,
		description: test.state === 0 ? 'failed' : 'passed',
		detail: duration,
		test
	};
}

function parseDurationMs(text: string | undefined): number | undefined {
	if (!text) {
		return undefined;
	}
	if (text === 'cached') {
		return 0;
	}
	if (text.endsWith('us')) {
		const value = Number(text.slice(0, -2));
		return Number.isNaN(value) ? undefined : value / 1000;
	}
	if (text.endsWith('ms')) {
		const value = Number(text.slice(0, -2));
		return Number.isNaN(value) ? undefined : value;
	}
	if (text.endsWith('s')) {
		const value = Number(text.slice(0, -1));
		return Number.isNaN(value) ? undefined : value * 1000;
	}
	return undefined;
}
