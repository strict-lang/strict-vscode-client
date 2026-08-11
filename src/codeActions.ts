import {
	CodeAction,
	CodeActionKind,
	CodeActionProvider,
	Diagnostic,
	languages,
	Range,
	TextDocument,
	WorkspaceEdit
} from 'vscode';
import { diagnosticCode } from './diagnostics';

export const strictCodeActionProvider: CodeActionProvider = {
	provideCodeActions(document, _range, context) {
		if (document.languageId !== 'strict') {
			return [];
		}
		const actions: CodeAction[] = [];
		for (const diagnostic of context.diagnostics) {
			const fix = createFix(document, diagnostic);
			if (fix) {
				actions.push(fix);
			}
		}
		return actions;
	}
};

export function createFix(document: TextDocument, diagnostic: Diagnostic): CodeAction | undefined {
	const code = diagnosticCode(diagnostic);
	if (!code) {
		return undefined;
	}
	switch (code) {
		case 'EmptyLineIsNotAllowed':
			return deleteLineAction(document, diagnostic, 'Remove empty line');
		case 'ExtraWhitespacesFoundAtEndOfLine':
			return trimEndAction(document, diagnostic);
		case 'ExtraWhitespacesFoundAtBeginningOfLine':
			return fixLeadingWhitespaceAction(document, diagnostic);
		default:
			return undefined;
	}
}

function deleteLineAction(
	document: TextDocument,
	diagnostic: Diagnostic,
	title: string
): CodeAction | undefined {
	const line = diagnostic.range.start.line;
	if (line < 0 || line >= document.lineCount) {
		return undefined;
	}
	const edit = new WorkspaceEdit();
	if (line + 1 < document.lineCount) {
		edit.delete(document.uri, new Range(line, 0, line + 1, 0));
	} else if (line > 0) {
		const previous = document.lineAt(line - 1);
		const current = document.lineAt(line);
		edit.delete(
			document.uri,
			new Range(line - 1, previous.text.length, line, current.text.length)
		);
	} else {
		edit.delete(document.uri, document.lineAt(line).range);
	}
	const action = new CodeAction(title, CodeActionKind.QuickFix);
	action.diagnostics = [diagnostic];
	action.isPreferred = true;
	action.edit = edit;
	return action;
}

function trimEndAction(document: TextDocument, diagnostic: Diagnostic): CodeAction | undefined {
	const line = diagnostic.range.start.line;
	if (line < 0 || line >= document.lineCount) {
		return undefined;
	}
	const text = document.lineAt(line).text;
	const trimmed = text.trimEnd();
	if (trimmed.length === text.length) {
		return undefined;
	}
	const edit = new WorkspaceEdit();
	edit.replace(document.uri, new Range(line, 0, line, text.length), trimmed);
	const action = new CodeAction('Remove trailing whitespace', CodeActionKind.QuickFix);
	action.diagnostics = [diagnostic];
	action.isPreferred = true;
	action.edit = edit;
	return action;
}

function fixLeadingWhitespaceAction(
	document: TextDocument,
	diagnostic: Diagnostic
): CodeAction | undefined {
	const line = diagnostic.range.start.line;
	if (line < 0 || line >= document.lineCount) {
		return undefined;
	}
	const text = document.lineAt(line).text;
	let index = 0;
	let tabCount = 0;
	while (index < text.length && (text[index] === '\t' || text[index] === ' ')) {
		if (text[index] === '\t') {
			tabCount++;
			index++;
			continue;
		}
		let spaces = 0;
		while (index < text.length && text[index] === ' ') {
			spaces++;
			index++;
		}
		tabCount += Math.max(1, Math.floor(spaces / 4));
	}
	const fixed = '\t'.repeat(tabCount) + text.slice(index).trimEnd();
	if (fixed === text) {
		return undefined;
	}
	const edit = new WorkspaceEdit();
	edit.replace(document.uri, new Range(line, 0, line, text.length), fixed);
	const action = new CodeAction('Fix leading whitespace (use tabs)', CodeActionKind.QuickFix);
	action.diagnostics = [diagnostic];
	action.isPreferred = true;
	action.edit = edit;
	return action;
}

export function registerCodeActionProvider(): ReturnType<typeof languages.registerCodeActionsProvider> {
	return languages.registerCodeActionsProvider({ language: 'strict' }, strictCodeActionProvider, {
		providedCodeActionKinds: [CodeActionKind.QuickFix]
	});
}
