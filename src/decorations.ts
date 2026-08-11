import * as path from 'path';
import {
	ExtensionContext,
	Range,
	TextEditor,
	TextEditorDecorationType,
	Uri,
	window
} from 'vscode';

export type TestRunnerNotification = {
	lineNumber: number;
	state: number;
};

export type ValueEvaluationNotification = {
	lineTextPair: Record<string, string>;
};

export class DecorationController {
	private readonly passIcon: Uri;
	private readonly failIcon: Uri;
	private readonly testDecorations = new Map<number, TextEditorDecorationType>();
	private readonly valueDecorations = new Map<number, TextEditorDecorationType>();

	constructor(extensionPath: string) {
		this.passIcon = Uri.file(path.join(extensionPath, 'media', 'test-pass.svg'));
		this.failIcon = Uri.file(path.join(extensionPath, 'media', 'test-fail.svg'));
	}

	public dispose(): void {
		for (const decoration of this.testDecorations.values()) {
			decoration.dispose();
		}
		this.testDecorations.clear();
		for (const decoration of this.valueDecorations.values()) {
			decoration.dispose();
		}
		this.valueDecorations.clear();
	}

	public applyTestResult(message: TestRunnerNotification): void {
		const editor = window.activeTextEditor;
		if (!editor) {
			return;
		}
		const lineNumber = message.lineNumber;
		if (lineNumber < 0 || lineNumber >= editor.document.lineCount) {
			return;
		}
		const existing = this.testDecorations.get(lineNumber);
		if (existing) {
			existing.dispose();
			this.testDecorations.delete(lineNumber);
		}
		const icon = message.state === 0 ? this.failIcon : this.passIcon;
		const decorationType = window.createTextEditorDecorationType({
			gutterIconPath: icon,
			gutterIconSize: 'contain'
		});
		this.testDecorations.set(lineNumber, decorationType);
		editor.setDecorations(decorationType, [{ range: new Range(lineNumber, 0, lineNumber, 0) }]);
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
}

export function registerDecorationLifecycle(context: ExtensionContext, decorations: DecorationController): void {
	context.subscriptions.push({ dispose: () => decorations.dispose() });
	context.subscriptions.push(window.onDidChangeActiveTextEditor((editor: TextEditor | undefined) => {
		if (!editor) {
			return;
		}
		// Decorations are editor-bound; clearing avoids stale icons on file switch.
		decorations.dispose();
	}));
}
