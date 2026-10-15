import {
	CodeAction,
	CodeActionKind,
	CodeActionProvider,
	Diagnostic,
	Disposable,
	languages,
	Position,
	Range,
	TextDocument,
	WorkspaceEdit
} from 'vscode';
import { diagnosticCode } from './diagnostics';
import { Fix, issueTarget, ruleFix, safeFixes, typeFixes } from './fixes';
import { strictDocumentSelector } from './paths';
import { StrictType } from './strictIndex';

const fixAll = CodeActionKind.SourceFixAll.append('strict');

export const strictCodeActionProvider: CodeActionProvider = {
	provideCodeActions(document, _range, context) {
		if (document.languageId !== 'strict') {
			return [];
		}
		if (context.only && fixAll.intersects(context.only)) {
			return fixAllActions(document);
		}
		const lines = context.diagnostics.length > 0 ? document.getText().split(/\r?\n/) : [];
		return context.diagnostics.flatMap((diagnostic) => {
			const rule = diagnosticCode(diagnostic);
			const fix = rule && ruleFix(rule, lines, diagnostic.range.start.line, issueTarget(diagnostic.message));
			return fix ? [toAction(document, fix, diagnostic)] : [];
		});
	}
};

/** Fix All (`source.fixAll.strict`, e.g. in editor.codeActionsOnSave): the safe fixes of every issue in the document. */
function fixAllActions(document: TextDocument): CodeAction[] {
	const issues = languages.getDiagnostics(document.uri).flatMap((diagnostic) => {
		const rule = diagnosticCode(diagnostic);
		return rule ? [{ rule, line: diagnostic.range.start.line, target: issueTarget(diagnostic.message) }] : [];
	});
	const edits = safeFixes(document.getText().split(/\r?\n/), issues);
	return edits.length > 0 ? [toAction(document, { title: 'Fix all safe Strict issues', edits }, undefined, fixAll)] : [];
}

function toAction(document: TextDocument, fix: Fix, diagnostic: Diagnostic | undefined, kind = CodeActionKind.QuickFix,
	isPreferred = true): CodeAction {
	const action = new CodeAction(fix.title, kind);
	const edit = new WorkspaceEdit();
	for (const change of fix.edits) {
		edit.replace(document.uri, new Range(...change.range), change.text);
	}
	action.edit = edit;
	action.diagnostics = diagnostic && [diagnostic];
	action.isPreferred = isPreferred;
	action.command = fix.rename && { command: 'editor.action.rename', title: fix.title,
		arguments: [[document.uri, new Position(...fix.rename)]] };
	return action;
}

/** Quick fixes for the rules `strict check` reports and Fix All, naming fixes start the rename of navigation.ts. */
export function registerCodeActionProvider(): Disposable {
	return languages.registerCodeActionsProvider(strictDocumentSelector, strictCodeActionProvider, {
		providedCodeActionKinds: [CodeActionKind.QuickFix, fixAll]
	});
}

/** Did you mean for names Strict did not find and the call of a method `strict check` reports as copied, both need all
 * types: index gives the parsed document and every type of the workspace and the Strict folder. */
export function registerTypeFixes(index: (document: TextDocument) => { own: StrictType; types: StrictType[] }): Disposable {
	return languages.registerCodeActionsProvider(strictDocumentSelector, {
		provideCodeActions(document, _range, context) {
			const lines = context.diagnostics.length > 0 ? document.getText().split(/\r?\n/) : [];
			let types: ReturnType<typeof index> | undefined;
			return context.diagnostics.flatMap((diagnostic) => typeFixes(diagnostic.message, diagnosticCode(diagnostic), lines,
				diagnostic.range.start.line, () => types ??= index(document)).map((fix, at) =>
				toAction(document, fix, diagnostic, CodeActionKind.QuickFix, at === 0)));
		}
	}, { providedCodeActionKinds: [CodeActionKind.QuickFix] });
}
