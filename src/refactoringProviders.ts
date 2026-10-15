import * as fs from 'fs';
import * as vscode from 'vscode';
import { formatted, printed } from './formatting';
import { withTemporaryCopy } from './implementations';
import { textOf } from './navigation';
import { runStrict } from './nativeCompiler';
import { strictDocumentSelector } from './paths';
import { creations, extractToLet, inlineLet, Refactoring } from './refactorings';
import { Scope } from './strictIndex';

/** Formatter, extract and inline refactorings and the quick fixes creating missing methods and types of .strict files. */
export function registerRefactorings(root: () => string | undefined,
	scopeAt: (document: vscode.TextDocument, line: number) => Scope): vscode.Disposable[] {
	return [
		vscode.languages.registerDocumentFormattingEditProvider(strictDocumentSelector,
			{ provideDocumentFormattingEdits: async (document) => formatEdits(document, await canonical(root(), document)) }),
		vscode.languages.registerDocumentRangeFormattingEditProvider(strictDocumentSelector,
			{ provideDocumentRangeFormattingEdits: (document, range) =>
				formatEdits(document, formatted(document.getText(), range.start.line, range.end.line)) }),
		vscode.languages.registerCodeActionsProvider(strictDocumentSelector, {
			provideCodeActions: (document, range, context) => {
				const lines = document.getText().split(/\r?\n/);
				const scope = scopeAt(document, range.start.line);
				return [
					range.isSingleLine && !range.isEmpty
						? extractToLet(lines, range.start.line, range.start.character, range.end.character, scope) : undefined,
					inlineLet(lines, range.start.line, scope),
					...context.diagnostics.flatMap((diagnostic) => creations(diagnostic.message, document.fileName, lines,
						diagnostic.range.start.line, scopeAt(document, diagnostic.range.start.line), (file) => textOf(file) ?? '').map((creation) =>
						({ ...creation, diagnostic })))
				].flatMap((refactoring) => refactoring ? [codeAction(document, refactoring)] : []);
			}
		}, { providedCodeActionKinds: [vscode.CodeActionKind.RefactorExtract, vscode.CodeActionKind.RefactorInline,
			vscode.CodeActionKind.QuickFix] })
	];
}

/** The whole document with tabs and as `strict format` prints it, only with tabs when Strict is missing, can't parse it or
 * changed more than whitespace and brackets. */
async function canonical(root: string | undefined, document: vscode.TextDocument): Promise<string> {
	const text = formatted(document.getText());
	const run = root && document.uri.scheme === 'file' && await withTemporaryCopy(document.fileName, [], (copy) => {
		fs.writeFileSync(copy, text);
		return runStrict(root, ['format', copy]);
	}).catch(() => undefined);
	return (run && run.exitCode === 0 && printed(run.output, text)) || text;
}

function formatEdits(document: vscode.TextDocument, text: string): vscode.TextEdit[] {
	return text === document.getText() ? []
		: [vscode.TextEdit.replace(document.validateRange(new vscode.Range(0, 0, document.lineCount, 0)), text)];
}

/** A created method or type is shown afterwards, createFile fails instead of overwriting an existing file. */
function codeAction(document: vscode.TextDocument, refactoring: Refactoring & { diagnostic?: vscode.Diagnostic }):
	vscode.CodeAction {
	const action = new vscode.CodeAction(refactoring.title, vscode.CodeActionKind[refactoring.kind]);
	const uri = (file?: string) => file === undefined || file === document.fileName ? document.uri : vscode.Uri.file(file);
	action.edit = new vscode.WorkspaceEdit();
	if (refactoring.newFile) {
		action.edit.createFile(uri(refactoring.newFile));
	}
	for (const edit of refactoring.edits) {
		action.edit.replace(uri(edit.file), new vscode.Range(edit.line, edit.character, edit.endLine ?? edit.line,
			edit.endCharacter ?? edit.character), edit.text);
	}
	if (refactoring.diagnostic) {
		const [created] = refactoring.edits;
		const line = created.line + (created.text.startsWith('\n') ? 1 : 0);
		action.diagnostics = [refactoring.diagnostic];
		action.command = { title: refactoring.title, command: 'vscode.open',
			arguments: [uri(created.file), { selection: new vscode.Range(line, 0, line, 0) }] };
	}
	return action;
}

/** The open document of file, else the file, empty when it is gone (the created edit then fails instead of all actions). */
