import * as path from 'path';
import {
	DecorationOptions,
	ExtensionContext,
	MarkdownString,
	Range,
	TextEditor,
	TextEditorDecorationType,
	ThemeColor,
	Uri,
	window,
	workspace
} from 'vscode';
import { formatDuration } from './testResults';
import { formatCoverageHover, formatInlineFailure, formatInlineSlow, formatInlineValue, LineCoverageMark } from './scrunchModel';

export const showResultCommand = 'strict-vscode-client.scrunch.showResult';
/** Errors, end of line texts and Test Results wait this long after the last change of a Strict file, gutter icons do not. */
export const typingPauseMs = 1000;
let lastTyped = 0;
const typingWaits = new Map<string, ReturnType<typeof setTimeout>>();

/** Runs action once nothing was typed for typingPauseMs, a later call with the same key replaces a waiting one. */
export function afterTyping(key: string, action: () => void): void {
	clearTimeout(typingWaits.get(key));
	typingWaits.delete(key);
	const wait = lastTyped + typingPauseMs - Date.now();
	if (wait <= 0) {
		action();
	} else {
		typingWaits.set(key, setTimeout(() => afterTyping(key, action), wait));
	}
}

export class DecorationController {
	private readonly passType: TextEditorDecorationType;
	private readonly failType: TextEditorDecorationType;
	private readonly testPassType: TextEditorDecorationType;
	private readonly testFailType: TextEditorDecorationType;
	private readonly statusFailType: TextEditorDecorationType;
	private readonly statusHoverType: TextEditorDecorationType;
	private readonly crashType: TextEditorDecorationType;
	private readonly textType: TextEditorDecorationType;
	private readonly marksByUri = new Map<string, Map<number, LineCoverageMark>>();

	constructor(extensionPath: string) {
		this.passType = window.createTextEditorDecorationType({
			gutterIconPath: Uri.file(path.join(extensionPath, 'media', 'test-pass.svg')),
			gutterIconSize: 'contain'
		});
		this.failType = window.createTextEditorDecorationType({
			gutterIconPath: Uri.file(path.join(extensionPath, 'media', 'test-fail.svg')),
			gutterIconSize: 'contain'
		});
		this.testPassType = window.createTextEditorDecorationType({
			gutterIconPath: Uri.file(path.join(extensionPath, 'media', 'test-line-pass.svg')),
			gutterIconSize: 'contain'
		});
		this.testFailType = window.createTextEditorDecorationType({
			gutterIconPath: Uri.file(path.join(extensionPath, 'media', 'test-line-fail.svg')),
			gutterIconSize: 'contain'
		});
		this.statusFailType = window.createTextEditorDecorationType({
			gutterIconPath: Uri.file(path.join(extensionPath, 'media', 'test-fail.svg')),
			gutterIconSize: 'contain'
		});
		this.statusHoverType = window.createTextEditorDecorationType({});
		this.crashType = window.createTextEditorDecorationType({
			gutterIconPath: Uri.file(path.join(extensionPath, 'media', 'test-crash.svg')),
			gutterIconSize: 'contain'
		});
		this.textType = window.createTextEditorDecorationType({});
	}

	public dispose(): void {
		this.passType.dispose();
		this.failType.dispose();
		this.testPassType.dispose();
		this.testFailType.dispose();
		this.statusFailType.dispose();
		this.statusHoverType.dispose();
		this.crashType.dispose();
		this.textType.dispose();
		this.marksByUri.clear();
	}

	public applyCoverage(uri: string, marks: LineCoverageMark[]): void {
		const map = new Map(marks.map((mark) => [mark.lineNumber, mark]));
		for (const key of uriKeys(uri)) {
			this.marksByUri.set(key, map);
		}
		const keys = uriKeys(uri);
		window.visibleTextEditors.filter((editor) => uriKeys(editor.document.uri.toString()).some((key) => keys.includes(key)))
			.forEach((editor) => this.refreshTests(editor));
	}

	public marksFor(uri: string, lineNumber: number): LineCoverageMark | undefined {
		for (const key of uriKeys(uri)) {
			const mark = this.marksByUri.get(key)?.get(lineNumber);
			if (mark) {
				return mark;
			}
		}
		return undefined;
	}

	public refreshVisibleEditors(): void {
		window.visibleTextEditors.forEach((editor) => this.refreshTests(editor));
	}

	private marksForUri(uri: string): Map<number, LineCoverageMark> | undefined {
		for (const key of uriKeys(uri)) {
			const marks = this.marksByUri.get(key);
			if (marks) {
				return marks;
			}
		}
		return undefined;
	}

