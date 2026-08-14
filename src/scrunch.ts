import * as path from 'path';
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
	Uri,
	window,
	workspace
} from 'vscode';
import { DecorationController } from './decorations';
import { isCacheFresh, siblingBinaryPath } from './scrunchCache';
import { discoverStrictTests, DiscoveredMethod, typeNameFromPath } from './scrunchDiscover';
import { lineCoverageMarks, methodsWithTests } from './scrunchModel';
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
	private readonly publishTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly disposables: Disposable[] = [];

	constructor(private readonly decorations: DecorationController) {
		this.controller = tests.createTestController('strict.scrunch', 'SCrunch');
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
		void this.discoverWorkspace();
	}

	public onLanguageServerReady(): void {
		for (const document of workspace.textDocuments) {
			if (document.languageId === 'strict') {
				this.queuePublish(document.uri);
			}
		}
	}

	public dispose(): void {
		for (const timer of this.publishTimers.values()) {
			clearTimeout(timer);
		}
		this.publishTimers.clear();
		for (const item of this.disposables) {
			item.dispose();
		}
	}

	public applyResult(message: TestRunnerNotification): void {
		const uri = this.parseUri(message.uri) ?? window.activeTextEditor?.document.uri;
		if (!uri) {
			return;
		}
		const key = uri.toString();
		let byLine = this.results.get(key);
		if (!byLine) {
			byLine = new Map();
			this.results.set(key, byLine);
		}
		byLine.set(message.lineNumber, { ...message, cached: false, uri: key });
		this.ensureMethodItem(uri, message.methodName || 'tests');
		if (!this.methods.has(key)) {
			void this.discoverFile(uri).then(() => this.queuePublish(uri));
			return;
		}
		this.queuePublish(uri);
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
		this.publishSingle(uri, message);
	}

	private async showTestsForLine(uri: Uri, lineNumber: number): Promise<void> {
		const mark = this.decorations.marksFor(uri.toString(), lineNumber);
		const testsForLine = mark?.tests ?? [];
		if (testsForLine.length === 0) {
			const item = this.itemAt(uri, lineNumber);
			if (item) {
				await commands.executeCommand('vscode.revealTestInExplorer', item);
			}
			await commands.executeCommand('workbench.view.testing.focus');
			return;
		}
		if (testsForLine.length === 1) {
			this.publishSingle(uri, testsForLine[0]);
			return;
		}
		const picked = await window.showQuickPick(testsForLine.map((test) => testPick(test)), {
			title: 'SCrunch tests for this line',
			placeHolder: 'Show test result'
		});
		if (picked) {
			this.publishSingle(uri, picked.test);
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
			methodItem.range = new Range(method.lineNumber, 0, method.lineNumber, 0);
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
			fileItem.description = undefined;
			fileItem.error = undefined;
			fileItem.children.forEach((child) => {
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
				methodItem.description = 'cached';
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
		fileItem.description = 'cached';
		fileItem.error = undefined;
		this.publishFile(uri);
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
			const method = this.methodByName(uri, methodItem.label);
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
		const fileItem = this.findFileItem(uri);
		if (!fileItem) {
			return;
		}
		fileItem.parent?.children.delete(fileItem.id);
		if (fileItem.parent && fileItem.parent.children.size === 0 && fileItem.parent.parent) {
			fileItem.parent.parent.children.delete(fileItem.parent.id);
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

	private queuePublish(uri: Uri): void {
		const key = uri.toString();
		const existing = this.publishTimers.get(key);
		if (existing) {
			clearTimeout(existing);
		}
		this.publishTimers.set(key, setTimeout(() => this.publishFile(uri), 40));
	}

	private publishFile(uri: Uri): void {
		const key = uri.toString();
		this.publishTimers.delete(key);
		this.refreshCoverage(uri);
		const byLine = this.results.get(key);
		if (!byLine || byLine.size === 0) {
			return;
		}
		const fileItem = this.findFileItem(uri);
		if (!fileItem) {
			return;
		}
		const run = this.controller.createTestRun(new TestRunRequest(), 'SCrunch', false);
		const methodDurations = new Map<string, { duration: number; failed: boolean; cached: boolean }>();
		for (const message of byLine.values()) {
			const name = message.methodName || 'tests';
			const current = methodDurations.get(name);
			const duration = message.durationMs ?? 0;
			if (!current) {
				methodDurations.set(name, {
					duration, failed: message.state === 0, cached: Boolean(message.cached)
				});
				continue;
			}
			current.duration += duration;
			current.failed = current.failed || message.state === 0;
			current.cached = current.cached && Boolean(message.cached);
		}
		for (const [methodName, summary] of methodDurations) {
			const methodItem = this.ensureMethodItem(uri, methodName);
			methodItem.description = summary.cached ? 'cached' : formatDuration(summary.duration);
			if (summary.failed || methodItem.error) {
				const failed = [...byLine.values()].filter((item) =>
					item.methodName === methodName && item.state === 0);
				const messages = failed.length > 0
					? failed.map((item) => this.toMessage(uri, item))
					: [new TestMessage(String(methodItem.error))];
				run.failed(methodItem, messages, summary.duration);
			} else {
				run.passed(methodItem, summary.duration);
			}
		}
		this.updateFolderDurations(fileItem);
		run.end();
	}

	private publishSingle(uri: Uri, message: TestRunnerNotification): void {
		const item = this.ensureMethodItem(uri, message.methodName || 'tests');
		const run = this.controller.createTestRun(new TestRunRequest([item]), 'SCrunch', true);
		const duration = message.durationMs ?? 0;
		run.appendOutput(formatSingleTestOutput(message).replace(/\n/g, '\r\n') + '\r\n',
			new Location(uri, new Position(message.lineNumber, 0)), item);
		if (message.state === 0) {
			run.failed(item, this.toMessage(uri, message), duration);
		} else {
			run.passed(item, duration);
		}
		run.end();
		void commands.executeCommand('workbench.panel.testResults.view.focus');
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
			methodItem.range = new Range(method.lineNumber, 0, method.lineNumber, 0);
		}
		methodItem.children.replace([]);
		return methodItem;
	}

	private ensureFileItem(uri: Uri): TestItem {
		const parts = relativeParts(uri);
		let parentCollection = this.controller.items;
		if (parts.folders.length > 0) {
			for (let index = 0; index < parts.folders.length; index++) {
				const folderUri = Uri.joinPath(parts.workspace, ...parts.folders.slice(0, index + 1));
				const id = `folder:${folderUri.toString()}`;
				let folder = parentCollection.get(id);
				if (!folder) {
					folder = this.controller.createTestItem(id, parts.folders[index], folderUri);
					folder.canResolveChildren = true;
					parentCollection.add(folder);
				}
				parentCollection = folder.children;
			}
		}
		const fileId = `file:${uri.toString()}`;
		let fileItem = parentCollection.get(fileId);
		const label = typeNameFromPath(uri.fsPath);
		if (!fileItem) {
			fileItem = this.controller.createTestItem(fileId, label, uri);
			parentCollection.add(fileItem);
		} else {
			fileItem.label = label;
		}
		fileItem.sortText = label;
		return fileItem;
	}

	private findFileItem(uri: Uri): TestItem | undefined {
		const search = (collection: { forEach(callback: (item: TestItem) => void): void }): TestItem | undefined => {
			let found: TestItem | undefined;
			collection.forEach((item) => {
				if (found) {
					return;
				}
				if (item.id === `file:${uri.toString()}`) {
					found = item;
					return;
				}
				found = search(item.children);
			});
			return found;
		};
		return search(this.controller.items);
	}

	private itemAt(uri: Uri, lineNumber: number): TestItem | undefined {
		const fileItem = this.findFileItem(uri);
		if (!fileItem) {
			return undefined;
		}
		let match: TestItem | undefined;
		fileItem.children.forEach((child) => {
			const method = this.methodByName(uri, child.label);
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

	private updateFolderDurations(item: TestItem): void {
		let current: TestItem | undefined = item;
		while (current) {
			if (current.id.startsWith('file:') || current.id.startsWith('folder:')) {
				let total = 0;
				let counted = 0;
				current.children.forEach((child) => {
					const ms = parseDurationMs(child.description);
					if (ms !== undefined) {
						total += ms;
						counted += 1;
					}
				});
				if (counted > 0) {
					current.description = formatDuration(total);
				}
			}
			current = current.parent;
		}
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

function relativeParts(uri: Uri): { workspace: Uri; folders: string[] } {
	const folder = workspace.getWorkspaceFolder(uri);
	const workspaceUri = folder?.uri ?? Uri.file(path.dirname(uri.fsPath));
	const relative = path.relative(workspaceUri.fsPath, path.dirname(uri.fsPath));
	const folders = relative && relative !== '.'
		? relative.split(/[\\/]/).filter((part) => part.length > 0)
		: [];
	return { workspace: workspaceUri, folders };
}

function lineBelongsTo(method: DiscoveredMethod, lineNumber: number): boolean {
	if (lineNumber === method.lineNumber) {
		return true;
	}
	return method.tests.some((test) => test.lineNumber === lineNumber) ||
		method.implementation.some((line) => line.lineNumber === lineNumber);
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
