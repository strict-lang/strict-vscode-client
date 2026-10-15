import * as vscode from 'vscode';
import { evaluate, evaluatedType, Evaluation, grouped, unfinishedTest } from './implementations';
import { strictDocumentSelector, strictNotFound } from './paths';
import { Scope } from './strictIndex';

const fillCommand = 'strict-vscode-client.fillExpectedValue';

/** Strict: Evaluate shows the value of the selected expression after its line until the selection changes, the quick fix Fill
 * expected value completes a test ending in `is` or `is ?`, both run it as the first test of its method (see evaluate). */
export class Evaluator implements vscode.Disposable {
	private readonly decoration = vscode.window.createTextEditorDecorationType({ after: { margin: '0 0 0 1em' } });
	private readonly disposables: vscode.Disposable[];

	constructor(private readonly root: () => string | undefined, private readonly project: (file: string) => string,
		private readonly scope: (document: vscode.TextDocument, line: number) => Scope) {
		this.disposables = [this.decoration,
			vscode.commands.registerTextEditorCommand('strict-vscode-client.evaluate', (editor) => this.show(editor)),
			vscode.commands.registerCommand(fillCommand, (uri: vscode.Uri, line: number) => this.fill(uri, line)),
			vscode.languages.registerCodeActionsProvider(strictDocumentSelector, {
				provideCodeActions: (document, range) => {
					if (unfinishedTest(document.lineAt(range.start.line).text) === undefined) {
						return [];
					}
					const action = new vscode.CodeAction('Fill expected value', vscode.CodeActionKind.QuickFix);
					action.command = { command: fillCommand, title: action.title, arguments: [document.uri, range.start.line] };
					return [action];
				}
			}),
			vscode.window.onDidChangeTextEditorSelection((event) => event.textEditor.setDecorations(this.decoration, []))
		];
	}

	public dispose(): void {
		this.disposables.forEach((disposable) => disposable.dispose());
	}

	private async evaluation(document: vscode.TextDocument, line: number, expression: string): Promise<Evaluation> {
		const root = this.root();
		const scope = this.scope(document, line);
		return !root ? { error: strictNotFound } : !scope.method || document.uri.scheme !== 'file'
			? { error: 'Only expressions inside a method of a saved .strict file can be evaluated' }
			: evaluate(root, this.project(document.fileName), document.fileName, document.getText(), scope.method, expression,
				evaluatedType(expression, scope));
	}

	private async show(editor: vscode.TextEditor): Promise<void> {
		const { document, selection } = editor;
		const expression = document.getText(selection).trim();
		const version = document.version;
		const result = await this.evaluation(document, selection.start.line, expression);
		if (document.version === version && editor.selection.isEqual(selection)) {
			editor.setDecorations(this.decoration, [{
				range: new vscode.Range(selection.start, document.lineAt(selection.end.line).range.end),
				hoverMessage: new vscode.MarkdownString().appendCodeblock(result.error ?? `${expression} is ${result.value}`, 'strict'),
				renderOptions: { after: { contentText: result.error ?? `= ${result.value}`,
					color: new vscode.ThemeColor(result.error ? 'errorForeground' : 'editorInlayHint.foreground') } }
			}]);
		}
	}

	private async fill(uri: vscode.Uri, line: number): Promise<void> {
		const document = await vscode.workspace.openTextDocument(uri);
		const text = document.lineAt(line).text;
		const expression = unfinishedTest(text);
		const result: Evaluation = expression === undefined ? {} : await this.evaluation(document, line, expression);
		const resolved = expression === undefined ? undefined : evaluatedType(expression, this.scope(document, line));
		const plain = ['Number', 'Text', 'Boolean'];
		if (result.value !== undefined && !(plain.includes(resolved?.type.name ?? '') ||
			resolved?.type.name === 'List' && plain.includes(resolved.element ?? ''))) {
			void vscode.window.showInformationMessage(`${expression} is ${result.value}, only numbers, texts, booleans and lists of ` +
				'them are filled in: write this expected value yourself');
			return;
		}
		if (result.error) {
			void vscode.window.showErrorMessage(`Fill expected value: ${result.error}`);
		} else if (expression !== undefined && result.value !== undefined && line < document.lineCount &&
			document.lineAt(line).text === text) {
			const edit = new vscode.WorkspaceEdit();
			edit.replace(uri, document.lineAt(line).range, `\t${grouped(expression)} is ${result.value}`);
			await vscode.workspace.applyEdit(edit);
		}
	}
}