	private refreshTests(editor: TextEditor): void {
		const byLine = this.marksForUri(editor.document.uri.toString());
		const passed: DecorationOptions[] = [];
		const failed: DecorationOptions[] = [];
		const testPassed: DecorationOptions[] = [];
		const testFailed: DecorationOptions[] = [];
		const statusFailed: DecorationOptions[] = [];
		const statusHover: DecorationOptions[] = [];
		const crashed: DecorationOptions[] = [];
		const texts: DecorationOptions[] = [];
		if (byLine) {
			for (const mark of byLine.values()) {
				if (mark.lineNumber < 0 || mark.lineNumber >= editor.document.lineCount) {
					continue;
				}
				const line = editor.document.lineAt(mark.lineNumber);
				const range = new Range(mark.lineNumber, 0, mark.lineNumber, line.text.length);
				const item: DecorationOptions = { range, hoverMessage: coverageHover(editor.document.uri, mark) };
				const renderOptions = inlineText(mark, line.text);
				if (renderOptions) {
					texts.push({ range, renderOptions });
				}
				if (mark.kind === 'status') {
					if (mark.failed && mark.tests.length === 0) {
						statusFailed.push(item);
					} else if (mark.tests.length > 0) {
						statusHover.push(item);
					}
					continue;
				}
				(mark.kind === 'test' ? mark.failed ? testFailed : testPassed : mark.crashed ? crashed : mark.failed ? failed : passed)
					.push(item);
			}
		}
		setDecorations(editor, this.passType, passed);
		setDecorations(editor, this.failType, failed);
		setDecorations(editor, this.testPassType, testPassed);
		setDecorations(editor, this.testFailType, testFailed);
		setDecorations(editor, this.statusFailType, statusFailed);
		setDecorations(editor, this.statusHoverType, statusHover);
		setDecorations(editor, this.crashType, crashed);
		afterTyping(`text ${editor.document.uri}`, () => setDecorations(editor, this.textType, texts));
	}
}

function setDecorations(
	editor: TextEditor,
	type: TextEditorDecorationType,
	items: DecorationOptions[]
): void {
	try {
		if (!window.visibleTextEditors.includes(editor)) {
			return;
		}
		editor.setDecorations(type, items);
	} catch {
	}
}

function coverageHover(uri: Uri, mark: LineCoverageMark): MarkdownString {
	const hover = new MarkdownString(undefined, true);
	hover.isTrusted = { enabledCommands: [showResultCommand] };
	hover.supportThemeIcons = true;
	const text = formatCoverageHover(mark);
	if (text) {
		hover.appendText(text);
	} else if (mark.failed) {
		hover.appendMarkdown('SCrunch: error on this line');
	}
	if (mark.kind === 'status' && mark.tests.length > 0) {
		const args = encodeURIComponent(JSON.stringify([uri.toString(), mark.lineNumber]));
		hover.appendMarkdown(`${text ? '\n\n' : ''}[Show in Testing window](command:${showResultCommand}?${args})`);
	}
	return hover;
}

export function slowTestMilliseconds(): number {
	return workspace.getConfiguration('strict').get<number>('slowTestMilliseconds', 20);
}

/** A failure or slowdown after line, else a small faint hint: the time of a method's tests or how often line ran. */
function inlineText(mark: LineCoverageMark, line: string): DecorationOptions['renderOptions'] {
	const failure = formatInlineFailure(mark);
	const slow = formatInlineSlow(mark, slowTestMilliseconds());
	const hint = mark.kind === 'status' ? formatDuration(mark.durationMs) : mark.value && formatInlineValue(mark.value, line);
	const margin = '0 0 0 2ch';
	return failure ?? slow ? { after: { contentText: failure ?? slow, margin, color: failure ? '#a9a9a9'
		: new ThemeColor('editorWarning.foreground') } }
		: hint ? { after: { contentText: hint, margin, color: new ThemeColor('editorCodeLens.foreground'),
			textDecoration: 'none; font-size: 0.85em; opacity: 0.6' } } : undefined;
}

function uriKeys(uri: string): string[] {
	const keys = new Set<string>([uri]);
	try {
		const parsed = Uri.parse(uri);
		keys.add(parsed.toString());
		keys.add(parsed.fsPath);
		keys.add(parsed.fsPath.toLowerCase());
	} catch {
	}
	return [...keys];
}

export function registerDecorationLifecycle(context: ExtensionContext, decorations: DecorationController): void {
	context.subscriptions.push({ dispose: () => decorations.dispose() });
	context.subscriptions.push(window.onDidChangeVisibleTextEditors(() => decorations.refreshVisibleEditors()));
	context.subscriptions.push(workspace.onDidChangeTextDocument((event) => {
		if (event.document.languageId === 'strict' && event.contentChanges.length > 0) {
			lastTyped = Date.now();
		}
	}));
}
