import * as vscode from 'vscode';
import { inlayHints, semanticTokens, tokenModifiers, tokenTypes } from './insightModel';
import { strictDocumentSelector } from './paths';
import { StrictType } from './strictIndex';

const legend = new vscode.SemanticTokensLegend(tokenTypes, tokenModifiers);

/** Inlay hints and semantic highlighting from the types StrictLanguage parsed for a document. */
export function registerInsight(typesOf: (document: vscode.TextDocument) => { own: StrictType; types: StrictType[] },
	root: () => string | undefined): vscode.Disposable[] {
	return [
		vscode.languages.registerInlayHintsProvider(strictDocumentSelector, {
			provideInlayHints: (document, range) => {
				const { own, types } = typesOf(document);
				return inlayHints(document.getText().split(/\r?\n/), own, types, range.start.line, range.end.line).map((hint) =>
					Object.assign(new vscode.InlayHint(new vscode.Position(hint.line, hint.character), hint.label, hint.parameter
						? vscode.InlayHintKind.Parameter : vscode.InlayHintKind.Type), { paddingRight: hint.parameter }));
			}
		}),
		vscode.languages.registerDocumentSemanticTokensProvider(strictDocumentSelector, {
			provideDocumentSemanticTokens: (document) => {
				const { own, types } = typesOf(document);
				const builder = new vscode.SemanticTokensBuilder(legend);
				semanticTokens(document.getText().split(/\r?\n/), own, types, root()).forEach((token) => builder.push(
					new vscode.Range(token.line, token.character, token.line, token.character + token.length), token.type,
					token.modifiers));
				return builder.build();
			}
		}, legend)
	];
}
