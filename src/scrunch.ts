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
	TestRunRequest,
	tests,
	TextEditorSelectionChangeKind,
	Uri,
	window,
	workspace
} from 'vscode';
import { DecorationController } from './decorations';
import { isCacheFresh, siblingBinaryPath } from './scrunchCache';
import { discoverStrictTests, DiscoveredMethod, typeNameFromPath } from './scrunchDiscover';
import {
	enrichNotification,
	lineBelongsTo,
	lineCoverageMarks,
	methodForLine,
	methodsWithTests
} from './scrunchModel';
import {
	formatDuration,
	formatSingleTestOutput,
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
	private readonly disposables: Disposable[] = [];

	constructor(private readonly decorations: DecorationController) {
		this.controller = tests.createTestController('strict.scrunch', 'Types');
		this.controller.refreshHandler = () => this.discoverWorkspace();
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
		if (!this.methods.has(uri.toString())) {
			void this.discoverFile(uri).then(() => this.storeResult(uri, message));
			return;
		}
		this.storeResult(uri, message);
	}

	private storeResult(uri: Uri, message: TestRunnerNotification): void {
		const key = uri.toString();
		const enriched = enrichNotification(message, this.methods.get(key) ?? [],
			typeNameFromPath(uri.fsPath));
		if (!enriched.methodName) {
			return;
		}
		const method = this.methodByName(uri, enriched.methodName);
		if (!method || method.tests.length === 0) {
			return;
		}
		let byLine = this.results.get(key);
		if (!byLine) {
			byLine = new Map();
			this.results.set(key, byLine);
		}
		byLine.set(enriched.lineNumber, { ...enriched, cached: false, uri: key });
		this.ensureMethodItem(uri, enriched.methodName);
		this.queuePublish();
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
		const message = this.results.get(uri.toString())?.get(lineNumber);
		if (!message) {
			await this.showTestsForLine(uri, lineNumber);
			return;
		}
		this.publishAll();
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
			this.publishAll();
			await this.revealTest(uri, testsForLine[0].lineNumber);
			return;
		}
		const picked = await window.showQuickPick(testsForLine.map((test) => testPick(test)), {
			title: 'Tests for this line',
			placeHolder: 'Show test result'
		});
		if (picked) {
			this.publishAll();
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
		this.methods.set(uri.toString(), discovered);
		const known = this.results.get(uri.toString());
		const live = known && [...known.values()].some((item) => !item.cached);
		if (live) {
			this.refreshCoverage(uri);
			return;
		}
		const visible = methodsWithTests(discovered);
		if (visible.length === 0) {
			this.removeFileIfEmpty(uri);
			this.refreshCoverage(uri);
			return;
		}
		const fileItem = this.ensureFileItem(uri);
		fileItem.children.replace([]);
		for (const method of visible) {
			const methodItem = this.ensureChild(fileItem, methodId(uri, method.name), method.name, uri);
			const target = method.tests[0]?.lineNumber ?? method.lineNumber;
			methodItem.range = new Range(target, 0, target, 0);
			methodItem.children.replace([]);
		}
		if (await this.hasFreshBinary(uri)) {
			this.applyCachedPass(uri);
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
		this.results.delete(uri.toString());
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
		const byLine = new Map<number, TestRunnerNotification>();
		const discovered = this.methods.get(uri.toString()) ?? [];
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
		this.results.set(uri.toString(), byLine);
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
			fileItem.children.forEach((child) => {
				child.error = undefined;
			});
			this.refreshCoverage(uri);
			return;
		}
		fileItem.error = errors.map((item) => item.message).join('\n');
		const errorLines = new Set(errors.map((item) => item.range.start.line));
		fileItem.children.forEach((methodItem) => {
			const method = this.methodByName(uri, methodNameFromItem(methodItem));
			if (!method) {
				return;
			}
			const hits = [...errorLines].some((line) => lineBelongsTo(method, line));
			methodItem.error = hits ? fileItem.error : undefined;
		});
		this.refreshCoverage(uri);
	}

	private removeFile(uri: Uri): void {
		this.results.delete(uri.toString());
		this.methods.delete(uri.toString());
		this.controller.items.delete(`file:${uri.toString()}`);
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
			const uri = this.parseUri(key);
			if (uri) {
				this.refreshCoverage(uri);
			}
		}
		const run = this.controller.createTestRun(new TestRunRequest(), 'Types', false);
		for (const [key, byLine] of this.results) {
			const uri = this.parseUri(key);
			if (!uri || byLine.size === 0) {
				continue;
			}
			const fileItem = this.findFileItem(uri);
			if (!fileItem) {
				continue;
			}
			this.dropUnknownMethods(uri, fileItem);
			const visible = new Set(methodsWithTests(this.methods.get(key) ?? []).
				map((method) => method.name));
			const grouped = groupByMethod(byLine);
			for (const [methodName, summary] of grouped) {
				if (!visible.has(methodName)) {
					continue;
				}
				const methodItem = this.ensureMethodItem(uri, methodName);
				const duration = methodDescription(summary);
				methodItem.label = duration ? `${methodName}  ${duration}` : methodName;
				methodItem.description = undefined;
				for (const message of summary.messages) {
					run.appendOutput(formatSingleTestOutput(message).replace(/\n/g, '\r\n') + '\r\n',
						new Location(uri, new Position(message.lineNumber, 0)), methodItem);
				}
				if (summary.failed || methodItem.error) {
					const failed = summary.messages.filter((item) => item.state === 0);
					const messages = failed.length > 0
						? failed.map((item) => this.toMessage(uri, item))
						: [new TestMessage(String(methodItem.error))];
					run.failed(methodItem, messages);
				} else {
					run.passed(methodItem);
				}
			}
			this.updateTypeDuration(fileItem);
		}
		run.end();
	}

	private refreshCoverage(uri: Uri): void {
		const discovered = this.methods.get(uri.toString()) ?? [];
		const results = this.results.get(uri.toString()) ?? new Map();
		const errorLines = new Set(
			languages.getDiagnostics(uri).filter((item) => item.severity === 0).map((item) => item.range.start.line)
		);
		this.decorations.applyCoverage(uri.toString(), lineCoverageMarks(discovered, results, errorLines));
	}

	private toMessage(uri: Uri, message: TestRunnerNotification): TestMessage {
		const text = formatSingleTestOutput(message);
		const comparison = message.details?.match(/^(.+) is (.+)$/);
		const testMessage = comparison
			? TestMessage.diff(text, comparison[2], comparison[1])
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
			const target = method.tests[0]?.lineNumber ?? method.lineNumber;
			methodItem.range = new Range(target, 0, target, 0);
		}
		methodItem.children.replace([]);
		return methodItem;
	}

	private ensureFileItem(uri: Uri): TestItem {
		const fileId = `file:${uri.toString()}`;
		let fileItem = this.controller.items.get(fileId);
		const label = typeNameFromPath(uri.fsPath);
		if (!fileItem) {
			fileItem = this.controller.createTestItem(fileId, label, uri);
			this.controller.items.add(fileItem);
		} else {
			fileItem.label = label;
		}
		fileItem.sortText = label;
		fileItem.range = new Range(0, 0, 0, 0);
		return fileItem;
	}

	private findFileItem(uri: Uri): TestItem | undefined {
		return this.controller.items.get(`file:${uri.toString()}`);
	}

	private dropUnknownMethods(uri: Uri, fileItem: TestItem): void {
		const visible = new Set(methodsWithTests(this.methods.get(uri.toString()) ?? []).
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
		await window.showTextDocument(uri, {
			selection: new Range(lineNumber, 0, lineNumber, 0),
			preserveFocus: false
		});
		if (item) {
			await commands.executeCommand('vscode.revealTestInExplorer', item);
		}
		await commands.executeCommand('workbench.panel.testResults.view.focus');
	}

	private async onRevealedFromTesting(uri: Uri, lineNumber: number | undefined): Promise<void> {
		if (lineNumber === undefined || !uri.fsPath.toLowerCase().endsWith('.strict')) {
			return;
		}
		const method = methodForLine(this.methods.get(uri.toString()) ?? [], lineNumber);
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
		return this.methods.get(uri.toString())?.find((method) => method.name === name);
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

function methodId(uri: Uri, methodName: string): string {
	return `method:${uri.toString()}#${methodName}`;
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
		const hasDuration = message.durationMs !== undefined && message.durationMs > 0;
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
