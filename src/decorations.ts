import * as path from 'path';
import {
	DecorationOptions,
	ExtensionContext,
	MarkdownString,
	Range,
	TextEditor,
	TextEditorDecorationType,
	Uri,
	window
} from 'vscode';
import { formatCoverageHover, formatInlineFailure, LineCoverageMark, shouldShowInlineValue } from './scrunchModel';
import { TestRunnerNotification } from './testResults';

export type { TestRunnerNotification } from './testResults';

export const showResultCommand = 'strict-vscode-client.scrunch.showResult';

export type ValueEvaluationNotification = {
	lineTextPair: Record<string, string>;
};

export class DecorationController {
	private readonly passType: TextEditorDecorationType;
	private readonly failType: TextEditorDecorationType;
	private readonly statusFailType: TextEditorDecorationType;
	private readonly statusHoverType: TextEditorDecorationType;
	private readonly marksByUri = new Map<string, Map<number, LineCoverageMark>>();
	private readonly valueDecorations = new Map<number, TextEditorDecorationType>();

	constructor(extensionPath: string) {
		this.passType = window.createTextEditorDecorationType({
			gutterIconPath: Uri.file(path.join(extensionPath, 'media', 'test-pass.svg')),
			gutterIconSize: 'contain'
		});
		this.failType = window.createTextEditorDecorationType({
			gutterIconPath: Uri.file(path.join(extensionPath, 'media', 'test-fail.svg')),
			gutterIconSize: 'contain'
		});
		this.statusFailType = window.createTextEditorDecorationType({
			gutterIconPath: Uri.file(path.join(extensionPath, 'media', 'test-fail.svg')),
			gutterIconSize: 'contain'
		});
		this.statusHoverType = window.createTextEditorDecorationType({});
	}

	public dispose(): void {
		this.passType.dispose();
		this.failType.dispose();
		this.statusFailType.dispose();
		this.statusHoverType.dispose();
		this.marksByUri.clear();
		for (const decoration of this.valueDecorations.values()) {
			decoration.dispose();
		}
		this.valueDecorations.clear();
	}

	public applyCoverage(uri: string, marks: LineCoverageMark[]): void {
		const map = new Map(marks.map((mark) => [mark.lineNumber, mark]));
		for (const key of uriKeys(uri)) {
			this.marksByUri.set(key, map);
		}
		const editor = window.activeTextEditor;
		if (editor && uriKeys(editor.document.uri.toString()).some((key) => this.marksByUri.has(key))) {
			this.refreshTests(editor);
		}
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

	public applyValues(message: ValueEvaluationNotification): void {
		const editor = window.activeTextEditor;
		if (!editor || !message.lineTextPair) {
			return;
		}
		for (const decoration of this.valueDecorations.values()) {
			decoration.dispose();
		}
		this.valueDecorations.clear();
		for (const key of Object.keys(message.lineTextPair)) {
			const lineNumber = Number(key);
			if (Number.isNaN(lineNumber) || lineNumber < 0 || lineNumber >= editor.document.lineCount) {
				continue;
			}
			const variableValue = message.lineTextPair[key];
			const lineText = editor.document.lineAt(lineNumber).text;
			if (!shouldShowInlineValue(lineText, variableValue)) {
				continue;
			}
			const lineLength = lineText.length;
			const decorationType = window.createTextEditorDecorationType({
				after: {
					contentText: `  ${variableValue}`,
					color: '#a9a9a9'
				}
			});
			this.valueDecorations.set(lineNumber, decorationType);
			setDecorations(editor, decorationType, [{
				range: new Range(lineNumber, lineLength, lineNumber, lineLength)
			}]);
		}
	}

	public refreshActiveEditor(): void {
		const editor = window.activeTextEditor;
		if (editor) {
			this.refreshTests(editor);
		}
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
		const statusFailed: DecorationOptions[] = [];
		const statusHover: DecorationOptions[] = [];
		if (byLine) {
			for (const mark of byLine.values()) {
				if (mark.lineNumber < 0 || mark.lineNumber >= editor.document.lineCount) {
					continue;
				}
				const line = editor.document.lineAt(mark.lineNumber);
				const item: DecorationOptions = {
					range: new Range(mark.lineNumber, 0, mark.lineNumber, line.text.length),
					hoverMessage: coverageHover(editor.document.uri, mark),
					renderOptions: inlineFailure(mark)
				};
				if (mark.kind === 'status') {
					if (mark.failed && mark.tests.length === 0) {
						statusFailed.push(item);
					} else if (mark.tests.length > 0) {
						statusHover.push(item);
					}
					continue;
				}
				(mark.failed ? failed : passed).push(item);
			}
		}
		setDecorations(editor, this.passType, passed);
		setDecorations(editor, this.failType, failed);
		setDecorations(editor, this.statusFailType, statusFailed);
		setDecorations(editor, this.statusHoverType, statusHover);
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
		hover.appendMarkdown(text);
	} else if (mark.failed) {
		hover.appendMarkdown('SCrunch: error on this line');
	}
	if (mark.kind === 'status' && mark.tests.length > 0) {
		const args = encodeURIComponent(JSON.stringify([uri.toString(), mark.lineNumber]));
		hover.appendMarkdown(`${text ? '\n\n' : ''}[Show in Testing window](command:${showResultCommand}?${args})`);
	}
	return hover;
}

function inlineFailure(mark: LineCoverageMark): DecorationOptions['renderOptions'] {
	const text = formatInlineFailure(mark);
	if (!text) {
		return undefined;
	}
	return {
		after: {
			contentText: `  ${text}`,
			color: '#a9a9a9'
		}
	};
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
	context.subscriptions.push(window.onDidChangeActiveTextEditor((editor: TextEditor | undefined) => {
		if (editor) {
			decorations.refreshActiveEditor();
		}
	}));
}
