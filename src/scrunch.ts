import * as path from 'path';
import {
	CancellationToken,
	commands,
	Diagnostic,
	Disposable,
	FileSystemWatcher,
	languages,
	Location,
	Position,
	Range,
	TestController,
	TestItem,
	TestMessage,
	TestMessageStackFrame,
	TestRunProfileKind,
	TestRunRequest,
	tests,
	TextDocument,
	Uri,
	workspace
} from 'vscode';
import { isCacheFresh, siblingBinaryPath } from './scrunchCache';
import { discoverStrictTests } from './scrunchDiscover';
import {
	formatDuration,
	formatFailureOutput,
	parseStackFrames,
	TestRunnerNotification
} from './testResults';

const excludeGlob = '{**/bin/**,**/obj/**,**/node_modules/**,**/.git/**}';

export class ScrunchController implements Disposable {
	private readonly controller: TestController;
	private readonly watchers: FileSystemWatcher[] = [];
	private readonly results = new Map<string, Map<number, TestRunnerNotification>>();
	private readonly publishTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly stale = new Set<string>();
	private readonly disposables: Disposable[] = [];
	private languageServerReady = false;
	private analyzing = false;

	constructor() {
		this.controller = tests.createTestController('strict.scrunch', 'SCrunch');
		this.controller.refreshHandler = () => this.discoverWorkspace();
		this.controller.createRunProfile(
			'SCrunch',
			TestRunProfileKind.Run,
			(request, token) => this.run(request, token),
			true
		);
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
		this.languageServerReady = true;
		void this.pumpAnalyze();
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
		const uri = this.parseUri(message.uri);
		if (!uri) {
			return;
		}
		const key = uri.toString();
		let byLine = this.results.get(key);
		if (!byLine) {
			byLine = new Map();
			this.results.set(key, byLine);
		}
		byLine.set(message.lineNumber, message);
		this.ensureTestItem(uri, { ...message, cached: false });
		const existing = this.publishTimers.get(key);
		if (existing) {
			clearTimeout(existing);
		}
		this.publishTimers.set(key, setTimeout(() => this.publishFile(uri), 40));
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
		const fileItem = this.ensureFileItem(uri);
		const known = this.results.get(uri.toString());
		const live = known && [...known.values()].some((item) => !item.cached);
		if (live) {
			return;
		}
		fileItem.children.replace([]);
		for (const method of discoverStrictTests(text)) {
			const methodItem = this.ensureChild(fileItem, methodId(uri, method.name), method.name, uri);
			methodItem.range = new Range(method.lineNumber, 0, method.lineNumber, 0);
			methodItem.children.replace([]);
			for (const test of method.tests) {
				const testItem = this.ensureChild(
					methodItem,
					testId(uri, method.name, test.lineNumber),
					test.expression,
					uri
				);
				testItem.range = new Range(test.lineNumber, 0, test.lineNumber, Math.max(1, test.expression.length));
			}
		}
		if (await this.hasFreshBinary(uri)) {
			this.applyCachedPass(uri);
			return;
		}
		this.queueAnalyze(uri);
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
		}
	}

	private applyCachedPass(uri: Uri): void {
		const fileItem = this.findFileItem(uri);
		if (!fileItem) {
			return;
		}
		const byLine = new Map<number, TestRunnerNotification>();
		fileItem.children.forEach((methodItem) => {
			methodItem.description = 'cached';
			methodItem.children.forEach((testItem) => {
				const line = testItem.range?.start.line ?? 0;
				byLine.set(line, {
					lineNumber: line,
					state: 1,
					uri: uri.toString(),
					expression: testItem.label,
					methodName: methodItem.label,
					cached: true
				});
				testItem.description = 'cached';
			});
		});
		this.results.set(uri.toString(), byLine);
		fileItem.description = 'cached';
		fileItem.error = undefined;
		this.publishFile(uri);
	}

	private queueAnalyze(uri: Uri): void {
		this.stale.add(uri.toString());
		void this.pumpAnalyze();
	}

	private async pumpAnalyze(): Promise<void> {
		if (!this.languageServerReady || this.analyzing) {
			return;
		}
		this.analyzing = true;
		try {
			while (this.stale.size > 0) {
				const key = this.stale.values().next().value as string;
				this.stale.delete(key);
				const uri = Uri.parse(key);
				if (this.isIgnored(uri) || await this.hasFreshBinary(uri)) {
					continue;
				}
				if (workspace.textDocuments.some((document) => document.uri.toString() === key)) {
					continue;
				}
				try {
					await workspace.openTextDocument(uri);
				} catch {
					// File may have been deleted while queued.
				}
			}
		} finally {
			this.analyzing = false;
		}
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
		const fileItem = this.findFileItem(uri);
		if (!fileItem) {
			return;
		}
		const errors = diagnostics.filter((item) => item.severity === 0);
		if (errors.length === 0) {
			fileItem.error = undefined;
			return;
		}
		const text = errors.map((item) => item.message).join('\n');
		fileItem.error = text;
		const run = this.controller.createTestRun(new TestRunRequest(), 'SCrunch', true);
		const fail = (item: TestItem) => {
			if (item.children.size === 0) {
				run.failed(item, new TestMessage(text), 0);
				return;
			}
			item.children.forEach(fail);
		};
		fail(fileItem);
		run.end();
	}

	private removeFile(uri: Uri): void {
		this.results.delete(uri.toString());
		const fileItem = this.findFileItem(uri);
		if (!fileItem) {
			return;
		}
		fileItem.parent?.children.delete(fileItem.id);
		if (fileItem.parent && fileItem.parent.children.size === 0 && fileItem.parent.parent) {
			fileItem.parent.parent.children.delete(fileItem.parent.id);
		}
	}

	private async run(request: TestRunRequest, token: CancellationToken): Promise<void> {
		const files = this.collectFiles(request);
		for (const uri of files) {
			if (token.isCancellationRequested) {
				return;
			}
			if (await this.hasFreshBinary(uri) && !this.isDirty(uri)) {
				await this.discoverFile(uri);
				continue;
			}
			this.invalidate(uri);
			await workspace.openTextDocument(uri);
		}
	}

	private isDirty(uri: Uri): boolean {
		return workspace.textDocuments.some((document: TextDocument) =>
			document.uri.toString() === uri.toString() && document.isDirty);
	}

	private collectFiles(request: TestRunRequest): Uri[] {
		const uris = new Map<string, Uri>();
		const add = (item: TestItem) => {
			if (item.uri) {
				uris.set(item.uri.toString(), item.uri);
			}
			item.children.forEach(add);
		};
		if (request.include) {
			for (const item of request.include) {
				add(item);
			}
		} else {
			this.controller.items.forEach(add);
		}
		if (request.exclude) {
			for (const item of request.exclude) {
				if (item.uri) {
					uris.delete(item.uri.toString());
				}
			}
		}
		return [...uris.values()];
	}

	private publishFile(uri: Uri): void {
		const key = uri.toString();
		this.publishTimers.delete(key);
		const byLine = this.results.get(key);
		if (!byLine || byLine.size === 0) {
			return;
		}
		const fileItem = this.ensureFileItem(uri);
		const methodNames = new Set<string>();
		for (const message of byLine.values()) {
			if (message.methodName) {
				methodNames.add(message.methodName);
			}
		}
		for (const methodName of methodNames) {
			const methodItem = fileItem.children.get(methodId(uri, methodName));
			if (!methodItem) {
				continue;
			}
			const keep = new Set<string>();
			for (const message of byLine.values()) {
				if (message.methodName === methodName) {
					keep.add(testId(uri, methodName, message.lineNumber));
				}
			}
			methodItem.children.forEach((child) => {
				if (!keep.has(child.id)) {
					methodItem.children.delete(child.id);
				}
			});
		}
		const run = this.controller.createTestRun(new TestRunRequest(), 'SCrunch', true);
		let firstFailed: TestItem | undefined;
		const methodDurations = new Map<string, number>();
		for (const message of byLine.values()) {
			const item = this.ensureTestItem(uri, message);
			const duration = message.durationMs ?? 0;
			if (message.methodName) {
				methodDurations.set(message.methodName, duration);
			}
			item.description = message.cached ? 'cached' : formatDuration(message.durationMs);
			const output = formatFailureOutput(message) + '\r\n';
			run.appendOutput(output.replace(/\n/g, '\r\n'), new Location(uri, item.range?.start ?? new Position(message.lineNumber, 0)), item);
			if (message.state === 0) {
				run.failed(item, this.toMessage(uri, message), duration);
				firstFailed ??= item;
			} else {
				run.passed(item, duration);
			}
		}
		for (const [methodName, duration] of methodDurations) {
			const methodItem = fileItem.children.get(methodId(uri, methodName));
			if (methodItem) {
				methodItem.description = byLine.values().next().value?.cached ? 'cached' : formatDuration(duration);
			}
		}
		this.updateFolderDurations(fileItem);
		run.end();
		if (firstFailed) {
			void commands.executeCommand('vscode.revealTestInExplorer', firstFailed);
		}
	}

	private toMessage(uri: Uri, message: TestRunnerNotification): TestMessage {
		const text = formatFailureOutput(message);
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

	private ensureTestItem(uri: Uri, message: TestRunnerNotification): TestItem {
		const fileItem = this.ensureFileItem(uri);
		const methodName = message.methodName || 'tests';
		const methodItem = this.ensureChild(fileItem, methodId(uri, methodName), methodName, uri);
		const item = this.ensureChild(
			methodItem,
			testId(uri, methodName, message.lineNumber),
			message.expression || `line ${message.lineNumber + 1}`,
			uri
		);
		item.range = new Range(message.lineNumber, 0, message.lineNumber, Math.max(1, (message.expression || '').length));
		return item;
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
		if (!fileItem) {
			fileItem = this.controller.createTestItem(fileId, path.basename(uri.fsPath), uri);
			parentCollection.add(fileItem);
		}
		fileItem.sortText = path.basename(uri.fsPath);
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

export function registerScrunch(): ScrunchController {
	return new ScrunchController();
}

function methodId(uri: Uri, methodName: string): string {
	return `method:${uri.toString()}#${methodName}`;
}

function testId(uri: Uri, methodName: string, lineNumber: number): string {
	return `test:${uri.toString()}#${methodName}@${lineNumber}`;
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

function parseDurationMs(text: string | undefined): number | undefined {
	if (!text) {
		return undefined;
	}
	if (text === '<0.1ms') {
		return 0.05;
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
