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
import { formatTestHover, TestRunnerNotification } from './testResults';

export type { TestRunnerNotification } from './testResults';
export { formatTestHover } from './testResults';

export type ValueEvaluationNotification = {
	lineTextPair: Record<string, string>;
};

export class DecorationController {
	private readonly passType: TextEditorDecorationType;
	private readonly failType: TextEditorDecorationType;
	private readonly testsByUri = new Map<string, Map<number, TestRunnerNotification>>();
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
	}

	public dispose(): void {
		this.passType.dispose();
		this.failType.dispose();
		this.testsByUri.clear();
		for (const decoration of this.valueDecorations.values()) {
			decoration.dispose();
		}
		this.valueDecorations.clear();
	}

	public applyTestResult(message: TestRunnerNotification): void {
		const editor = window.activeTextEditor;
		const uri = message.uri || editor?.document.uri.toString();
		if (!uri) {
			return;
		}
		let byLine = this.testsByUri.get(uri);
		if (!byLine) {
			byLine = new Map();
			this.testsByUri.set(uri, byLine);
		}
		byLine.set(message.lineNumber, message);
		if (editor && editor.document.uri.toString() === uri) {
			this.refreshTests(editor);
		}
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
			const lineLength = editor.document.lineAt(lineNumber).text.length;
			const decorationType = window.createTextEditorDecorationType({
				after: {
					contentText: `  ${variableValue}`,
					color: '#a9a9a9'
				}
			});
			this.valueDecorations.set(lineNumber, decorationType);
			editor.setDecorations(decorationType, [{
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

	private refreshTests(editor: TextEditor): void {
		const byLine = this.testsByUri.get(editor.document.uri.toString());
		const passed: DecorationOptions[] = [];
		const failed: DecorationOptions[] = [];
		if (byLine) {
			for (const message of byLine.values()) {
				if (message.lineNumber < 0 || message.lineNumber >= editor.document.lineCount) {
					continue;
				}
				const hover = new MarkdownString();
				hover.appendMarkdown(formatTestHover(message).replace(/\n/g, '\n\n'));
				const item: DecorationOptions = {
					range: new Range(message.lineNumber, 0, message.lineNumber, 0),
					hoverMessage: hover
				};
				(message.state === 0 ? failed : passed).push(item);
			}
		}
		editor.setDecorations(this.passType, passed);
		editor.setDecorations(this.failType, failed);
	}
}

export function registerDecorationLifecycle(context: ExtensionContext, decorations: DecorationController): void {
	context.subscriptions.push({ dispose: () => decorations.dispose() });
	context.subscriptions.push(window.onDidChangeActiveTextEditor((editor: TextEditor | undefined) => {
		if (editor) {
			decorations.refreshActiveEditor();
		}
	}));
}
